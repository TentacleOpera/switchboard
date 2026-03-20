# Optimise inboxwatcher

## Goal
The Inboxwatcher is a once a minute poller that adds up the more terminals are registered. this potentially contributes to slowness. 

I question why this is actually needed once a minute and the associated lag, because a user experienced the lag if it causes it constantly, whereas it is designed as a once-in-a-million edge case detector. But you're CAUSING a constant bug just by having a detector active for a minor bug. 

Can we move it to an on-event detection?

soem ideas given by an agent:

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

## Proposed Changes
- TODO

## Verification Plan
- TODO

## Open Questions
- TODO
