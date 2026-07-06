# Comms Monitor: Reduce Delay Between Prompt Paste and Enter Submission

## Goal

The Comms Monitor sends prompts to the Claude terminal via clipboard paste, but there is too much delay between pasting the prompt text and pressing Enter to submit it. This creates a ~1.8 second window where the user's typing can interleave with the pasted content, corrupting the prompt. The paste-to-Enter gap should be nearly instant (under 200ms) to minimize the interruption window.

### Problem Analysis & Root Cause

**Symptom:** When the Comms Monitor sends a prompt to the terminal, the prompt text is pasted via clipboard, then there is a noticeable delay (~1.8 seconds) before Enter is pressed. During this window, if the user is typing in the terminal, their keystrokes interleave with the pasted prompt text, corrupting it.

**Root cause (confirmed by code reading):** The `sendRobustText` function in `src/services/terminalUtils.ts` (line ~118) uses clipboard paste for payloads over 100 chars (the comms monitor prompt is typically 200+ chars). The paste-to-Enter sequence has multiple delay points:

1. **`pasteTextViaClipboard`** (line ~51):
   - `PRE_PASTE_SETTLE_MS = 200ms` (line 44) — delay before paste (acceptable, ensures focus)
   - `POST_PASTE_SETTLE_MS = 800ms` (line 45) — delay after paste, before returning ← **too long**

2. **After `pasteTextViaClipboard` returns**, `sendRobustText` adds:
   - `NEWLINE_DELAY = 1000ms` (paced=true, line 127) — delay before sending Enter ← **too long**
   - `terminal.sendText('', true)` — sends Enter

3. **For CLI agents** (Claude is detected as CLI via regex at line 129), an additional:
   - `CLI_CONFIRM_ENTER_DELAY = 350ms` (paced=true, line 128) — delay before confirmation Enter
   - `terminal.sendText('', true)` — sends a second Enter

**Total paste-to-Enter gap:** `POST_PASTE_SETTLE_MS (800ms)` + `NEWLINE_DELAY (1000ms)` = **1800ms** before the first Enter. This is the window where user typing can corrupt the pasted prompt.

The `POST_PASTE_SETTLE_MS` exists to ensure the paste operation has fully completed before subsequent commands. The `NEWLINE_DELAY` exists to let the terminal process the pasted content before submission. Both are overly conservative for modern terminals and create an unnecessarily long vulnerability window.

## Metadata

- **Tags:** bugfix, ux, terminal, comms-monitor, timing
- **Complexity:** 3
- **Project:** switchboard
- **Repo:** (root — single-repo extension)
- **Files touched:** `src/services/terminalUtils.ts`

## Complexity Audit

### Routine
- Reducing timing constants in `terminalUtils.ts`.
- The paste and Enter sequence is already well-tested; reducing delays doesn't change the logic, only the timing.

### Complex / Risky
- **Regression risk for card-driven dispatch:** The same `sendRobustText` function is used by card-driven dispatch (`_attemptDirectTerminalPush`), not just the comms monitor. Reducing delays globally could affect dispatch reliability. However, the delays were chosen conservatively and modern terminals (VS Code's xterm.js) process paste operations near-instantly.
- **CLI agent double-Enter:** The confirmation Enter for CLI agents (Claude, Copilot, etc.) exists because some CLI agents require a second Enter to confirm multi-line input. Reducing this delay should be safe as long as the first Enter has been processed.

## Edge-Case & Dependency Audit

### Race Conditions
- The clipboard mutex (`withClipboardLock`) serializes all paste operations, so two concurrent pastes cannot interleave. Reducing delays doesn't affect this.
- The per-terminal send lock (`withTerminalSendLock`) serializes the full `/clear + prompt` sequence per terminal. Reducing delays makes the lock hold time shorter, which is strictly better.

### Edge Cases
- Very large prompts (1000+ chars): The paste is a single clipboard operation, so size doesn't affect the paste-to-Enter gap. The chunking path (for <100 chars) uses `sendText` directly and has its own `NEWLINE_DELAY`.
- Slow terminals: On very slow machines or remote connections, the terminal might not have processed the paste by the time Enter is sent. The `POST_PASTE_SETTLE_MS` protects against this. Reducing it too far (below 50ms) risks Enter arriving before the paste is rendered.

### Dependencies
- `sendRobustText` is used by both the comms monitor tick and card-driven dispatch. Changes affect both. This is desirable — both paths benefit from faster submission.
- The `paced` parameter: `paced=true` for cross-agent sends (slower), `paced=false` for self-sends (faster). The comms monitor always uses `paced=true`.

## Proposed Changes

### `src/services/terminalUtils.ts` — Reduce paste-to-Enter delays

**1. Reduce `POST_PASTE_SETTLE_MS`** (line 45):

```ts
const POST_PASTE_SETTLE_MS = 100; // was 800 — paste renders near-instantly in xterm.js
```

200ms was already sufficient for `PRE_PASTE_SETTLE_MS` (focus acquisition). The paste itself is a single VS Code command (`workbench.action.terminal.paste`) that completes synchronously from the terminal's perspective. 100ms is enough for the rendered text to appear in the PTY buffer.

**2. Reduce `NEWLINE_DELAY` for paced sends** (line 127):

```ts
const NEWLINE_DELAY = paced ? 300 : 100; // was 1000 / 100 — 300ms is enough for paste to settle
```

The original 1000ms was chosen to ensure the terminal has fully processed the pasted content. In practice, xterm.js processes pasted content within a few milliseconds. 300ms is a safe margin that reduces the paste-to-Enter gap from 1800ms to 400ms.

**3. Reduce `CLI_CONFIRM_ENTER_DELAY`** (line 128):

```ts
const CLI_CONFIRM_ENTER_DELAY = paced ? 150 : 100; // was 350 / 150 — 150ms is enough for first Enter to register
```

**Total paste-to-Enter gap after fix:** `POST_PASTE_SETTLE_MS (100ms)` + `NEWLINE_DELAY (300ms)` = **400ms** (down from 1800ms). This is a 4.5x reduction, making the window small enough that user typing interference is rare.

**4. Add a faster path option for comms monitor** (optional, if global reduction is too aggressive):

If reducing delays globally is deemed too risky for card-driven dispatch, add a `fast` option to `sendRobustText`:

```ts
export async function sendRobustText(
    terminal: vscode.Terminal,
    text: string,
    paced: boolean = true,
    log?: (msg: string) => void,
    options?: { acquireFocus?: boolean; fast?: boolean }
): Promise<void> {
    const fast = options?.fast ?? false;
    const NEWLINE_DELAY = fast ? 100 : (paced ? 300 : 100);
    const CLI_CONFIRM_ENTER_DELAY = fast ? 100 : (paced ? 150 : 100);
    // ...
}
```

Then in `_mcpMonitorTick` (TaskViewerProvider.ts ~20538):

```ts
await sendRobustText(terminal, prompt, true, undefined, { fast: true });
```

## Verification Plan

1. **Comms Monitor test:** Start the monitor, start polling, and watch the terminal when a prompt is sent. Measure the time between the prompt text appearing and Enter being pressed.
   - **Before fix:** ~1800ms gap.
   - **After fix:** ~400ms gap (or ~200ms with `fast` option).
2. **Typing interference test:** Start typing in the monitor terminal immediately after a prompt is pasted. Verify the prompt is submitted before significant typing can interfere.
3. **Card dispatch regression test:** Dispatch a plan card to an agent terminal. Verify the prompt is delivered correctly and the agent receives it without corruption.
4. **Large prompt test:** Send a 2000+ char prompt via the comms monitor. Verify the paste + Enter sequence completes correctly without truncation.
5. **CLI agent double-Enter test:** Verify Claude still receives and processes the prompt correctly with the reduced confirmation Enter delay. The prompt should appear as a single submission, not two separate ones.
6. **Slow machine test (if available):** On a slower machine or remote connection, verify the paste-to-Enter sequence still works reliably with the reduced delays. If issues arise, increase `POST_PASTE_SETTLE_MS` to 200ms.
