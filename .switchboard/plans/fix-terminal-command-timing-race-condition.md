# Fix Terminal Command Timing Race Condition

## Goal
Wait for terminal shells to be ready before sending startup commands in `createAgentGrid()`, using the VS Code shell execution event API to eliminate the race condition deterministically.

## Problem
When clicking "OPEN AGENT TERMINALS" in implementation.html, the agent CLI startup commands are sent to terminals before the terminals have time to fully initialize. This causes the commands to not be received in the terminals.

## Root Cause
In `src/extension.ts`, the `createAgentGrid()` function (lines 2263-2278):
1. Creates terminals using `vscode.window.createTerminal()` (line 2223)
2. Shows them with `terminal.show()` (line 2237)
3. **Immediately** sends startup commands using `terminal.sendText()` (line 2269)

There is no delay between terminal creation and command sending, so the terminals may not have their shell/process fully initialized when the commands arrive.

## Solution
Bump `engines.vscode` from `^1.90.0` to `^1.93.0` and use `vscode.window.onDidStartTerminalShellExecution` to wait for each terminal's shell to actually start before sending commands. This eliminates the race condition deterministically instead of relying on a fixed delay heuristic.

## Metadata
- **Tags:** [bugfix, reliability]
- **Complexity:** 4

## User Review Required
- Confirm that bumping `engines.vscode` from `^1.90.0` to `^1.93.0` is acceptable. VS Code 1.93 was released mid-2024, so virtually all users are already on 1.93+.

## Complexity Audit

### Routine
- Bumping `engines.vscode` and `@types/vscode` in `package.json`
- Subscribing to `onDidStartTerminalShellExecution` event
- Awaiting shell readiness per terminal before sending commands

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** Fully eliminated. `onDidStartTerminalShellExecution` fires only after the shell process has started, so `sendText` is guaranteed to land in an active shell. No heuristic delay needed.
- **Security:** No security implications. The change only affects timing of command dispatch.
- **Side Effects:** None. Commands are sent as soon as the shell is ready — no artificial delay on fast machines, no missed commands on slow ones.
- **Dependencies & Conflicts:** Requires `engines.vscode >= ^1.93.0` and `@types/vscode >= ^1.93.0`. VS Code 1.93 is nearly two years old, so this is a safe bump with negligible user impact.

## Dependencies
- None

## Adversarial Synthesis
Key risks: The engine bump drops support for VS Code 1.90–1.92, but those versions are nearly two years old and effectively unused. Mitigations: The event-driven approach eliminates the race condition entirely rather than mitigating it with a heuristic; no fixed delay means zero unnecessary latency on fast machines and no missed commands on slow ones.

## Proposed Changes

### `package.json` — Engine and types version bump

- **Context:** The current `engines.vscode: ^1.90.0` and `@types/vscode: ^1.90.0` preclude use of the `onDidStartTerminalShellExecution` API (stabilized in 1.93).
- **Logic:** Bump both to `^1.93.0` to unlock the shell execution event API.
- **Implementation:**

Change line 20:
```json
"vscode": "^1.93.0"
```

Change the `@types/vscode` devDependency:
```json
"@types/vscode": "^1.93.0"
```

- **Edge Cases:** None. VS Code auto-updates and 1.93 is nearly two years old.

### `src/extension.ts` — Lines 2263-2278 (inside `createAgentGrid`)

- **Context:** The `createAgentGrid()` function creates terminals in a loop (lines 2213-2245), registers them in batch (lines 2246-2261), then immediately sends startup commands (lines 2263-2278). The terminal shells may not have initialized by the time `sendText` is called.
- **Logic:** After creating all terminals, wait for each terminal's shell to start by listening to `onDidStartTerminalShellExecution`. Once all shells are confirmed ready, send the startup commands.
- **Implementation:**

**Current Code (lines 2263-2278):**
```typescript
try {
    for (const agent of agents) {
        let cmd = await taskViewerProvider.getAgentStartupCommand(agent.role, effectiveWorkspaceRoot);
        if (cmd && cmd.trim()) {
            const terminal = registeredTerminals.get(suffixedName(agent.name));
            if (terminal) {
                terminal.sendText(cmd.trim(), true);
                outputChannel?.appendLine(`[Extension] Sent startup command for '${agent.name}' (${agent.role}): ${cmd.trim()}`);

                // NEW: Cache the binary-derived agent display name
                const binary = cmd.trim().split(/\s+/)[0];
                const displayName = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase() + ' CLI';
                taskViewerProvider.setTerminalAgentInfo(suffixedName(agent.name), agent.role, displayName);
            }
        }
    }
} catch (e) {
    outputChannel?.appendLine(`[Extension] Startup command execution failed: ${e}`);
}
```

**Modified Code:**
```typescript
try {
    // Wait for all created terminals' shells to start before sending commands
    const newlyCreated = new Set(createdTerminals);
    if (newlyCreated.size > 0) {
        await new Promise<void>((resolve) => {
            const remaining = new Set(newlyCreated);
            const disposable = vscode.window.onDidStartTerminalShellExecution((e) => {
                if (remaining.has(e.terminal)) {
                    remaining.delete(e.terminal);
                    if (remaining.size === 0) {
                        disposable.dispose();
                        resolve();
                    }
                }
            });
            // Safety timeout: resolve after 5s even if some shells didn't report
            setTimeout(() => {
                disposable.dispose();
                if (remaining.size > 0) {
                    outputChannel?.appendLine(`[Extension] Shell init timeout — ${remaining.size} terminal(s) did not report ready, proceeding anyway`);
                }
                resolve();
            }, 5000);
        });
    }

    for (const agent of agents) {
        let cmd = await taskViewerProvider.getAgentStartupCommand(agent.role, effectiveWorkspaceRoot);
        if (cmd && cmd.trim()) {
            const terminal = registeredTerminals.get(suffixedName(agent.name));
            if (terminal) {
                terminal.sendText(cmd.trim(), true);
                outputChannel?.appendLine(`[Extension] Sent startup command for '${agent.name}' (${agent.role}): ${cmd.trim()}`);

                // NEW: Cache the binary-derived agent display name
                const binary = cmd.trim().split(/\s+/)[0];
                const displayName = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase() + ' CLI';
                taskViewerProvider.setTerminalAgentInfo(suffixedName(agent.name), agent.role, displayName);
            }
        }
    }
} catch (e) {
    outputChannel?.appendLine(`[Extension] Startup command execution failed: ${e}`);
}
```

- **Edge Cases:**
  - **Pre-existing terminals:** Only newly created terminals (in `createdTerminals`) are awaited. Terminals that already existed from a prior grid session are not waited on — their shells are already running.
  - **Safety timeout:** A 5-second timeout ensures the function never hangs indefinitely. If a shell fails to report (e.g., Remote-SSH connection issues), the code proceeds anyway and logs a warning.
  - **Event listener cleanup:** The `onDidStartTerminalShellExecution` subscription is disposed both on full resolution and on timeout, preventing leaks.

## Rationale
- **Event-driven over heuristic:** `onDidStartTerminalShellExecution` fires when the shell is actually ready, eliminating the race condition deterministically rather than gambling on a fixed delay.
- **No unnecessary latency:** On fast local machines, commands are sent as soon as the shell starts (often <100ms). On slow connections, the code waits as long as needed (up to the safety timeout).
- **Safety timeout:** Prevents indefinite blocking if a shell never starts. 5s is generous enough for Remote-SSH scenarios.
- **Only awaits new terminals:** Pre-existing terminals already have running shells, so there's no need to wait for them.
- **Engine bump is safe:** VS Code 1.93 is nearly two years old. Auto-update means virtually zero users are on older versions.

## Testing
1. Click "OPEN AGENT TERMINALS" in implementation.html
2. Verify that all agent terminals receive their startup commands correctly
3. Verify that the commands appear in the terminal output
4. Verify that agents start up successfully
5. Test with a mix of new and pre-existing terminals to confirm only new ones are awaited

## Risks
- **Low**: The engine bump drops VS Code 1.90–1.92 support, but those versions are nearly two years old and effectively unused
- **Low**: If `onDidStartTerminalShellExecution` doesn't fire for a terminal (e.g., unsupported shell), the 5s safety timeout ensures the code proceeds anyway

## Verification Plan

### Automated Tests
- No new automated tests required. The change involves VS Code terminal event handling that cannot be meaningfully unit-tested outside the live extension host. Verification is manual (see Testing section above).

---

## Review Pass — 2026-05-28

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | **CRITICAL** | Event subscription race: `onDidStartTerminalShellExecution` is subscribed AFTER `terminal.show()` and an `await updateState()` yield. Fast-starting shells fire the event before the listener is attached, causing missed events and a full 5s timeout fallback — worse latency than the original bug on fast machines. | `src/extension.ts` lines 2264–2287 (original impl) |
| 2 | **NIT** | Redundant Set copy: `newlyCreated` intermediate Set is immediately copied into `remaining` — could construct `remaining` directly from `createdTerminals`. | `src/extension.ts` lines 2265–2268 (original impl) |
| 3 | **NIT** | Double `resolve()` without guard: if all shells report before timeout, `resolve()` fires at line 2274; timeout then fires `resolve()` again at line 2284. Safe per JS Promise semantics but not self-documenting. | `src/extension.ts` lines 2272–2284 (original impl) |

### Stage 2: Balanced Synthesis

| Finding | Verdict | Action |
|---------|---------|--------|
| 1 — Event subscription race | **Fix now** | Pre-subscribe to `onDidStartTerminalShellExecution` BEFORE the terminal creation loop. Accumulate ready terminals in a `shellReadyTerminals` Set. After the loop, filter `createdTerminals` against the Set and only await stragglers. |
| 2 — Redundant Set copy | **Fix as drive-by** | Eliminated by the restructured code (no intermediate `newlyCreated` Set). |
| 3 — Double resolve | **Defer** | JS Promise semantics make this safe; cosmetic only. |

### Code Fixes Applied

**File: `src/extension.ts`**

1. **Added pre-subscription before terminal creation loop** (before line 2208):
   - Declared `shellReadyTerminals: Set<vscode.Terminal>` and `preSubscription` listener
   - Pre-subscribes to `onDidStartTerminalShellExecution` so events from fast-starting shells are captured even during the `await updateState()` yield

2. **Replaced shell wait block** (lines 2271–2294):
   - Changed from `new Set(createdTerminals)` to `createdTerminals.filter(t => !shellReadyTerminals.has(t))` — only await terminals not already reported ready
   - Removed redundant intermediate `newlyCreated` Set
   - Second `onDidStartTerminalShellExecution` subscription still handles terminals that haven't started yet, with 5s safety timeout unchanged

3. **Added `preSubscription.dispose()` in finally block** (line 2320):
   - Ensures the pre-subscription listener is always cleaned up regardless of success/failure

**File: `package.json`** — No changes needed (engine bump and `@types/vscode` bump already correctly applied)

### Verification Results

- **TypeScript check (`tsc --noEmit`):** PASS — zero errors in `extension.ts`. Two pre-existing errors in `ClickUpSyncService.ts` and `KanbanProvider.ts` (unrelated relative import path issues).
- **Compilation:** Skipped per session instructions.
- **Automated tests:** Skipped per session instructions.

### Remaining Risks

- **Low:** If `onDidStartTerminalShellExecution` never fires for a terminal (unsupported shell type), the 5s safety timeout still ensures forward progress. The pre-subscription does not change this behavior.
- **Low:** The `shellReadyTerminals` Set accumulates entries for ALL terminal shell starts (including non-Switchboard terminals) during the function's lifetime. This is harmless — entries are only checked against `createdTerminals` — but the Set could grow if many external terminals start concurrently. The Set is disposed with `preSubscription.dispose()` in the finally block.

---

**Recommendation:** Complexity 4 → **Send to Coder** (original) → **Review Complete, Fixes Applied**
