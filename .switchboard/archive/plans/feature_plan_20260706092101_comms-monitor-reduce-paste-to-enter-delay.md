# Comms Monitor: Reduce Delay Between Prompt Paste and Enter Submission

## Goal

The Comms Monitor sends prompts to the Claude terminal via clipboard paste, but there is too much delay between pasting the prompt text and pressing Enter to submit it. This creates a ~1.8 second window where the user's typing can interleave with the pasted content, corrupting the prompt. The paste-to-Enter gap should be nearly instant (under 200ms) to minimize the interruption window.

### Problem Analysis & Root Cause

**Symptom:** When the Comms Monitor sends a prompt to the terminal, the prompt text is pasted via clipboard, then there is a noticeable delay (~1.8 seconds) before Enter is pressed. During this window, if the user is typing in the terminal, their keystrokes interleave with the pasted prompt text, corrupting it.

**Root cause (confirmed by code reading):** The `sendRobustText` function in `src/services/terminalUtils.ts` (line 118) uses clipboard paste for payloads over 100 chars (the comms monitor prompt is typically 200+ chars). The paste-to-Enter sequence has multiple delay points:

1. **`pasteTextViaClipboard`** (line 51):
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

- **Tags:** bugfix, ux, performance
- **Complexity:** 5
- **Project:** switchboard
- **Files touched:** `src/services/terminalUtils.ts`

## User Review Required

**Yes — before merging.** This plan changes globally-shared timing constants in `sendRobustText`, which is called from 13 sites across 3 files (TaskViewerProvider.ts, PlanningPanelProvider.ts, extension.ts). The most sensitive caller is `_attemptDirectTerminalPush` (TaskViewerProvider.ts line 2908, paced=true), which handles card-driven dispatch to agent terminals. A global delay reduction that works for the comms monitor may cause Enter-before-paste-rendered failures on slower terminals used by card dispatch. The reviewer should decide whether to (a) accept the global reduction, (b) adopt the `fast` option as the implementation path, or (c) split into a scoped change that only affects the comms monitor call site. Additionally, the claim that xterm.js processes clipboard paste "near-instantly" and that 100ms `POST_PASTE_SETTLE_MS` is safe on all terminals (including remote/SSH sessions) is **unverified** — a manual slow-machine test is mandatory before release.

## Complexity Audit

### Routine
- Reducing timing constants in `terminalUtils.ts`.
- The paste and Enter sequence is already well-tested; reducing delays doesn't change the logic, only the timing.
- Adding an optional `fast` parameter to `sendRobustText` is a straightforward signature extension with a default that preserves existing behavior.

### Complex / Risky
- **Regression risk for card-driven dispatch:** The same `sendRobustText` function is called from 13 sites across 3 files. The most critical shared caller is `_attemptDirectTerminalPush` (TaskViewerProvider.ts line 2908, paced=true), which handles card-to-agent dispatch. Other callers include `sendToTerminal` (line 10422, paced varies), analyst dispatch (line 16859, paced=true), and 5 PlanningPanelProvider calls (all default paced=true). Reducing delays globally affects all 13 call sites. If the reduced `POST_PASTE_SETTLE_MS` of 100ms is insufficient on a slow or remote terminal, card dispatch could send Enter before the paste has rendered, corrupting the dispatched prompt — a silent, hard-to-reproduce failure.
- **CLI agent double-Enter:** The confirmation Enter for CLI agents (Claude, Copilot, etc.) exists because some CLI agents require a second Enter to confirm multi-line input. Reducing this delay should be safe as long as the first Enter has been processed.
- **Unverified xterm.js timing assumption:** The claim that xterm.js processes clipboard paste "near-instantly" and that 100ms `POST_PASTE_SETTLE_MS` is universally safe has not been tested on slow machines, VMs, or remote-SSH terminals where PTY round-trip latency can be significantly higher. The current 800ms was a conservative safety margin; cutting it to 100ms is an 8x reduction that may be too aggressive for degraded environments.

## Edge-Case & Dependency Audit

### Race Conditions
- The clipboard mutex (`withClipboardLock`, line 7) serializes all paste operations, so two concurrent pastes cannot interleave. Reducing delays doesn't affect this.
- The per-terminal send lock (`withTerminalSendLock`, line 22) serializes the full `/clear + prompt` sequence per terminal. Reducing delays makes the lock hold time shorter, which is strictly better — it reduces the window where a second dispatch to the same terminal would queue.

### Security
- No security implications. The clipboard lock already prevents clipboard data leakage between concurrent paste operations. Reducing delays does not change the lock semantics or the clipboard save/restore cycle.

### Side Effects
- **Card dispatch regression:** All 13 `sendRobustText` call sites will experience the reduced delays. The `_attemptDirectTerminalPush` path (TaskViewerProvider.ts line 2908) is the highest-risk caller because it dispatches plan cards to agent terminals where prompt corruption would silently break the agent's task. The comms monitor (line 20556) is the intended beneficiary but is only one of many callers.
- **PlanningPanelProvider calls:** 5 call sites (lines 4020, 4157, 4174, 4198, 4241) all use default `paced=true`. These benefit from faster submission but share the same slow-terminal risk.
- **`/clear` sends:** extension.ts line 2273 uses `paced=false` with short text (`/clear`), which takes the chunked `sendText` path (under 100-char threshold), not the clipboard paste path. This call site is unaffected by `POST_PASTE_SETTLE_MS` changes.

### Dependencies & Conflicts
- `sendRobustText` is a shared utility with no session-level dependencies. It is not gated on any session state or configuration.
- The `fast` option (if implemented) would need to be threaded through the `options` parameter already present in the function signature (line 123: `options?: { acquireFocus?: boolean }`). This extends the existing options object rather than adding a new parameter, minimizing signature churn.
- **Conflict risk:** If another plan simultaneously modifies `sendRobustText` timing or the `options` type, merge conflicts could arise. No such plan is currently known.

## Dependencies

No external dependencies. `sendRobustText` is a shared internal utility in `src/services/terminalUtils.ts` with no session-level or cross-service dependencies. The function is called from 13 sites across 3 files, but all are within the same codebase and share the same timing constants.

## Adversarial Synthesis

This plan's core risk is that it optimizes for the local comms-monitor symptom (1.8s paste-to-Enter gap) by globally reducing timing guards in a shared function called from 13 sites. **Web research confirmed the risk is real and specific:** the proposed 100ms `POST_PASTE_SETTLE_MS` is unsafe for Remote-SSH sessions (50-200ms RTT), where the Enter sequence can arrive before the clipboard buffer finishes transferring, corrupting bracketed paste and truncating prompts. The research-confirmed fix is **connection-aware delays** via `vscode.env.remoteName`: local terminals get the aggressive 100ms/300ms values, remote terminals get safer 300ms/600ms values. This is strictly safer than a blind global reduction and auto-detects the environment with no caller-side changes.

## Proposed Changes

### `src/services/terminalUtils.ts` — Connection-aware paste-to-Enter delays

**Research finding (decisive):** Web research confirmed that the proposed 100ms `POST_PASTE_SETTLE_MS` and 300ms `NEWLINE_DELAY` are safe for **local** terminals but **unsafe for Remote-SSH** (50-200ms RTT), where the carriage return can arrive before the clipboard buffer finishes transferring, breaking bracketed paste and truncating prompts. The fix is **connection-aware delays**: detect the environment via `vscode.env.remoteName` and apply different timing baselines.

**1. Replace the fixed `POST_PASTE_SETTLE_MS` constant** (line 45) with a connection-aware value:

```ts
// Connection-aware paste settle delay. Web research confirmed 100ms is safe
// for local terminals but unsafe for Remote-SSH (50-200ms RTT) where the
// Enter sequence can arrive before the clipboard buffer transfers.
// vscode.env.remoteName is undefined for local, non-undefined for remote.
const isRemoteTerminal = () => vscode.env.remoteName !== undefined;
const POST_PASTE_SETTLE_MS = () => isRemoteTerminal() ? 300 : 100; // was 800
```

Note: `POST_PASTE_SETTLE_MS` is currently a `const` number used at line 89 as `await new Promise(r => setTimeout(r, POST_PASTE_SETTLE_MS))`. Change the usage to `POST_PASTE_SETTLE_MS()` (function call). 300ms for remote accommodates the RTT overhead; 100ms for local is safe per research.

**2. Replace the fixed `NEWLINE_DELAY`** (line 127) with a connection-aware value:

```ts
const NEWLINE_DELAY = paced ? (isRemoteTerminal() ? 600 : 300) : 100; // was 1000 / 100
```

600ms for remote paced sends gives the PTY time to flush the pasted block over the network; 300ms for local is a safe margin. This reduces the paste-to-Enter gap from 1800ms to **400ms (local)** or **900ms (remote)** — both substantial improvements.

**3. Reduce `CLI_CONFIRM_ENTER_DELAY`** (line 128):

```ts
const CLI_CONFIRM_ENTER_DELAY = paced ? (isRemoteTerminal() ? 300 : 150) : 100; // was 350 / 150
```

**Total paste-to-Enter gap after fix:**
- **Local:** `POST_PASTE_SETTLE_MS (100ms)` + `NEWLINE_DELAY (300ms)` = **400ms** (down from 1800ms — 4.5x reduction)
- **Remote-SSH:** `POST_PASTE_SETTLE_MS (300ms)` + `NEWLINE_DELAY (600ms)` = **900ms** (down from 1800ms — 2x reduction, but safe for high-RTT)

**4. Scoped `fast` option (secondary, if even the connection-aware local values are too aggressive for card dispatch):**

If reducing delays for all 13 call sites is still deemed too risky for card-driven dispatch even with connection-awareness, add a `fast` option that only the comms monitor opts into. This would override the connection-aware defaults with even lower values for the monitor path only:

```ts
export async function sendRobustText(
    terminal: vscode.Terminal,
    text: string,
    paced: boolean = true,
    log?: (msg: string) => void,
    options?: { acquireFocus?: boolean; fast?: boolean }
): Promise<void> {
    const fast = options?.fast ?? false;
    const NEWLINE_DELAY = fast ? 100 : (paced ? (isRemoteTerminal() ? 600 : 300) : 100);
    const CLI_CONFIRM_ENTER_DELAY = fast ? 100 : (paced ? (isRemoteTerminal() ? 300 : 150) : 100);
    // ...
}
```

Then in `_mcpMonitorTick` (TaskViewerProvider.ts line 20556):

```ts
await sendRobustText(terminal, prompt, true, undefined, { fast: true });
```

**Research note on `POST_PASTE_SETTLE_MS` and the `fast` option:** The `fast` option as written above only overrides `NEWLINE_DELAY` and `CLI_CONFIRM_ENTER_DELAY`, NOT `POST_PASTE_SETTLE_MS` (which lives inside `pasteTextViaClipboard`, not `sendRobustText`). If the `fast` path should also reduce the paste-settle delay, either make `POST_PASTE_SETTLE_MS` configurable via a parameter passed to `pasteTextViaClipboard`, or accept that the fast path's gap is `POST_PASTE_SETTLE_MS()` + 100ms = 200ms (local) / 400ms (remote) — still a significant improvement over the 1800ms baseline.

**Recommended approach:** Ship the **connection-aware defaults** (steps 1-3) as the primary path — it's automatic, requires no caller-side changes, and is safe per research for both local and remote. Reserve the `fast` option (step 4) as a follow-up if card-dispatch regression testing reveals issues with the connection-aware local values.

## Verification Plan

All verification is manual. No automated tests are required or appropriate for timing-sensitive terminal behavior.

1. **Comms Monitor test (local):** Start the monitor, start polling, and watch the terminal when a prompt is sent. Measure the time between the prompt text appearing and Enter being pressed.
   - **Before fix:** ~1800ms gap.
   - **After fix (local):** ~400ms gap.
2. **Typing interference test:** Start typing in the monitor terminal immediately after a prompt is pasted. Verify the prompt is submitted before significant typing can interfere.
3. **Card dispatch regression test:** Dispatch a plan card to an agent terminal. Verify the prompt is delivered correctly and the agent receives it without corruption. Repeat 3 times to catch intermittent timing failures.
4. **Large prompt test:** Send a 2000+ char prompt via the comms monitor. Verify the paste + Enter sequence completes correctly without truncation.
5. **CLI agent double-Enter test:** Verify Claude still receives and processes the prompt correctly with the reduced confirmation Enter delay. The prompt should appear as a single submission, not two separate ones.
6. **Remote-SSH test (MANDATORY — research-confirmed unsafe at local values):** Open a VS Code Remote-SSH session to a server with >100ms RTT. Verify the connection-aware delays kick in (`vscode.env.remoteName !== undefined`):
   - Dispatch a prompt via the comms monitor and verify the full text appears before Enter is sent.
   - Expected gap: ~900ms (300ms paste-settle + 600ms newline delay), not the 400ms local value.
   - If Enter arrives before the paste is fully rendered (visible as a truncated or split prompt), the remote values need increasing — bump `POST_PASTE_SETTLE_MS` remote to 500ms and `NEWLINE_DELAY` remote to 800ms and re-test.
   - Verify bracketed paste mode is not broken (the pasted block should appear as a single unit, not split across lines).

**Routing recommendation:** Complexity 5 → **Coder** (4-6 range). The connection-aware approach is mechanically simple (function-ized constants + `vscode.env.remoteName` check), and research has resolved the timing uncertainty. A Coder-level implementer can handle this; the `fast` option is a follow-up if regression testing reveals issues.
