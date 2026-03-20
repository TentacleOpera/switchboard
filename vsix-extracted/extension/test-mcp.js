const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

async function main() {
    const transport = new StdioClientTransport({
        command: 'uvx',
        args: ['--from', 'notebooklm-mcp-cli', 'notebooklm-mcp'],
    });

    const client = new Client(
        { name: 'test', version: '1.0.0' },
        { capabilities: {} }
    );

    await client.connect(transport);
    const tools = await client.listTools();
    console.log(JSON.stringify(tools, null, 2));
    await client.close();
}

main().catch(console.error);
