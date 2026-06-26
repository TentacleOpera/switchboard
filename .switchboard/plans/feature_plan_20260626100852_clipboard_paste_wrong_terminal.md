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

### Call-Graph Verification (added during plan improvement)

Tracing all callers of `pasteTextViaClipboard` in the codebase:

1. **`TaskViewerProvider.ts` line 15564** — `pasteTextViaClipboard(terminal, '/clear')`
   inside `_attemptDirectTerminalPush`, wrapped by `withTerminalSendLock`. This is
   the **primary bug site** — the `clearBeforePrompt` path for kanban dispatches.
   Always single-target. The caller has a try/catch (lines 15570-15574) that skips
   the clear on failure and proceeds directly to `sendRobustText` for the prompt.

2. **`terminalUtils.ts` line 114** — inside `sendRobustText`, for payloads > 100 chars.
   The caller has a try/catch (lines 121-123) that falls back to chunked `sendText`.
   All current callers of `sendRobustText` with large payloads are single-target
   dispatches (kanban prompts, analyst messages, review comments, planning panel
   prompts).

**Broadcast paths do NOT call `pasteTextViaClipboard`:**
- Webview `sendToTerminal` with `allowBroadcast: true` (implementation.html line 1727)
  sends `input: '/clear'` (6 chars) → `sendRobustText(terminal, '/clear', false)` →
  `terminal.sendText()` directly (6 < 100-char threshold). No clipboard paste involved.
- `extension.ts` line 2262 `clearAllTerminals` command also sends `/clear` via
  `sendRobustText` with the same small-payload path.
- The backend `sendToTerminal` handler (TaskViewerProvider.ts line 9891) intentionally
  ignores the `allowBroadcast` field (per comment at lines 9892-9894).

**Conclusion:** The broadcast path is unaffected by this bug and unaffected by the
fix. The original plan's "Change 2" (passing `acquireFocus: false` to the broadcast
path) was based on a false premise and has been removed.

## Metadata
**Tags:** bugfix, cli, reliability
**Complexity:** 6

## User Review Required
Yes — the fix changes UX behavior for all single-target dispatches: `show(true)`
will steal focus to the target terminal on every `/clear` + prompt dispatch.
Previously `show(false)` preserved the user's current focus. This is the correct
trade-off (the bug exists because the terminal wasn't focused), but users who
rely on focus preservation during background dispatches should be aware. The
broadcast `/clear` path is unaffected (it never uses clipboard paste).

## Complexity Audit

### Routine
- Locate `pasteTextViaClipboard` in `src/services/terminalUtils.ts` (lines 51-67).
- Add `acquireFocus` option parameter (default `true`).
- Add `acquireFocus` pass-through parameter to `sendRobustText` (line 93-97, passed
  to `pasteTextViaClipboard` at line 114).
- Make the call at `TaskViewerProvider.ts` line 15564 explicit with
  `{ acquireFocus: true }`.

### Complex / Risky
- **No per-terminal paste API in VS Code.** `workbench.action.terminal.paste` is
  global and always targets the active terminal. There is no `terminal.paste(text)`
  API. The fix must guarantee the target terminal is the active terminal at the
  exact moment the paste command runs, and that no focus stealing occurs in the
  ~1ms between verification and paste.
- **Clipboard lock serialization.** `_clipboardLock` serializes clipboard pastes
  across terminals (intentional, prevents corruption). The focus-verification
  guard runs *inside* the lock so a second terminal's `show(true)` cannot steal
  focus between verify and paste of the first.
- **Focus-acquire failure handling.** If focus cannot be acquired after retries,
  the function must THROW (not fall back to `sendText`). Rationale: for the `/clear`
  path, `sendText('/clear')` reintroduces the slash-command concatenation bug that
  `pasteTextViaClipboard` was created to prevent. Both callers already have
  try/catch handlers that degrade gracefully: the `_attemptDirectTerminalPush`
  caller skips the clear and proceeds to the prompt; the `sendRobustText` caller
  falls back to chunked `sendText` (safe for large prompts, just not for `/clear`).
- **Race between verify and paste.** Even with `show(true)` + an
  `activeTerminal === terminal` check, the user could click another terminal in
  the ~1ms between the check and `executeCommand`. This is an inherent VS Code
  API limitation. Mitigation: retry the `show(true)` + verify loop up to 3 times
  with a 20ms+30ms backoff before pasting. If all retries fail, throw.
- **`show(true)` focus stealing side effects.** Forcing focus to the target
  terminal on every `/clear` changes existing UX (currently `show(false)` keeps
  the user's current focus). This is acceptable for dispatch actions (the user
  expects the agent terminal to activate). The broadcast path is unaffected
  because it never calls `pasteTextViaClipboard`.

## Edge-Case & Dependency Audit

- **Broadcast clear (`allowBroadcast: true`):** Iterates all terminals sending
  `/clear` via `sendRobustText`. Since `/clear` is 6 chars (< 100-char threshold),
  it goes through `terminal.sendText()` directly — NOT through
  `pasteTextViaClipboard`. Broadcast is completely unaffected by this fix. No
  `acquireFocus` option needs to be passed.
- **No terminals open:** `pasteTextViaClipboard` is only reached after the caller
  resolves a `vscode.Terminal`. No null-terminal path exists here.
- **Headless / no terminal focus possible:** In rare CI-like contexts
  `activeTerminal` may be `undefined`. The verify loop treats
  `activeTerminal === undefined` as "not focused" and retries. After 3 failed
  retries, the function throws. Both callers handle the throw gracefully.
- **`sendRobustText` large-payload path:** Also calls `pasteTextViaClipboard`
  (line 114) for payloads > 100 chars. The fix benefits both the `/clear` path
  and large prompt delivery. `sendRobustText` must pass `acquireFocus` through.
  All current large-payload callers are single-target dispatches where
  `acquireFocus: true` is correct.
- **Clipboard restore:** The existing restore of `previousClipboard` happens
  after `POST_PASTE_SETTLE_MS`. The fix must not alter this timing. In the throw
  path (focus acquisition failure), clipboard must be restored before throwing.
- **Focus-acquire failure during `/clear`:** If `pasteTextViaClipboard` throws
  after failing to acquire focus, the caller at line 15570 catches it, logs the
  error, and proceeds to `sendRobustText(terminal, payload, paced)` without the
  preceding clear. The prompt is delivered without a `/clear` — a safe degradation
  (annoying but not corrupting).
- **Focus-acquire failure during large-prompt delivery:** If
  `pasteTextViaClipboard` throws inside `sendRobustText` (line 114), the catch at
  line 121-123 falls back to chunked `sendText`. This is safe for large prompts
  (no slash-command issue) but may hit PTY line-buffer truncation for very large
  payloads — the original trade-off that motivated the clipboard paste path.

## Dependencies
- None — this is a self-contained bugfix in `terminalUtils.ts` with minor
  pass-through changes in `TaskViewerProvider.ts`.

## Adversarial Synthesis
Key risks: (1) the original plan's `sendText` fallback for failed focus acquisition
would reintroduce the slash-command concatenation bug for `/clear` — corrected to
throw instead, since both callers already handle the throw gracefully; (2) the
original plan's "Change 2" targeted a broadcast path that never calls
`pasteTextViaClipboard` — removed as factually incorrect; (3) `sendRobustText` was
not updated to pass `acquireFocus` through to `pasteTextViaClipboard` — added.
Mitigations: throw-on-failure degrades safely (skip clear, deliver prompt without
clear); broadcast path is unaffected; all large-payload callers are single-target
where `acquireFocus: true` is correct.

## Proposed Changes

### File: `src/services/terminalUtils.ts`

**Change 1 — Focus the target terminal, verify, and throw on failure.**

Replace the body of `pasteTextViaClipboard` (lines 51-67) with a focus-acquire +
verify loop that throws on failure (not falls back to `sendText`):

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
                // Could not acquire focus. THROW rather than fall back to sendText —
                // sendText('/clear') reintroduces the slash-command concatenation bug
                // that pasteTextViaClipboard exists to prevent. Both callers have
                // try/catch handlers that degrade gracefully:
                //   - _attemptDirectTerminalPush: skips clear, proceeds to prompt
                //   - sendRobustText: falls back to chunked sendText (safe for prompts)
                try { await vscode.env.clipboard.writeText(previousClipboard); } catch { /* ignore */ }
                throw new Error(`pasteTextViaClipboard: could not acquire focus on terminal '${terminal.name}' after 3 attempts`);
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

**Change 2 — Pass `acquireFocus` through from `sendRobustText`.**

Update `sendRobustText` (line 93) to accept and forward the `acquireFocus` option:

```typescript
export async function sendRobustText(
    terminal: vscode.Terminal,
    text: string,
    paced: boolean = true,
    log?: (msg: string) => void,
    options?: { acquireFocus?: boolean }
): Promise<void> {
```

At line 114, pass the option through:

```typescript
    if (text.length > CLIPBOARD_PASTE_THRESHOLD) {
        _log(`Large payload (${text.length} chars) for '${terminal.name}', using clipboard paste delivery.`);
        try {
            await pasteTextViaClipboard(terminal, text, options);
```

All current callers of `sendRobustText` with large payloads are single-target
dispatches where the default `acquireFocus: true` is correct. No caller needs to
pass `acquireFocus: false` today, but the pass-through ensures correctness if a
background large-payload path is added in the future.

### File: `src/services/TaskViewerProvider.ts`

**Change 3 — Explicit `acquireFocus: true` at the clear-before-prompt call site.**

At line 15564, the clear-before-prompt call:
```typescript
await pasteTextViaClipboard(terminal, '/clear');
```
becomes (default behavior, explicit for clarity):
```typescript
await pasteTextViaClipboard(terminal, '/clear', { acquireFocus: true });
```

The existing try/catch at lines 15570-15574 already handles the throw correctly —
it logs the error and proceeds to `sendRobustText` without the clear. No change
needed to the catch block.

**No change needed for the broadcast path.** The broadcast `/clear` goes through
`sendRobustText(terminal, '/clear', false)` at line 9939, which uses `sendText`
directly (6 chars < 100-char threshold). It never calls `pasteTextViaClipboard`.
The original plan's "Change 2" (passing `acquireFocus: false` for broadcast) has
been removed as factually incorrect.

## Verification Plan

### Automated Tests
(Skipped per session directive — test suite will be run separately by the user.)

### Manual Verification
1. **Repro the original bug first** (on current build): open two agent terminals,
   trigger a kanban move dispatch, and click the *other* terminal during the
   2000ms clear delay. Confirm the prompt pastes into the wrong terminal.
2. **Apply the fix** (source changes only — no compilation step per session
   directive; VSIX build will be done separately).
3. **Repeat the repro**: trigger a dispatch, switch terminals during the clear
   delay. Confirm the prompt lands in the intended target terminal.
4. **Broadcast clear test**: trigger a broadcast `/clear` to all terminals (via
   the CLEAR TERMINALS button). Confirm focus is NOT stolen (user's current focus
   remains) — the broadcast path uses `sendText`, not clipboard paste, so it is
   unaffected by the fix.
5. **Focus-acquire failure test**: simulate a terminal that cannot be focused
   (e.g. quickly close it mid-dispatch). Confirm the throw fires, the caller
   catches it, skips the clear, and proceeds to deliver the prompt without clear.
   Confirm NO `sendText('/clear')` fallback fires (which would reintroduce the
   slash-command bug).
6. **Clipboard integrity test**: confirm the previous clipboard contents are
   restored after both the success path and the throw path (focus acquisition
   failure).
7. **Large-payload dispatch test**: trigger a dispatch with a prompt > 100 chars.
   Confirm the prompt lands in the correct terminal via the
   `sendRobustText` → `pasteTextViaClipboard` path with focus acquisition.

---

**Recommendation: Send to Coder** (Complexity 6 — multi-file change with moderate
logic: focus-acquire retry loop, throw-on-failure error handling, pass-through
parameter threading. No new architectural patterns, but the error-handling
trade-off requires care to avoid reintroducing the slash-command bug.)
