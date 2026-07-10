#!/usr/bin/env node
// Switchboard MCP stdio server — entrypoint.
//
// A thin stdio MCP server that bridges Claude Desktop (and other MCP-only
// chat hosts) to Switchboard's LocalApiServer HTTP surface. Launched by the
// host as a subprocess on the user's machine, so 127.0.0.1 resolves to the
// same box running VS Code. Stateless: every tool call hits the live HTTP
// surface; the port is re-read on every call (listen(0) → fresh port per VS
// Code restart). Never crashes on a backend failure — errors become tool-level
// results and the process stays alive.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveWorkspaceRoot, resolveToken, logErr } from './bootstrap.js';
import { registerTools } from './tools.js';
import { CONSOLE_PERSONA, SERVER_INSTRUCTIONS } from './persona.js';

const VERSION = '0.1.0';

async function main(): Promise<void> {
    // Workspace root: arg (first positional) → env SWITCHBOARD_WORKSPACE_ROOT.
    const argRoot = process.argv[2];
    const workspaceRoot = resolveWorkspaceRoot(argRoot);
    if (!workspaceRoot) {
        logErr('No workspace root resolved. Pass it as the first argument or set SWITCHBOARD_WORKSPACE_ROOT.');
        logErr('Example: switchboard-mcp /path/to/workspace');
        // Do not exit immediately — a misconfigured server is still better
        // surfaced to the host as tool errors than as a crashed subprocess.
        // But without a root, no tool can work; exit with a clear stderr line.
        process.exit(64);
    }
    const token = resolveToken();

    const server = new McpServer(
        { name: 'switchboard-mcp', version: VERSION },
        { instructions: SERVER_INSTRUCTIONS }
    );

    registerTools(server, { workspaceRoot, token });

    // Opt-in persona prompt — the closest thing to on-demand persona on
    // Desktop (prompts surface only as explicit user-invoked slash commands).
    server.registerPrompt('switchboard_console', {
        description: 'Load the full Switchboard management-console persona (report-then-wait, no eager automation, no confirm gates, never ask about project pinning).'
    }, async () => ({
        messages: [{ role: 'user', content: { type: 'text', text: CONSOLE_PERSONA } }]
    }));

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logErr(`switchboard-mcp v${VERSION} ready (workspace: ${workspaceRoot}, token: ${token ? 'set' : 'none'})`);
}

main().catch((e) => {
    logErr(`Fatal: ${(e as Error).message}`);
    process.exit(1);
});
