# Remove MCP server polling

## Notebook Plan

The MCP server is jusdt a simple file. We dpn't need the health check poller. The status light should just check to see if the file exists.

## Goal
Simplify the MCP server status indicator by removing brittle IPC health checks and polling, replacing them with a simple file existence check, since the host IDE is ultimately responsible for managing the MCP process.

## Proposed Changes
- **`src/extension.ts` - Remove Polling & Auto-Heal:** Delete the `scheduleNextMcpPoll` loop, the `HEALTHY_POLL_MS`/`DEGRADED_POLL_MS` constants, and the auto-heal logic (`degradedMcpStreak`, `restartBundledMcpServer` calls triggered by degradation).
- **`src/extension.ts` - Remove IPC Probing:** Delete the `probeBundledMcpTools` function.
- **`src/extension.ts` - Simplify `checkMcpConnection`:** Update the function to simply check if `mcp-server.js` exists in the extension's `dist` directory. If it exists, set `serverRunning` and `toolReachable` to `true`.

## Verification Plan
- Compile the extension (`npm run compile`).
- Launch the extension host.
- Verify that the MCP status light in the UI shows green/connected immediately upon load.
- Verify in the Debug Console that there are no longer polling or health-check errors logged every 15-120 seconds.

## Open Questions
- Should we keep the check for the IDE's MCP configuration (`mcp.json`/`mcpServers` setting) or just strictly check the file? (Assuming we keep the IDE config check for maximum accuracy).

## Review Feedback
- **Grumpy Review:** "Are you serious?! You're taking out the entire health check and replacing it with a glorified `fs.existsSync` on a static file that we *know* gets shipped with the extension? It's ALWAYS going to exist! The status light will just be permanently green even if the actual MCP server process is dead, hanging, or failing to communicate with the IDE. And what about the auto-heal? You're ripping out the self-recovery mechanism! If the user's AI client drops the connection, Switchboard will just sit there smiling like an idiot saying 'Well, the file is on disk!' This is a massive regression in observability!"
- **Balanced Synthesis:** "Grumpy is correct that this significantly dumbs down the observability of the MCP server from the extension's perspective. However, the architectural reality of MCP is that the *IDE client* (e.g., Claude, Windsurf, Cursor) is responsible for spawning, managing, and health-checking the `mcp-server.js` process via stdio. Switchboard's internal extension host shouldn't be playing babysitter to a process managed by the host IDE, and the internal IPC health checks have proven brittle and unnecessary. Checking for the file's existence (and that the IDE config is present) is sufficient for a 'Setup Complete' indicator. We will proceed with removing the polling, auto-heal, and IPC probing."

#### Complexity Audit
- Band A (routine task). Deleting polling intervals, `probeBundledMcpTools`, and auto-heal logic in `extension.ts`, replacing them with a simple file existence check.

#### Edge-Case Audit
- Race conditions: The file existence check might run before the extension's `dist` folder is fully written during an initial installation/update, leading to a false negative.
- Side effects: Removing auto-heal means if the MCP server process dies (managed by IDE), the extension will not attempt to recover it or even know it died, leading to degraded user experience with no feedback.
- Security holes: None identified.