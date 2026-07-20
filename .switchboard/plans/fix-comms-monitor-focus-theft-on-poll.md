# Fix Comms Monitor Poll Stealing Keyboard Focus Into the Terminal

## Goal

Stop the Comms Monitor's background poll from stealing the user's keyboard focus. Today, when a poll tick fires, the user's in-progress typing (in an editor, the Kanban webview, anywhere) is suddenly redirected into the "Comms Monitor" VS Code: terminal's Claude CLI input line. This is disruptive and can corrupt whatever the user was writing.

### Core problem & root cause analysis

The focus theft is **not** in the webview. The COMMS config panel already guards against re-render focus loss via `isCommsPanelInteracting` (`src/webview/kanban.html`, `guardCommsInteraction`), which defers `renderCommsPanel()` while the user is interacting. That mechanism is working and is out of scope.

The real culprit is the **backend poll delivery path**:

1. Each poll tick, `_mcpMonitorTick()` sends the read-only monitor prompt to the terminal via `sendRobustText(terminal, prompt, true)` — `src/services/TaskViewerProvider.ts:22294`.
2. The monitor prompt is always longer than the `CLIPBOARD_PASTE_THRESHOLD` (100 chars), so `sendRobustText` routes through the **clipboard-paste delivery** path — `src/services/terminalUtils.ts:143`.
3. `pasteTextViaClipboard()` calls `terminal.show(...)` and then executes the global `workbench.action.terminal.paste` command — `src/services/terminalUtils.ts:94`. That command pastes into the *focused/active* terminal, so VS Code: **moves keyboard focus into the terminal** to perform the paste. The user's keystrokes now land in the Claude CLI.

The existing `options.acquireFocus` flag does **not** solve this: both branches of `pasteTextViaClipboard` (`acquireFocus` true *and* false) still call `terminal.show()` followed by the paste command, so clipboard delivery **always** takes focus. There is no VS Code: API to run `workbench.action.terminal.paste` against an unfocused terminal.

The only terminal-write path that does **not** reveal or focus the terminal is `terminal.sendText()` (writes directly to the terminal's stdin). Therefore the fix is to give the background poll a delivery mode that uses `sendText()` instead of clipboard paste.

### Key constraint discovered during analysis

> **Superseded:** The original analysis concluded that the background delivery mode must flatten newlines to spaces before sending, because the Comms Monitor terminal name (`"Comms Monitor"`, `src/services/TaskViewerProvider.ts:22196`) does not match `sendRobustText`'s `isCliAgent` regex (`/\b(copilot|gemini|agy|claude|windsurf|cursor|cortex)\b/i`, `src/services/terminalUtils.ts:135`).
> **Reason:** Web research confirmed that wrapping the payload in **Bracketed Paste Mode** ANSI escape sequences (`\x1b[200~` ... `\x1b[201~`) tells raw-mode TUIs such as prompt-toolkit/Claude CLI to treat the whole block as an atomic paste. This preserves newlines and formatting, prevents premature submission, and does not require flattening the prompt. The terminal-name mismatch only mattered for the old newline-flatten strategy.
> **Replaced with:** Use Bracketed Paste Mode for background sends; do not flatten newlines. The prompt returned by `_buildMcpMonitorPrompt` can be sent as-is.

## Metadata

- **Tags:** bugfix, ui, ux, reliability
- **Complexity:** 6

## User Review Required

- Approve switching the Comms Monitor poll (and optionally the auth check) to a non-focus-stealing `sendText` delivery path using Bracketed Paste Mode.
- Accept that the implementation adds a small per-terminal send queue and ANSI escape handling inside `sendRobustText`.
- Accept that verification must be manual and cannot be covered by automated tests in this session.
- Confirm that the previously-rejected headless `claude -p` alternative remains out of scope due to API-billing and MCP-connector constraints.

## Complexity Audit

> **Superseded:** The original plan scored this as **Complexity: 3** and proposed flattening newlines + 500-char `sendText` chunks; the first review pass raised this to **Complexity: 5**.
> **Reason:** Research confirmed that the safest non-focus-stealing delivery is Bracketed Paste Mode with 256-byte chunks, 30 ms pacing, and per-terminal send queueing. That adds ANSI escape-sequence handling, a serialization primitive, and platform/terminal support validation beyond the original chunking assumptions.
> **Replaced with:** **Complexity: 6** — same two-file footprint, but with a robust background-delivery path that must be validated on local, Remote-SSH, and WSL terminals.

### Routine

- Extend `sendRobustText`'s `options` with one new optional boolean flag (`background`).
- Add a private per-terminal background send queue in `src/services/terminalUtils.ts`.
- Change two call sites in `src/services/TaskViewerProvider.ts` to pass `{ background: true }`.
- No new dependencies, UI, config schema, or migrations.

### Complex / Risky

- Bracketed Paste Mode support is not universal; old shells or non-standard terminals may print the escape sequences as literal text and corrupt the prompt. This must be verified on the target terminal matrix.
- `terminal.sendText` is documented not to focus or reveal the terminal, but downstream focus hooks (other extensions, shell integration providers) may still react to terminal activity and shift focus.
- PTY/stdin buffer limits vary by OS (macOS `PIPE_BUF` ≈ 512, Linux ≈ 4096, Windows `conhost` long-line input ≈ 1568). The 256-byte chunk size is chosen to stay under these limits, but a total prompt that exceeds the Windows conhost single-line input buffer may still truncate even when chunked. This must be tested on Windows with a maximal prompt.
- Chunk pacing and queueing must not deadlock, reorder, or drop concurrent sends.
- A maximal monitor prompt (all sources + a long custom instruction) must be proven to arrive intact and produce correct `.switchboard/comms-monitor-latest.md` output.

## Edge-Case & Dependency Audit

### Race Conditions

- `_mcpMonitorTick` already serializes ticks via `this._mcpMonitorTickQueue` and guards against in-flight ticks with `this._mcpMonitorInFlight`.
- The new background path in `sendRobustText` adds a per-terminal send queue so concurrent background sends (e.g. a poll tick and an auth check arriving at the same terminal) cannot interleave `sendText` chunks. The queue is keyed by the `vscode.Terminal` instance.
- `sendRobustText` background mode bypasses `withClipboardLock` because it does not touch the clipboard. The internal queue provides the necessary serialization.
- The output-capture watcher (`_startMcpMonitorOutputCapture`) and the 90s fallback timer are unchanged by this delivery-path change; they still fire when `.switchboard/comms-monitor-latest.md` is written.
- Ensure the terminal shell is fully initialized before the first `sendText`. The `launchMcpMonitorTerminal` flow already waits for `onDidStartTerminalShellExecution` (with a 5s cap) before sending the startup command; `checkMcpMonitorAuth` and the first poll should only run after that.

### Security

- Background mode eliminates the clipboard overwrite/restore cycle in `pasteTextViaClipboard`, removing a class of clipboard-corruption/privacy side effects for monitor sends.
- The prompt content and trust model are unchanged; the monitor still sends read-only instructions to the user's own Claude CLI terminal.
- `workbench.action.terminal.paste` is no longer invoked for background monitor sends, reducing the surface where an unexpected focus change could cause pasted input to land in the wrong terminal.

### Side Effects

- The monitor terminal will no longer be revealed or focused on each poll tick.
- Because `terminal.sendText` writes silently to stdin, the user will not see the prompt being "typed" into the terminal unless the terminal panel is already visible. The COMMS tab's "Latest Results" area remains the primary UX surface for results.
- Bracketed Paste Mode preserves newlines, indentation, and formatting, so custom instructions that contain multi-line content or code blocks are delivered intact. This is a functional improvement over the original flatten-to-spaces idea.
- The 256-byte chunk size and 30 ms delay are conservative defaults based on the research findings (macOS `PIPE_BUF` 512, Remote-SSH jitter). If a platform still shows truncation, these constants can be tuned.

### Dependencies & Conflicts

- No other plan or feature depends on the current clipboard-paste focus-stealing behavior.
- `sendRobustText` is used by several dispatch paths (`TaskViewerProvider.ts:3761`, `3824`, `3946`, `12061`, `18081`, `18531`, `22818`; `extension.ts:2473`, `2757`). The `background` option is strictly opt-in, so all existing callers remain unaffected.
- The auth-check change is optional; if rejected, the poll fix still stands and only the "Check Auth" button will continue to steal focus.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) Bracketed Paste Mode is not supported by every terminal/shell, and unsupported terminals will print the escape sequences and corrupt the prompt; (2) OS-level stdin/console buffers (macOS `PIPE_BUF`, Windows `conhost` long-line limit) may still truncate a maximally-configured prompt even with 256-byte chunks; (3) downstream focus hooks or shell-integration providers may react to terminal activity and steal focus despite `sendText` not doing so itself; (4) the auth check and poll tick could have interleaved without a per-terminal queue, which the new design mitigates. Mitigations: keep the `background` flag strictly opt-in, send the Bracketed Paste start/end sequences as intact `sendText` calls, verify on local/Remote-SSH/WSL with a maximal prompt, and tune chunk size/delay if truncation is observed.

## Proposed Changes

### Approach

Use **Bracketed Paste Mode (BPM)** for background sends. BPM wraps the payload in ANSI escape sequences (`\x1b[200~` to start, `\x1b[201~` to end). Raw-mode TUIs — including the prompt-toolkit/Claude CLI running in the Comms Monitor terminal — interpret the wrapped block as a single paste, so:

- The prompt is delivered without ever calling `terminal.show()` or `workbench.action.terminal.paste`, eliminating focus theft.
- Newlines and formatting are preserved, so multi-line custom instructions and code blocks are not mangled.
- A single trailing Enter submits the paste.

To avoid PTY/stdin buffer saturation, the payload is chunked into 256-byte writes with a 30 ms delay, and a per-terminal queue serializes concurrent background sends. This is the approach recommended by the research findings.

#### Why not the alternatives

- **`acquireFocus: false` on the clipboard path** — rejected. Both branches of `pasteTextViaClipboard` still call `terminal.show()` and `workbench.action.terminal.paste`, which always forces focus to the active terminal.
- **Save-and-restore focus around the paste** — rejected. Fragile, causes visible flicker, and keystrokes in the brief focus window still land in the terminal.
- **Flatten newlines and use 500-char `sendText` chunks** — **superseded by research.** Flattening destroys multi-line formatting (code blocks, indented content) and does not protect against PTY buffer limits the way Bracketed Paste Mode does.
- **Re-architect the monitor to a headless `claude -p` invocation per poll** — **rejected (decided 2026-07-20).** Removes focus contention but accrues API billing and likely loses interactive MCP connectors. The interactive-terminal architecture is locked.

### `src/services/terminalUtils.ts`

Context: `sendRobustText` is the shared terminal-write utility. Long payloads currently route through `pasteTextViaClipboard`, which calls `terminal.show()` and `workbench.action.terminal.paste`. That command pastes into the *active* terminal and therefore moves keyboard focus into the terminal. The research confirmed that the safest non-focus-steeling alternative is `terminal.sendText` wrapped in Bracketed Paste Mode, chunked to avoid PTY buffer saturation, and queued to avoid interleaving.

Logic: Add a `background?: boolean` option to `sendRobustText`. When `background === true`, bypass the clipboard branch, queue the send behind any other background send to the same terminal, and deliver the payload inside Bracketed Paste Mode using 256-byte chunks with 30 ms pacing, followed by a single submit Enter.

Implementation:

1. Update the function signature:

   ```ts
   export async function sendRobustText(
       terminal: vscode.Terminal,
       text: string,
       paced: boolean = true,
       log?: (msg: string) => void,
       options?: { acquireFocus?: boolean; background?: boolean }
   ): Promise<void> { ... }
   ```

2. Add a per-terminal background-send queue at module scope. A `WeakMap` keyed by the `vscode.Terminal` instance is sufficient:

   ```ts
   const _backgroundSendQueues = new WeakMap<vscode.Terminal, Promise<void>>();
   ```

3. At the top of `sendRobustText`, branch for background mode before any other work:

   ```ts
   if (options?.background) {
       return _sendRobustTextBackground(terminal, text, log);
   }
   ```

4. Implement the background helper:

   ```ts
   async function _sendRobustTextBackground(
       terminal: vscode.Terminal,
       text: string,
       log?: (msg: string) => void
   ): Promise<void> {
       const _log = (msg: string) => { log?.(msg); console.log(`[sendRobustText background] ${msg}`); };
       const CHUNK_SIZE = 256;
       const CHUNK_DELAY_MS = 30;
       const SUBMIT_DELAY_MS = 100; // small settle before Enter

       const previous = _backgroundSendQueues.get(terminal) || Promise.resolve();
       const next = previous.then(async () => {
           _log(`Starting background send (${text.length} chars) to '${terminal.name}'`);

           // Begin Bracketed Paste Mode
           terminal.sendText('\x1b[200~', false);

           // Stream the payload in small chunks to avoid PTY/stdin saturation
           for (let i = 0; i < text.length; i += CHUNK_SIZE) {
               const chunk = text.substring(i, i + CHUNK_SIZE);
               terminal.sendText(chunk, false);
               if (i + CHUNK_SIZE < text.length) {
                   await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
               }
           }

           // End Bracketed Paste Mode
           terminal.sendText('\x1b[201~', false);

           // Wait briefly for the terminal to process the paste block, then submit
           await new Promise(r => setTimeout(r, SUBMIT_DELAY_MS));
           terminal.sendText('', true);

           _log(`Background send complete for '${terminal.name}'`);
       }).then(() => {}, () => {}); // swallow errors so the queue always advances

       _backgroundSendQueues.set(terminal, next);
       return next;
   }
   ```

5. Leave the existing `CLIPBOARD_PASTE_THRESHOLD` branch and `isCliAgent` handling untouched for non-background callers.

Edge cases:

- The Bracketed Paste start (`\x1b[200~`) and end (`\x1b[201~`) sequences are sent as separate, intact `sendText` calls so they are not split across chunk boundaries.
- If the payload contains the literal end sequence `\x1b[201~`, the paste would terminate early. This is not expected for user-authored monitor prompts; no special handling is added.
- If the target terminal does not support Bracketed Paste Mode, the escape sequences will be printed as text and the prompt will be corrupted. Verification must confirm support in the Comms Monitor terminal on each target platform.
- The queue uses a `WeakMap` keyed by the terminal object. If a terminal is disposed, the queue entry is garbage-collected.
- Background sends do not use `isCliAgent` flattening or double-Enter; BPM handles multi-line input and a single Enter submits.

### `src/services/TaskViewerProvider.ts`

Context: The monitor poll tick (`_mcpMonitorTick`) and the optional auth check (`checkMcpMonitorAuth`) are the only two Comms Monitor send sites. Both currently call `sendRobustText` without the `background` option, which forces long prompts down the clipboard-paste/focus-stealing path.

Logic: Pass `{ background: true }` as the fifth argument so the prompts are delivered via the new Bracketed Paste Mode path without focusing the terminal.

Implementation:

- `_mcpMonitorTick` at line 22294:

  ```ts
  await sendRobustText(terminal, prompt, true, undefined, { background: true });
  ```

- `checkMcpMonitorAuth` at line 22645 (optional but recommended for consistency):

  ```ts
  await sendRobustText(terminal, normalizeNewlines(prompt), true, undefined, { background: true });
  ```

Edge cases:

- If the auth-check change is not applied, only the poll is fixed; clicking "Check Auth" will still jump focus. The poll fix stands alone.
- The poll tick already serializes ticks through `_mcpMonitorTickQueue`. The background send queue inside `sendRobustText` additionally serializes the actual terminal writes, so an auth check cannot interleave chunks with a poll tick.
- No webview changes are required. The `isCommsPanelInteracting` guard in `src/webview/kanban.html` already handles config-panel re-render focus and is unrelated to this bug.

## Verification Plan

### Automated Tests

- Not applicable. Per session directives, compilation and automated tests are skipped. This bug is a VS Code: extension UI/terminal interaction that requires a live interactive terminal and human observation of focus behavior; it cannot be reliably asserted by the existing automated test suite.

### Manual Verification

1. **Reproduce first (baseline):** With the current code, start the Comms Monitor terminal, start polling, then type continuously in an editor and in the Kanban webview across a poll tick. Confirm keystrokes get captured by the terminal at the tick.
2. **After fix — focus:** Repeat the same typing test across several poll ticks (including the 2s first-prompt one-shot from `startMcpMonitorPolling`). Confirm keyboard focus **never** moves to the terminal and no keystrokes are lost.
3. **After fix — delivery integrity (maximal prompt):** Enable all sources (Slack + Gmail + Calendar) and add a long custom instruction that includes multi-line text and/or a code block. Confirm the terminal receives the **complete** prompt as a **single** submitted message, that the formatting is preserved, and that `.switchboard/comms-monitor-latest.md` is updated with normal results (no truncation, no line-by-line premature submits, no visible Bracketed Paste escape sequences in the output).
4. **Auth check (if step 3 change applied):** Click "Check Auth" while typing elsewhere; confirm no focus jump and the diagnostic prompt still runs.
5. **Regression:** Confirm normal dispatch flows that use `sendRobustText` without the `background` flag are unchanged (spot-check a plan dispatch to a coder terminal — it should still clipboard-paste and behave exactly as before).
6. **Output capture:** Confirm the file watcher and 90s fallback still post results to the COMMS tab after a poll.
7. **Platform/remote matrix (if possible):** Repeat steps 2–3 on Windows, macOS, Linux, and Remote-SSH/WSL to confirm Bracketed Paste Mode is supported and that maximal prompts are not truncated by OS-level console/PTY limits.

## Uncertain Assumptions

- The Comms Monitor terminal (a modern VS Code: integrated terminal running a Unix shell with the Claude CLI) supports Bracketed Paste Mode. Most modern terminals do, but this must be verified on the target platform matrix.
- On Windows, `conhost.exe` has a long single-line input buffer limit (~1568 characters). It is unknown whether 256-byte chunked writes combined with Bracketed Paste Mode fully bypass this limit for total prompts exceeding ~1568 characters. Verify with a maximal prompt on Windows.
- Downstream VS Code: focus hooks or shell-integration providers (other extensions, completion providers) may react to terminal activity and steal focus even though `terminal.sendText` itself does not focus the terminal. There is no in-plan mitigation for third-party focus hooks other than avoiding `terminal.show()` and paste commands.
- The monitor terminal shell is fully initialized before `sendText` is called. The `launchMcpMonitorTerminal` flow waits for `onDidStartTerminalShellExecution` before sending the startup command; auth checks and first polls must only run after that.
- The 256-byte chunk size and 30 ms delay are safe defaults for local, Remote-SSH, and WSL terminals. If truncation or premature submission is observed, these constants may need tuning per platform.

## Completion Report

Implemented the non-focus-stealing background delivery path for the Comms Monitor poll and auth check. Added a `background?: boolean` option to `sendRobustText` plus a per-terminal `WeakMap` send queue and a `_sendRobustTextBackground` helper that wraps the payload in Bracketed Paste Mode (`\x1b[200~` ... `\x1b[201~`), streams it in 256-byte chunks with 30 ms pacing, and submits with a single Enter — never calling `terminal.show()` or `workbench.action.terminal.paste`, so keyboard focus is preserved. Updated both call sites in `TaskViewerProvider.ts` (`_mcpMonitorTick` line 22294, `checkMcpMonitorAuth` line 22645) to pass `{ background: true }`. Files changed: `src/services/terminalUtils.ts`, `src/services/TaskViewerProvider.ts`. No issues encountered; per session directives, compilation and automated tests were skipped and verification is manual per the plan's Manual Verification section.

## Review Findings

Reviewed the implementation against the plan in-place. The two call sites (`TaskViewerProvider.ts:22294`, `22645`) and the `_sendRobustTextBackground` helper (`terminalUtils.ts:221`) match the plan; the `background` option is strictly opt-in and all other `sendRobustText` callers (9 sites) are untouched, so no regressions there. One MAJOR fix applied: the original queue returned the error-swallowing tail to callers, which silently advanced `sourceLastCheckAt` even when a send failed (e.g. terminal disposed mid-chunk), suppressing retries for a full interval. Fixed at `terminalUtils.ts:231-264` by separating the work promise (returned, propagates errors) from the tail (stored in the `WeakMap`, swallows errors) — queue liveness is preserved and `_enqueueMcpMonitorTick`'s existing catch at `TaskViewerProvider.ts:22249` regains failure visibility. Three NITs deferred: `CHUNK_SIZE=256` is UTF-16 code units not bytes (surrogate-pair split risk, benign for ASCII prompts); the raw-`prompt` vs `normalizeNewlines(prompt)` asymmetry between the two call sites; and a clarifying comment on the bare-Enter submit (added inline during the fix). Per session directives, compilation and automated tests were skipped; verification remains manual per the plan's Manual Verification section. Remaining risk: Bracketed Paste Mode support on non-modern shells/terminals still requires platform-matrix validation (Windows conhost long-line limit, Remote-SSH/WSL) as called out in the plan's Uncertain Assumptions.
