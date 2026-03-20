# Optimise inboxwatcher

## Goal
The Inboxwatcher is a once a minute poller that adds up the more terminals are registered. this potentially contributes to slowness. 

I question why this is actually needed once a minute and the associated lag, because a user experienced the lag if it causes it constantly, whereas it is designed as a once-in-a-million edge case detector. But you're CAUSING a constant bug just by having a detector active for a minor bug. 

Can we move it to an on-event detection?

some ideas given by an agent:

1. InboxWatcher is NOT needed for direct terminal sends anymore

    The current architecture:

     1 MCP Server → IPC → sendInputViaIpc() → VS Code Extension → Terminal
     2                     ↑
     3               (direct push - NO inbox involved)

    The pushMessageToTerminal() function at line 1748 sends directly via IPC to the extension, which types into the terminal. The inbox is only a
    fallback when IPC delivery fails.

    2. InboxWatcher runs constantly but shouldn't need to

    Looking at the code:
     - Line 1025 (extension.ts): MCP health check every 5 minutes - reasonable
     - Line 1041 (extension.ts): Terminal heartbeat every 60 seconds - reasonable
     - Line 229 (InboxWatcher.ts): Inbox polling every 60 seconds - questionable

    The inbox polling exists as a safety net for:
     1. Missed fs.watch events
     2. Cross-window message delivery (when multiple VS Code windows are open)
     3. Messages that arrive while the window is backgrounded

    The Real Question

    Why can't the MCP server just start InboxWatcher when a workflow triggers it?

    Because the MCP server is a separate Node.js process that:
     - Starts when VS Code activates the extension
     - Runs independently via stdio/IPC
     - Has no direct access to VS Code APIs (vscode.workspace, vscode.Terminal, etc.)

    Only the VS Code extension can:
     - Create terminals
     - Watch filesystem with VS Code's API
     - Type text into terminals

    So InboxWatcher must live in the extension host, not the MCP server.

    What Could Be Optimized

    The 60-second polling interval could be:
     1. Disabled entirely if fs.watch is working (check Output channel)
     2. Increased to 5-10 minutes as a true fallback
     3. Made on-demand - trigger scans only when:
        - Window gains focus (already done at line 1033)
        - A workflow explicitly needs it

    Would you like me to:
     1. Disable the 60-second polling (rely on fs.watch + focus triggers only)?
     2. Make it configurable with a longer default (e.g., 300 seconds)?
     3. Remove it entirely and rely purely on event-based detection?

**Clarification**: Since `fs.watch` and `vscode.workspace.createFileSystemWatcher` exist, and `triggerScan()` is called on window focus, the safest optimization is to increase the fallback interval from 60 seconds to 300 seconds (5 minutes) and rely on the event-driven filesystem watchers and window focus for timely message processing. Removing polling entirely is risky due to known issues with `fs.watch` across platforms/network drives.

## User Review Required
> [!NOTE]
> The InboxWatcher polling fallback interval is being increased from 60s to 300s. The system relies primarily on `fs.watch` and VS Code's `createFileSystemWatcher`. If file events fail in the environment (e.g., remote network mounts), message delivery might take up to 5 minutes or require shifting IDE window focus.

## Complexity Audit
### Band A — Routine
- Increase the `setInterval` delay in `src/services/InboxWatcher.ts` for the polling timer from `60000` (60 seconds) to `300000` (5 minutes).

### Band B — Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** No new race conditions introduced. Delayed fallback polling might mean a dropped `fs.watch` event isn't picked up until 5 minutes later, but window focus acts as a secondary swift trigger.
- **Security:** Modifying polling timer does not impact security or message verification logic.
- **Side Effects:** Terminal message "fallback" processing may experience delay up to 5 minutes on systems where file system events (e.g., `fs.watch`) are unreliable.
- **Dependencies & Conflicts:** This change is isolated to the interval in `InboxWatcher.ts` and does not conflict with parallel structural changes unless 'InboxWatcher' initialization changes.

## Adversarial Synthesis
### Grumpy Critique
Of course, you just bumped a number from 60 to 300 and patted yourself on the back! First off, what if `fs.watch` is completely broken on the user's WSL setup or network drive? They'll be sitting there waiting for 5 minutes for a single message to appear! And second, what about the timer leak if `startPollTimer` is somehow inadvertently called twice or the instance is disposed poorly? You didn't even address whether this interval should be configurable or just hardcoded like an amateur!

### Balanced Response
You raise valid concerns about environments with broken `fs.watch`. However, the core issue the user reported is the constant performance drag of a 60-second polling loop for a fallback case. The 5-minute fallback is an industry-standard back-stop for missed events. Furthermore, `window.onDidChangeWindowState` already calls `triggerScan()` when the window regains focus, meaning a user actively waiting on a message can trigger processing simply by activating the window. Making the interval configurable is scope-creep beyond the requested optimization. On timer leaks, `startPollTimer()` does not have an active check, but `stop()` already clears it, which is standard in this class. To be safer, we will just ensure `setInterval` handles any existing timers if `startPollTimer` is called again.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### src/services/InboxWatcher.ts
#### [MODIFY] `src/services/InboxWatcher.ts`
- **Context:** The `InboxWatcher` uses a fallback polling mechanism which is currently set to 60 seconds. This is overly aggressive given that file system watching and window focus events usually trigger scans reliably. We will increase it to 300 seconds (5 minutes) and ensure we clear any pre-existing timer before setting a new one to prevent leaks.
- **Logic:** 
  1. In `startPollTimer()`, add a check to clear `this.pollTimer` if it is already set before overriding it.
  2. Change the interval from `60000` to `300000` to match the 5-minute interval logic.
- **Implementation:**
```typescript
    /**
     * Polling fallback — catches anything both watchers miss.
     * Runs every 300 seconds (5 mins) as a heartbeat safety net. Primary detection is via
     * fs.watch + FileSystemWatcher. Passive triggers (window focus) cover the gap.
     */
    private startPollTimer(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
        }
        this.pollTimer = setInterval(() => this.scanAllInboxes(), 300000);
    }
```
- **Edge Cases Handled:** Timer leaks if `startPollTimer` is called multiple times are prevented by explicitly clearing `this.pollTimer` before reassignment.

## Verification Plan
### Automated Tests
- No existing automated tests specifically test the polling interval exact value. We will rely on manual verification.

### Manual Verification
1. Open the project in VS Code.
2. Initialize Switchboard and verify `InboxWatcher` starts via the Switchboard Output channel.
3. Observe the output channel and check if polling triggers every 5 mins instead of 1 minute.
4. Manually drop a `.json` file in `.switchboard/inbox/{AgentName}/` prefixed with `msg_` to verify that `fs.watch` still immediately picks up and processes the message, independent of the polling timer.

## Reviewer Pass — 2026-03-20

### Validation Results
- **TypeScript typecheck (`tsc --noEmit`)**: PASS
- **Regression tests**: N/A (no automated tests for polling interval)

### Findings
| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | NIT | `stop()` clears `pollTimer` via `clearInterval` but doesn't null the reference — stale Timeout object persists | Harmless — `startPollTimer()` guard calls `clearInterval` on stale ref (no-op), then reassigns |
| 2 | NIT | Magic number `300000` not extracted to a named constant | Deferred — scope creep for this plan; comment documents the value |
| 3 | NIT | Zero test coverage for InboxWatcher class overall | Deferred — separate initiative |

### Files Changed
- None (implementation correct as-is)

### Remaining Risks
- On systems where `fs.watch` is broken (WSL, network drives), message fallback detection is delayed to 5 minutes. Mitigated by `triggerScan()` on window focus.
