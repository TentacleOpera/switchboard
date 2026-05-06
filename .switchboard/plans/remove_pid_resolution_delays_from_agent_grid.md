# Remove PID Resolution Delays from Agent Grid

## Goal
Remove blocking PID resolution waits from the `createAgentGrid` function and related agent-grid code paths to eliminate the ~5-second delay when clicking "OPEN AGENT TERMINALS."

## Metadata
**Tags:** performance, infrastructure, bugfix
**Complexity:** 5

## User Review Required
- [ ] Confirm that the MCP heartbeat interval (Site 4) should be removed entirely in this plan, or deferred to a separate MCP-removal plan.
- [ ] Confirm that the 1-second startup command delay (Site 3) should be removed outright (not just "considered").

## Problem
Clicking "OPEN AGENT TERMINALS" button in the sidebar takes ~5 seconds before terminals start opening. This delay is caused by PID resolution waits in the `createAgentGrid` function.

## Root Cause
The `createAgentGrid` function in `src/extension.ts` has two blocking PID resolution operations:
- **Line 2897**: `await waitWithTimeout(term.processId, 5000, undefined)` - for existing terminals in `clearGridBlockers`
- **Line 2957**: `await waitWithTimeout(terminal.processId, 5000, undefined)` - for each new terminal created

These 5-second timeouts per terminal are only needed for MCP server registration and terminal reclamation after VS Code restarts.

## Why This Is Safe to Remove
1. **MCP server being removed**: Current kanban plans include removing the MCP server entirely
2. **skipParentResolution flag**: The code already sets `skipParentResolution: true` (line 2968), which means null/unresolved PIDs are handled gracefully
3. **Terminal messaging doesn't need PID**: Kanban buttons send terminal messages using `terminal.sendText()` directly, not via MCP
4. **Terminals work without PID**: Terminals are immediately usable for message sending even without PID resolution

## Complexity Audit

### Routine
- **Remove PID resolution from `clearGridBlockers`** (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts:2895-2904`): Replace PID health check with `exitStatus === undefined` check. Terminals with `exitStatus === undefined` are alive; no PID needed.
- **Remove PID resolution from main terminal creation loop** (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts:2955-2960`): Set `pid: null` directly in `batchRegistrations` instead of awaiting `waitWithTimeout`.
- **Remove 1-second startup command delay** (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts:3029`): Remove `await new Promise(r => setTimeout(r, 1000));` — the shell is ready immediately after terminal creation; the delay is an arbitrary guess with no reliability benefit.
- **Update log messages**: Change PID-related log messages to reflect that PID is intentionally null, not "unresolved."

### Complex / Risky
- **MCP heartbeat interval** (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts:2093-2117`): The heartbeat resolves PIDs for all registered terminals every 60 seconds and re-registers them with the MCP server via IPC. If MCP is being removed, this entire heartbeat is dead code. However, removing it is a larger change than just stripping PID resolution — it's removing a periodic side effect. **Decision: Remove the entire heartbeat block** since its sole purpose is MCP IPC registration.
- **Terminal reclamation on activation** (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts:2183-2187`): This resolves PIDs for all open terminals to match them against state.json entries for reclamation after VS Code restart. PID is used as a secondary match key after name-based matching. **This plan does NOT remove PID from reclamation** — it's needed for cross-IDE terminal disambiguation. Reclamation runs once on activation, not per-button-click, so it's not the source of the user-facing delay. Defer to MCP-removal plan.
- **Auto-detect terminals** (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts:3709`): This runs when the MCP server starts and auto-registers existing terminals. Like the heartbeat, it's MCP-dependent. **Defer to MCP-removal plan** — removing it here would break the MCP server's terminal discovery while it still exists.
- **focusTerminal command** (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts:2476`): User-triggered, 1s timeout. Not part of the startup delay. **Leave unchanged.**

## Edge-Case & Dependency Audit

**Race Conditions:**
- Removing PID resolution from `clearGridBlockers` means stale (exited but not yet cleaned up) terminals won't be detected by PID check. However, `exitStatus === undefined` is a reliable alive indicator — a terminal with no exit status is running. If a terminal process has exited but VS Code hasn't updated `exitStatus` yet, it would be incorrectly kept. This is a very narrow race window and the existing PID check has the same problem (PID resolution can return a stale PID before the OS reaps the process).

**Security:**
- No security implications. PID values were only used for MCP registration, not for access control.

**Side Effects:**
- `batchRegistrations` will now always have `pid: null`. The state.json `terminals` entries will no longer have `pid` fields (line 3009: `if (reg.pid) state.terminals[reg.name].pid = reg.pid` — this condition will be false). This is fine — PID in state.json was only used by the MCP server.
- The MCP heartbeat removal means terminals won't be re-registered with the MCP server every 60 seconds. If the MCP server is still running, it may lose track of terminals after the initial registration. **This is acceptable** because MCP server removal is planned.
- Removing the 1-second startup delay means startup commands may be sent before the shell is fully initialized. **Mitigation:** VS Code's `terminal.sendText()` queues the text — it doesn't require the shell to be ready. The command will be buffered and executed once the shell initializes.

**Dependencies & Conflicts:**
- Active Kanban board query shows no plans in CREATED or PLAN REVIEWED columns that conflict with this change.
- This plan is a prerequisite for the eventual MCP server removal — it strips PID dependencies from the agent grid path, making the MCP removal cleaner.

## Dependencies
- None

## Adversarial Synthesis
Key risks: Removing PID from `clearGridBlockers` loses stale-terminal detection (narrow race with `exitStatus` update); removing the heartbeat breaks MCP terminal tracking if MCP server is still running; removing the 1-second startup delay could send commands before shell init on slow machines. Mitigations: `exitStatus === undefined` is a reliable alive check for the stale-terminal case; MCP server removal is planned so heartbeat breakage is temporary; `terminal.sendText()` buffers commands so shell-readiness timing is not a concern.

## Changes Required

### Execution Breakdown by Complexity

#### Low Complexity Steps

1. **Remove PID resolution from `clearGridBlockers`**
   - **File:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts:2895-2904`
   - **Implementation:** Replace the PID-based health check with an `exitStatus` check:

   ```typescript
   // BEFORE (lines 2895-2904):
   const healthy: vscode.Terminal[] = [];
   for (const term of matches) {
       const pid = await waitWithTimeout(term.processId, 5000, undefined);
       if (!pid) {
           mcpOutputChannel?.appendLine(`[Extension] Disposing stale grid terminal '${term.name}' for agent '${agent.name}' (PID unresolved)`);
           term.dispose();
           continue;
       }
       healthy.push(term);
   }

   // AFTER:
   const healthy: vscode.Terminal[] = [];
   for (const term of matches) {
       // Use exitStatus instead of PID — terminals with undefined exitStatus are alive
       if (term.exitStatus !== undefined) {
           mcpOutputChannel?.appendLine(`[Extension] Disposing exited grid terminal '${term.name}' for agent '${agent.name}'`);
           term.dispose();
           continue;
       }
       healthy.push(term);
   }
   ```

   - **Edge case:** If a terminal has exited but `exitStatus` hasn't been updated yet, it will be incorrectly kept as healthy. This is a very narrow race window. The next call to `clearGridBlockers` (on the next "OPEN AGENT TERMINALS" click) will clean it up.

2. **Remove PID resolution from main terminal creation loop**
   - **File:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts:2955-2971`
   - **Implementation:** Remove the `waitWithTimeout` call and set `pid: null` directly:

   ```typescript
   // BEFORE (lines 2955-2971):
   let pid: number | undefined;
   try {
       pid = await waitWithTimeout(terminal.processId, 5000, undefined);
   } catch (e) {
       mcpOutputChannel?.appendLine(`[Extension] Warning: Could not resolve PID for grid terminal '${agent.name}': ${e}`);
   }
   // Always register — skipParentResolution handles null/unresolved PIDs gracefully
   batchRegistrations.push({
       name: suffixedName(agent.name),
       purpose: 'agent-grid',
       role: agent.role,
       pid: pid ?? null,
       friendlyName: agent.name,
       skipParentResolution: true,
       ideName: vscode.env.appName
   });
   mcpOutputChannel?.appendLine(`[Extension] Queued grid terminal '${agent.name}' (PID: ${pid ?? 'unresolved'}) for batch registration`);

   // AFTER:
   // Skip PID resolution for agent grid terminals — not needed for terminal messaging
   batchRegistrations.push({
       name: suffixedName(agent.name),
       purpose: 'agent-grid',
       role: agent.role,
       pid: null,
       friendlyName: agent.name,
       skipParentResolution: true,
       ideName: vscode.env.appName
   });
   mcpOutputChannel?.appendLine(`[Extension] Queued grid terminal '${agent.name}' (PID: null — skipParentResolution) for batch registration`);
   ```

3. **Remove 1-second startup command delay**
   - **File:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts:3029`
   - **Implementation:** Remove the delay entirely. `terminal.sendText()` buffers the command — it doesn't require the shell to be ready.

   ```typescript
   // BEFORE (line 3028-3030):
   // Delay to ensure shell process is ready
   await new Promise(r => setTimeout(r, 1000));
   terminal.sendText(cmd.trim(), true);

   // AFTER:
   terminal.sendText(cmd.trim(), true);
   ```

   - **Rationale:** The delay was an arbitrary guess. VS Code's terminal API queues `sendText` commands — they execute once the shell initializes. With N agents, this delay adds N seconds of unnecessary waiting.

#### High Complexity Steps

1. **Remove MCP heartbeat interval**
   - **File:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts:2093-2117`
   - **Implementation:** Remove the entire `setInterval` block that resolves PIDs and re-registers terminals with the MCP server every 60 seconds. This heartbeat's sole purpose is MCP IPC registration — with MCP removal planned, it's dead code.

   ```typescript
   // BEFORE (lines 2093-2117):
   const HEARTBEAT_INTERVAL_MS = 60_000;
   const heartbeatInterval = setInterval(async () => {
       const entries = Array.from(registeredTerminals.entries());
       const pids = await Promise.all(
           entries.map(([, terminal]) =>
               waitWithTimeout(terminal.processId, 5000, undefined).catch(() => undefined)
           )
       );
       for (let i = 0; i < entries.length; i++) {
           const [name] = entries[i];
           const pid = pids[i];
           if (pid && mcpServerProcess) {
               mcpServerProcess.send({
                   type: 'registerTerminal',
                   name,
                   pid,
                   friendlyName: name,
                   skipParentResolution: true,
                   ideName: vscode.env.appName
               });
           }
       }
   }, HEARTBEAT_INTERVAL_MS);
   context.subscriptions.push({ dispose: () => clearInterval(heartbeatInterval) });

   // AFTER:
   // (Remove the entire block — heartbeat was only for MCP server re-registration)
   ```

   - **Risk:** If the MCP server is still running, it won't receive periodic terminal re-registrations. Initial registration via `registerTerminalsBatch` (line 2991) still works. **Acceptable** because MCP removal is planned.
   - **Also remove:** The `context.subscriptions.push({ dispose: () => clearInterval(heartbeatInterval) });` line.

2. **Deferred: Terminal reclamation PID resolution** (NOT in scope for this plan)
   - **File:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts:2183-2187`
   - **Reason:** Terminal reclamation uses PID as a secondary match key after name-based matching. It runs once on extension activation, not per-button-click, so it's not the source of the user-facing delay. Removing PID from reclamation requires an alternative matching strategy (e.g., name + IDE + `exitStatus`). This should be addressed in the MCP-removal plan.
   - **Action:** Add a TODO comment at line 2183: `// TODO: Remove PID resolution when MCP server is removed — use name + ideName matching instead`

3. **Deferred: Auto-detect terminals PID resolution** (NOT in scope for this plan)
   - **File:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts:3709`
   - **Reason:** This is MCP-dependent auto-registration. Removing it breaks MCP terminal discovery while the MCP server still exists.
   - **Action:** Add a TODO comment at line 3709: `// TODO: Remove PID resolution when MCP server is removed`

4. **Deferred: focusTerminal command PID resolution** (NOT in scope for this plan)
   - **File:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts:2476`
   - **Reason:** User-triggered, 1s timeout. Not part of the startup delay. Leave unchanged.

## Testing
1. **Verify terminals open immediately**: Click "OPEN AGENT TERMINALS" and confirm terminals appear within <1 second
2. **Verify terminal messaging works**: Send messages from kanban buttons to verify functionality
3. **Verify stale terminal cleanup**: Manually close a terminal process, then click "OPEN AGENT TERMINALS" — verify the exited terminal is disposed and a new one is created
4. **Verify no MCP errors**: Check output channel for MCP-related errors (should be harmless if MCP server is being removed)
5. **Verify startup commands execute**: Check that agent startup commands (from `getAgentStartupCommand`) are sent and execute correctly without the 1-second delay
6. **Verify terminal reclamation still works**: Restart VS Code with existing terminals, verify they are reclaimed correctly (PID resolution in reclamation path is unchanged)

## Risk Assessment
- **Low risk**: Terminal messaging doesn't depend on PID resolution
- **Low risk**: `exitStatus === undefined` is a reliable alive indicator for `clearGridBlockers`
- **Low risk**: `terminal.sendText()` buffers commands, so removing the 1-second delay is safe
- **Medium risk**: Removing the heartbeat means MCP server won't get periodic re-registrations — acceptable given planned MCP removal
- **Not in scope**: Terminal reclamation PID resolution (deferred to MCP-removal plan)

## Success Criteria
- Terminals open within <1 second of clicking "OPEN AGENT TERMINALS"
- Terminal messaging from kanban buttons continues to work
- Stale/exited terminals are correctly detected and disposed
- No functional regressions in terminal management
- Startup commands execute correctly without the 1-second delay

## Recommendation

**Send to Coder** — Complexity 5. The changes are well-scoped to the agent grid creation path with clear file/line references. The heartbeat removal is the only moderately complex change, and its impact is limited since MCP removal is planned. Deferred items are clearly marked with TODO comments.

---

## Reviewer Pass

### Stage 1: Grumpy Review
*   **[NIT] Narrow Race Condition:** Relying purely on `exitStatus === undefined` leaves a tiny window where the OS has killed the process but VS Code hasn't fired the event yet. The plan admits this, but it's still a smell. At least it's better than blocking for 5 seconds.
*   **[NIT] Loose Types:** Setting `pid: null` in `batchRegistrations` forces downstream types to loosen up. It works because JavaScript doesn't care, but it's sloppy.
*   **[NIT] TODOs as Tech Debt:** You left `// TODO` comments for the MCP server removal instead of tracking them properly. Let's hope someone actually reads them.

### Stage 2: Balanced Synthesis
*   **Keep:** The removal of `waitWithTimeout` in `clearGridBlockers` and the main loop. The logic accurately targets `exitStatus` and dramatically speeds up the grid creation.
*   **Keep:** The removal of the 1-second startup delay. `terminal.sendText()` buffers correctly.
*   **Keep:** The removal of the heartbeat interval.
*   **Defer:** The remaining PID resolution code paths correctly belong to the MCP removal plan.

### Action Taken
*   **Verification:** Verified via manual inspection that the grid creation path is free of arbitrary delays and `waitWithTimeout` calls.
*   **Compilation:** `npm run compile` passed successfully without type errors.
*   **Code Fixes Applied:** None. The coder followed the plan flawlessly.
