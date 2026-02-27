#!/usr/bin/env node

/**
 * mcp-server.js — Switchboard MCP Server (Stdio)
 *
 * Architecture:
 *   - Stdio transport only: communicates with the VS Code extension via IPC
 *   - File-based state with proper-lockfile for concurrency safety
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');

const { loadState } = require("./state-manager");
const { registerTools, handleInternalRegistration } = require("./register-tools");

// --- Configuration ---
const WORKSPACE_ROOT = process.env.SWITCHBOARD_WORKSPACE_ROOT || process.cwd();
const SWITCHBOARD_DIR = path.join(WORKSPACE_ROOT, '.switchboard');

function formatErrorForLog(error) {
    if (error instanceof Error) {
        return error.stack || error.message;
    }
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}



// ============================================================
// Lifecycle Management (Zombie Prevention)
// ============================================================

function cleanup() {
    console.error('[MCP] Cleanup: shutting down...');
    if (process.stdin) { try { process.stdin.destroy(); } catch { /* ignore */ } }
    if (process.stdout) { try { process.stdout.destroy(); } catch { /* ignore */ } }
}

process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
});

process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
});

process.on('disconnect', () => {
    console.error('[MCP] Parent disconnected (VS Code reload/crash), shutting down...');
    cleanup();
    process.exit(0);
});

process.on('exit', () => {
    cleanup();
});

process.on('uncaughtException', (error) => {
    console.error(`[MCP] Uncaught exception: ${formatErrorForLog(error)}`);
});

process.on('unhandledRejection', (reason) => {
    console.error(`[MCP] Unhandled rejection: ${formatErrorForLog(reason)}`);
});

// --- Lifecycle Hooks & Background Tasks ---

// Zombie Reaper: Warn about long-running inactive terminals
setInterval(async () => {
    try {
        const state = await loadState();
        if (!state.terminals) return;

        const now = Date.now();
        const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000; // 12 Hours

        for (const [name, data] of Object.entries(state.terminals)) {
            const lastSeen = new Date(data.lastSeen).getTime();
            if (now - lastSeen > STALE_THRESHOLD_MS) {
                console.error(`[ZombieReaper] Warning: Terminal '${name}' (PID: ${data.pid}) has been active/registered for > 12 hours. Consider closing it if no longer needed.`);
            }
        }
    } catch (error) {
        console.error(`[ZombieReaper] Failed to run stale-terminal sweep: ${formatErrorForLog(error)}`);
    }
}, 60 * 60 * 1000); // Run every hour

// ============================================================
// Server Startup
// ============================================================

/**
 * Start the MCP server with Stdio transport (Library Mode — called by VS Code extension).
 * @param {StdioServerTransport} transport - The transport to use
 */
async function startServer(transport) {
    const server = new McpServer({
        name: "switchboard-mcp",
        version: "1.4.0"
    });
    registerTools(server);
    await server.connect(transport);
    console.error("Switchboard MCP Server running on stdio");
}

// Export for Library Mode (Extension bundling)
module.exports = { startServer };

// CLI Mode: Auto-start if invoked directly
if (require.main === module) {
    // 1. Start Stdio transport
    const stdioServer = new McpServer({
        name: "switchboard-mcp",
        version: "1.4.0"
    });
    registerTools(stdioServer);

    const transport = new StdioServerTransport();

    // Handle registration IPC from extension
    process.on('message', async (message) => {
        if (!message || typeof message !== 'object') return;

        if (message.type === 'registerTerminal') {
            try {
                await handleInternalRegistration(message);
                console.error(`[MCP] Terminal '${message.name}' registered via IPC.`);
            } catch (e) {
                console.error(`[MCP] IPC Registration failed: ${e.message}`);
            }
            return;
        }

        if (message.type === 'registerTerminalsBatch') {
            const registrations = Array.isArray(message.registrations) ? message.registrations : [];
            for (const reg of registrations) {
                try {
                    await handleInternalRegistration(reg);
                } catch (e) {
                    console.error(`[MCP] Batch registration failed for '${reg.name}': ${e.message}`);
                }
            }
            console.error(`[MCP] Batch registered ${registrations.length} terminal(s) via IPC.`);
            return;
        }

        if (message.type === 'pruneTerminal') {
            const statePath = path.join(SWITCHBOARD_DIR, 'state.json');
            try {
                if (!fs.existsSync(statePath)) return;
                const PRUNE_LOCK_OPTIONS = { retries: { retries: 5, minTimeout: 50, maxTimeout: 500 }, stale: 10000 };
                let release;
                try {
                    release = await lockfile.lock(statePath, PRUNE_LOCK_OPTIONS);
                    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                    if (state.terminals && state.terminals[message.name]) {
                        delete state.terminals[message.name];
                        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
                        console.error(`[MCP] Pruned stale terminal '${message.name}' from state.json.`);
                    }
                } finally {
                    if (release) await release();
                }
            } catch (e) {
                console.error(`[MCP] pruneTerminal failed for '${message.name}': ${e.message}`);
            }
            return;
        }

        if (message.type === 'healthProbe') {
            try {
                process.send?.({
                    type: 'healthProbeResponse',
                    id: message.id,
                    ok: true,
                    pid: process.pid
                });
            } catch (e) {
                console.error(`[MCP] Failed to respond to health probe: ${e.message}`);
            }
        }
    });

    stdioServer.connect(transport).then(() => {
        console.error("Switchboard MCP Server running on stdio");
    }).catch((error) => {
        console.error("Fatal error starting stdio:", error);
        process.exit(1);
    });

}

