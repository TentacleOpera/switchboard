# Bug: Clipboard Paste Targets Wrong Terminal During Send-to-Terminal Actions

## Goal

### Problem
When a send-to-terminal action with a `clearBeforePrompt` sequence is in flight
(e.g. a kanban move / dispatch), the `/clear` and the subsequent prompt paste are
delivered via the **clipboard paste** path. If the user switches which terminal is
focused between the `/clear` paste and the prompt paste, the prompt paste lands in
the newly-focused terminal instead of the intended target terminal.

### Background
The Switchboard extension dispatches prompts to CLI agents (Claude, Copilot, Gemini,
etc.) using a clipboard-paste delivery path. The reason clipboard paste is used
instead of `terminal.sendText()` is documented in the source: `sendText('/clear')`
triggers slash-command interpretation in CLI agents, causing the subsequent prompt
to concatenate with the `/clear` input. Clipboard paste uses a different input path
that avoids this.

The dispatch sequence (per terminal) is:
1. `pasteTextViaClipboard(terminal, '/clear')` — paste `/clear` via clipboard
2. `terminal.sendText('', true)` — submit the `/clear`
3. Wait `clearDelay` ms (default 2000ms) for the CLI to process the clear
4. `sendRobustText(terminal, payload, paced)` — deliver the actual prompt

### Root Cause
`pasteTextViaClipboard` in `src/services/terminalUtils.ts` (lines 51-67) uses the
**global** VS Code command `workbench.action.terminal.paste` to perform the paste.
This command pastes into **whichever terminal currently has focus**, NOT into the
captured `terminal` reference passed to the function:

```typescript
export async function pasteTextViaClipboard(
    terminal: vscode.Terminal,
    text: string
): Promise<void> {
    await withClipboardLock(async () => {
        let previousClipboard = '';
        try { previousClipboard = await vscode.env.clipboard.readText(); } catch { /* ignore */ }
        await vscode.env.clipboard.writeText(text);
        terminal.show(false);                                    // show(false) = do NOT focus
        await new Promise(r => setTimeout(r, PRE_PASTE_SETTLE_MS)); // 200ms window
        await vscode.commands.executeCommand('workbench.action.terminal.paste'); // pastes to ACTIVE terminal
        await new Promise(r => setTimeout(r, POST_PASTE_SETTLE_MS)); // 800ms window
        try { await vscode.env.clipboard.writeText(previousClipboard); } catch { /* ignore */ }
    });
}
```

Two compounding defects:
1. `terminal.show(false)` is called with `preserveFocus=true`, which means the
   terminal is revealed but **not focused**. The paste command then targets
   whatever terminal was already focused.
2. Even if `show(true)` were used, there is a 200ms settle window before the paste
   and an 800ms window after. If the user clicks another terminal during either
   window, `workbench.action.terminal.paste` pastes into that terminal.

The same flaw affects `sendRobustText` (lines 110-124) which falls back to
`pasteTextViaClipboard` for payloads over 100 chars.

**Bug status: STILL PRESENT** (verified in source at
`src/services/terminalUtils.ts`).

## Metadata
**Tags:** bug, terminal, clipboard, dispatch, kanban
**Complexity:** 6
**Repo:** switchboard (source at `/Users/patrickvuleta/Documents/GitHub/switchboard`)

## Complexity Audit

### Routine
1. Locate `pasteTextViaClipboard` in `src/services/terminalUtils.ts`.
2. Change `terminal.show(false)` to `terminal.show(true)` to acquire focus.
3. Add a focus-verification guard before the paste command.

### Complex / Risky
1. **No per-terminal paste API in VS Code.** `workbench.action.terminal.paste` is
   global and always targets the active terminal. There is no
   `terminal.paste(text)` API. The fix must therefore guarantee the target
   terminal is the active terminal at the exact moment the paste command runs,
   and that no focus stealing occurs in the ~100ms between verification and paste.
2. **Clipboard lock serialization.** `_clipboardLock` serializes clipboard pastes
   across terminals (intentional, prevents corruption). The focus-verification
   guard must run *inside* the lock so a second terminal's `show(true)` cannot
   steal focus between verify and paste of the first.
3. **`show(true)` focus stealing side effects.** Forcing focus to the target
   terminal on every `/clear` changes existing UX (currently `show(false)` keeps
   the user's current focus). This is acceptable for dispatch actions (the user
   expects the agent terminal to activate), but must not fire for background
   `/clear` broadcasts. The broadcast path (`allowBroadcast: true`) should be
   excluded from the focus-acquire fix.
4. **Race between verify and paste.** Even with `show(true)` + an
   `activeTerminal === terminal` check, the user could click another terminal in
   the ~1ms between the check and `executeCommand`. This is an inherent VS Code
   API limitation. Mitigation: retry the `show(true)` + verify loop up to 3 times
   with a 10ms backoff before pasting.

## Edge-Case & Dependency Audit

- **Broadcast clear (`allowBroadcast: true`):** Iterates all terminals sending
  `/clear`. Forcing focus per-terminal would thrash the user's focus. Broadcast
  must keep `show(false)` and accept that broadcast clears are best-effort.
- **No terminals open:** `pasteTextViaClipboard` is only reached after the caller
  resolves a `vscode.Terminal`. No null-terminal path exists here.
- **Headless / no terminal focus possible:** In rare CI-like contexts
  `activeTerminal` may be `undefined`. The verify loop must treat
  `activeTerminal === undefined` as "not focused" and retry.
- **`sendRobustText` large-payload path:** Also calls `pasteTextViaClipboard`.
  The fix benefits both the `/clear` path and large prompt delivery.
- **Clipboard restore:** The existing restore of `previousClipboard` happens
  after `POST_PASTE_SETTLE_MS`. The fix must not alter this timing.

## Proposed Changes

### File: `src/services/terminalUtils.ts`

**Change 1 — Focus the target terminal and verify before pasting.**

Replace the body of `pasteTextViaClipboard` (lines 51-67) with a focus-acquire +
verify loop:

```typescript
export async function pasteTextViaClipboard(
    terminal: vscode.Terminal,
    text: string,
    options?: { acquireFocus?: boolean }
): Promise<void> {
    const acquireFocus = options?.acquireFocus !== false; // default true
    await withClipboardLock(async () => {
        let previousClipboard = '';
        try { previousClipboard = await vscode.env.clipboard.readText(); } catch { /* ignore */ }
        await vscode.env.clipboard.writeText(text);

        if (acquireFocus) {
            // workbench.action.terminal.paste targets the ACTIVE terminal, not the
            // captured reference. Force-focus the target and verify before pasting.
            // Retry loop covers the brief window where another terminal could steal focus.
            for (let attempt = 0; attempt < 3; attempt++) {
                terminal.show(true);
                await new Promise(r => setTimeout(r, 20));
                if (vscode.window.activeTerminal === terminal) { break; }
                await new Promise(r => setTimeout(r, 30));
            }
            if (vscode.window.activeTerminal !== terminal) {
                // Could not acquire focus — fall back to sendText to avoid pasting
                // into the wrong terminal. sendText targets the captured reference.
                terminal.sendText(text, false);
                try { await vscode.env.clipboard.writeText(previousClipboard); } catch { /* ignore */ }
                return;
            }
            await new Promise(r => setTimeout(r, PRE_PASTE_SETTLE_MS));
        } else {
            terminal.show(false);
            await new Promise(r => setTimeout(r, PRE_PASTE_SETTLE_MS));
        }

        await vscode.commands.executeCommand('workbench.action.terminal.paste');
        await new Promise(r => setTimeout(r, POST_PASTE_SETTLE_MS));
        try { await vscode.env.clipboard.writeText(previousClipboard); } catch { /* ignore */ }
    });
}
```

**Change 2 — Broadcast path keeps `acquireFocus: false`.**

In `src/services/TaskViewerProvider.ts`, the broadcast clear loop (around line 1723
in `implementation.html` → `sendToTerminal` with `allowBroadcast: true`) must pass
`acquireFocus: false` when it reaches `pasteTextViaClipboard`. Audit the broadcast
dispatch path in `TaskViewerProvider` and pass the option through. The default
(`acquireFocus: true`) applies to all single-target dispatches, which is the
desired behavior for kanban moves and agent dispatches.

### File: `src/services/TaskViewerProvider.ts`

**Change 3 — Pass `acquireFocus` through the clear-before-prompt path.**

At line 15564, the clear-before-prompt call:
```typescript
await pasteTextViaClipboard(terminal, '/clear');
```
becomes (default behavior, explicit for clarity):
```typescript
await pasteTextViaClipboard(terminal, '/clear', { acquireFocus: true });
```

For the broadcast path (if `pasteTextViaClipboard` is used for broadcast clears),
pass `{ acquireFocus: false }`.

## Verification Plan

1. **Repro the original bug first** (on current build): open two agent terminals,
   trigger a kanban move dispatch, and click the *other* terminal during the
   2000ms clear delay. Confirm the prompt pastes into the wrong terminal.
2. **Apply the fix** and rebuild the VSIX (`npm run compile` + package).
3. **Repeat the repro**: trigger a dispatch, switch terminals during the clear
   delay. Confirm the prompt lands in the intended target terminal.
4. **Broadcast clear test**: trigger a broadcast `/clear` to all terminals.
   Confirm focus is NOT stolen (user's current focus remains).
5. **Focus-acquire fallback test**: simulate a terminal that cannot be focused
   (e.g. quickly close it mid-dispatch). Confirm the `sendText` fallback fires
   instead of pasting into the wrong terminal.
6. **Clipboard integrity test**: confirm the previous clipboard contents are
   restored after both the fixed and broadcast paths.
