# Capability Spec: CLI-Initiated Terminal Creation

## Overview
This specification documents the architectural capability for CLI agents (via the `switchboard` MCP server) to programmatically create new visible terminal tabs within the VS Code UI.

While this capability is currently **disabled** in the default `mcp-server.js` configuration (to favor headless automation), the underlying plumbing remains fully implemented in the extension. This document serves as a reference for re-enabling or modifying this feature.

## Architecture: The "Bridge" Pattern

Because CLI agents run as subprocesses inside a terminal, they lack direct access to the IDE's window management APIs. To bypass this limitation, we use an **Inter-Process Communication (IPC) Bridge**.

### Data Flow
1.  **Trigger**: The Agent calls an MCP Tool (e.g., `create_terminal`).
2.  **Server**: The MCP Server (running in Node.js) receives the request.
3.  **Bridge**: The MCP Server sends an IPC message to its parent process (the VS Code Extension Host).
    *   *Message Payload*: `{ type: 'createTerminal', name: 'Gemini-Worker', cwd: '/path/to/repo' }`
4.  **Extension**: The VS Code Extension (`extension.ts`) listens for this message.
5.  **Execution**: The Extension uses the VS Code API (`vscode.window.createTerminal`) to spawn the actual UI element.
6.  **Feedback**: The Extension returns the new terminal's PID to the MCP Server via IPC, allowing the agent to register and control it.

## Implementation Details

### 1. Extension Side (`src/extension.ts`)
The extension must spawn the MCP server with an IPC channel (`stdio: ['pipe', 'pipe', 'pipe', 'ipc']`) and listen for messages:

```typescript
// Example from extension.ts
mcpServerProcess.on('message', async (message: any) => {
    if (message.type === 'createTerminal') {
        const terminal = vscode.window.createTerminal({
            name: message.name,
            cwd: message.cwd
        }); 
        // Logic to return PID to MCP server follows...
    }
});
```

### 2. MCP Server Side (`src/mcp-server/mcp-server.js`)
The server exposes a tool that triggers the IPC message. 

*Status*: **Currently Disabled/Commented Out** in `mcp-server.js`.
*Reason*: To enforce a "Headless Automation" workflow where agents spawn background processes (invisible to the user) instead of cluttering the UI with tabs.

To re-enable, one would restore a tool definition using `process.send`:

```javascript
server.tool("create_terminal", { name: z.string() }, async ({ name }) => {
    if (process.send) { // Check if IPC is available (i.e. running via Extension)
        const requestId = `req_${Date.now()}`;
        process.send({ type: 'createTerminal', name, id: requestId });
        // (Wait for response via listener...)
        return { content: [{ type: "text", text: "Request sent to IDE." }] };
    }
    return { isError: true, content: [{ type: "text", text: "IPC not available (standalone mode)." }] };
});
```

## Strategic Utility
This capability is critical for:
*   **Interactive Sessions**: When an agent needs to "show its work" or hand off a running process (like a dev server) to the user.
*   **Debugging**: Allowing an agent to spawn a terminal solely for the purpose of running a debugger that the user can interact with.
*   **Complex Setups**: Bootstrapping a multi-terminal environment (e.g., Client + Server + DB) with a single command.
