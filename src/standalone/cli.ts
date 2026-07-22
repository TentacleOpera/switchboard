import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { spawn } from 'child_process';
import { startHeadlessSwitchboard } from './bootstrap';

function usage(): string {
    return `Usage: npx switchboard [options]

Options:
  --workspace <path>   Workspace root to serve (default: cwd)
  --port <number>      Preferred port; 0 for ephemeral (default: 0)
  --no-open            Do not open a browser
  --help               Show this help
`;
}

function parseArgs(argv: string[]): { workspace?: string; port?: number; noOpen: boolean; help: boolean } {
    const args = { noOpen: false, help: false } as any;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--workspace') { args.workspace = argv[++i]; }
        else if (a === '--port') { args.port = parseInt(argv[++i], 10); }
        else if (a === '--no-open') { args.noOpen = true; }
        else if (a === '--help' || a === '-h') { args.help = true; }
    }
    return args;
}

async function probeHealth(port: number, timeoutMs = 2000): Promise<boolean> {
    return new Promise(resolve => {
        const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    resolve(json.status === 'ok' && json.port === port);
                } catch { resolve(false); }
            });
        });
        req.on('error', () => resolve(false));
        req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch { } resolve(false); });
    });
}

async function findRunningInstance(workspaceRoot: string): Promise<number | null> {
    const portFile = path.join(workspaceRoot, '.switchboard', 'api-server-port.txt');
    if (!fs.existsSync(portFile)) return null;
    const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
    if (isNaN(port)) return null;
    if (await probeHealth(port)) return port;
    return null;
}

async function openBrowser(url: string): Promise<void> {
    const platform = process.platform;
    let cmd: string;
    const args: string[] = [];
    if (platform === 'darwin') { cmd = 'open'; args.push(url); }
    else if (platform === 'win32') { cmd = 'cmd'; args.push('/c', 'start', '', url); }
    else { cmd = 'xdg-open'; args.push(url); }
    try {
        const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        p.unref();
    } catch (err) {
        console.error(`[switchboard] Failed to open browser: ${err}`);
    }
}

async function waitForHealth(port: number, timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await probeHealth(port, 1000)) return;
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`Health check timed out on port ${port}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(usage());
        process.exit(0);
    }

    const workspaceRoot = path.resolve(args.workspace || process.cwd());
    if (!fs.existsSync(workspaceRoot)) {
        console.error(`[switchboard] Workspace does not exist: ${workspaceRoot}`);
        process.exit(1);
    }

    const switchboardDir = path.join(workspaceRoot, '.switchboard');
    if (!fs.existsSync(switchboardDir)) {
        fs.mkdirSync(switchboardDir, { recursive: true });
    }

    if (process.argv[2] === 'secrets') {
        const sub = process.argv[3];
        if (sub === 'set') {
            const secretKey = process.argv[4];
            const secretValue = process.argv[5];
            if (!secretKey || !secretValue) {
                console.error('Usage: npx switchboard secrets set <clickup|linear|notion|apiToken> <value>');
                process.exit(1);
            }
            const { StandaloneHostSecrets } = require('./hostServices');
            const secrets = new StandaloneHostSecrets(workspaceRoot);
            await secrets.store(secretKey, secretValue);
            console.log(`[switchboard] Secret '${secretKey}' saved securely to standalone store.`);
            process.exit(0);
        }
    }


    const existing = await findRunningInstance(workspaceRoot);
    if (existing !== null) {
        console.error(`[switchboard] Another Switchboard instance is already running on port ${existing} for ${workspaceRoot}.`);
        console.error(`[switchboard] Reusing is not supported (single writer). Use that instance or shut it down.`);
        process.exit(1);
    }

    const instance = await startHeadlessSwitchboard({
        workspaceRoot,
        port: args.port,
        verbose: true,
    });

    await waitForHealth(instance.port);

    const boardUrl = `${instance.url}/?token=${instance.oneTimeToken}`;

    console.log(`\nSwitchboard is running at ${instance.url}`);
    console.log(`Board URL (one-time token): ${boardUrl}`);
    console.log('Press Ctrl+C to stop.\n');

    if (!args.noOpen) {
        await openBrowser(boardUrl);
    }

    const shutdown = async () => {
        console.log('\n[switchboard] Shutting down...');
        try { await instance.stop(); } catch { /* ignore */ }
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep the process alive until interrupted
    await new Promise(() => { /* never resolves */ });
}

main().catch(err => {
    console.error('[switchboard] Fatal error:', err);
    process.exit(1);
});
