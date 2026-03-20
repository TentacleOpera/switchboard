# MCP status light in sidebar should check IPC connection

## Goal
THe MCP: online status light is misleading because it only checks for the presence of a file, and not the IPC connection. THis is an issue in IDEs with flaky MCP integration like windsurf. CAn we have it check for an IPC connection?

However, this needs to be done in a way that is actually performant. We used to have this, but it was disabled because it was spamming an mcp ping every second. There is no need for such a frequent check, once on startup and then maybe every 5 minutes is enough, with a manual 'check connection' icon next to the status light for manual confirmation if the user wantss to initiate a check.

## Proposed Changes

### Step 1: Re-enable IPC health probe with throttled scheduling
**File:** `src/extension.ts` — `checkMcpConnection()` function (lines 2827–2877)

Currently, `checkMcpConnection()` is static-only (comment at line 2824: "No IPC probing or polling"). Modify it to:
1. Keep the existing static checks (server file presence, IDE config) as a fast pre-flight.
2. If static checks pass AND `mcpServerProcess` is alive, send a `healthProbe` IPC message and await a `healthProbeResponse` with a 5-second timeout.
3. Set `toolReachable = true` only when the IPC response returns `ok: true`.
4. If the probe times out or errors, set `toolReachable = false` and set `diagnostic = "IPC health probe failed"`.

The MCP server already handles `healthProbe` messages at `src/mcp-server/mcp-server.js` lines 179–190 — no changes needed on the server side.

### Step 2: Add a 5-minute recurring check
**File:** `src/extension.ts`

After the initial `checkMcpConnection()` call on activation, start a `setInterval` at 300000ms (5 minutes) that re-runs `checkMcpConnection()` and pushes the result to `TaskViewerProvider.sendMcpConnectionStatus()`. Store the interval handle and clear it in the `deactivate()` function.

### Step 3: Add a manual "check connection" icon next to the status light
**File:** `src/webview/implementation.html` — MCP status footer (lines 1415–1418)

Add a clickable refresh icon (↻ or similar) next to the `#mcp-text` span. On click, send a webview message `{ type: 'recheckMcpConnection' }`.

**File:** `src/services/TaskViewerProvider.ts` — `handleWebviewMessage()`

Handle the `recheckMcpConnection` message by calling back into the extension's `checkMcpConnection()`. This requires either:
- A callback function passed to TaskViewerProvider on construction, OR
- Firing a VS Code command (`switchboard.recheckMcp`) registered in `extension.ts`.

The command approach is cleaner: register `switchboard.recheckMcp` in `extension.ts` that calls `checkMcpConnection()` and pushes the result to the TaskViewerProvider.

### Step 4: Update status light states
**File:** `src/webview/implementation.html` — `updateMcpStatus()` (lines 3402–3413)

Current logic: green if `connected`, orange if `serverRunning`, red otherwise. The `connected` flag is `ideConfigured && toolReachable` (TaskViewerProvider.ts line 7959). With the IPC probe, `toolReachable` now reflects actual IPC connectivity, so the existing UI logic should work correctly without changes.

### Step 5: Update `McpStatus` interface
**File:** `src/extension.ts` — `McpStatus` interface (lines 2816–2821)

No structural changes needed. The existing `toolReachable` field will now be set by the IPC probe instead of being always derived from static checks.

## Verification Plan
- Start extension, confirm MCP status shows green with IPC-backed `toolReachable`.
- Kill the MCP server process manually → confirm status transitions to orange/red within 5 minutes or immediately on manual recheck.
- Click the manual recheck icon → confirm status updates immediately.
- Confirm no console spam — only one probe every 5 minutes plus manual triggers.
- Test in Windsurf (if available) to confirm the IPC probe detects flaky connections.

## Open Questions
- Should the manual recheck icon show a brief spinner/loading state during the probe?
- If the IPC probe fails, should the extension attempt to restart the MCP server automatically, or just report the failure?

## Complexity Audit
**Band B (Complex/Risky)**
- Multi-file coordination: `extension.ts`, `implementation.html`, `TaskViewerProvider.ts`
- Introduces new async IPC flow (health probe with timeout) into the connection check
- Must handle race conditions: what if the MCP server process exits between the static check passing and the IPC probe sending?
- Risk of regression if the probe accidentally blocks or leaks timers

## Dependencies
- **Conflicts with:** `feature_plan_20260312_053351_remove_mcp_server_polling.md` — that plan explicitly removed IPC probing in favor of static checks. This plan partially reverses that decision with a throttled, opt-in approach. Ensure the two plans are reconciled: the static check remains the fast path, IPC probe is the verification layer.
- No other plan conflicts identified.

## Adversarial Review

### Grumpy Critique
1. "You're literally undoing the work from the 'remove MCP server polling' plan. That plan was merged for good reason — IPC probes were noisy and unreliable. What makes you think a 5-minute interval won't have the same problems?"
2. "The health probe handler in mcp-server.js uses `process.send?.()` — if the IPC channel is broken, this will silently fail. How do you detect a broken IPC channel vs a slow response?"
3. "Registering a VS Code command just for a recheck button is over-engineered. Just have the TaskViewerProvider hold a reference to the check function."
4. "The 5-second timeout for the IPC probe — what happens if the MCP server is under heavy load processing tool calls? False negatives will confuse users."

### Balanced Synthesis
1. **Valid concern — reconcile with prior plan.** The prior plan removed *polling* (every 1s). This plan adds *scheduled probing* (every 5min) + manual trigger — fundamentally different cadence. Document this distinction clearly in the code comments.
2. **Valid — add IPC channel health detection.** Check `mcpServerProcess.connected` before sending the probe. If disconnected, skip the probe and report `toolReachable = false` immediately.
3. **Partially valid — but command approach is standard VS Code pattern.** Keep the command for testability and potential keybinding. It's one extra line of registration.
4. **Valid — increase timeout to 10 seconds** and add a "checking..." intermediate state in the UI so users see the probe is in progress, not stale.

## Agent Recommendation
**Lead Coder** — Multi-file changes with async IPC flow, timer management, and interaction with prior architectural decisions require careful coordination.

## Reviewer Pass — 2026-03-19

### Implementation Status: ✅ COMPLETE — All 5 steps implemented

| Step | Status | Files |
|------|--------|-------|
| Step 1: IPC health probe | ✅ | `src/extension.ts` (checkMcpConnection, lines 2861–2947) |
| Step 2: 5-min recurring check | ✅ | `src/extension.ts` (mcpHealthCheckInterval, lines 960–963; cleared in deactivate lines 2951–2954) |
| Step 3: Manual recheck icon | ✅ | `src/webview/implementation.html` (↻ icon, line 1418); `src/services/TaskViewerProvider.ts` (recheckMcpConnection handler, line 2778); `src/extension.ts` (switchboard.recheckMcp command, lines 1133–1143) |
| Step 4: Status light states | ✅ | No changes needed — existing UI logic works with IPC-backed toolReachable |
| Step 5: McpStatus interface | ✅ | No structural changes — toolReachable now set by IPC probe |

### Grumpy Findings
- **NIT:** 3000ms initial delay before first health check means "CHECKING" shows for 3s on startup.
- **NIT:** Window focus triggers `refreshMcpStatus()` (line 966–971) — undocumented bonus, not in plan.
- **NIT:** Manual recheck sends synthetic "CHECKING" intermediate state causing brief orange flicker before real result.

### Balanced Synthesis
All findings are NIT. No code fixes required. Implementation correctly addresses all adversarial concerns from the plan:
- 10s timeout (matching adversarial recommendation)
- `mcpServerProcess.connected` pre-check before probe send
- Proper cleanup in `deactivate()`

### Validation
- `npx tsc --noEmit` — ✅ Clean (0 errors)

### Remaining Risks
- Window focus refresh is undocumented in code comments — future maintainer confusion risk (low).
- If MCP server is under heavy load, 10s timeout may still produce false negatives (accepted risk per adversarial synthesis).
