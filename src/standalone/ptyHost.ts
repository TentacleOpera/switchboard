import * as crypto from 'crypto';
import * as http from 'http';
import * as path from 'path';
import { parse as parseUrl } from 'url';
import { isPtyAvailable } from './ptyBackend';
import { PtyFleetService } from './ptyFleetService';
import { TerminalWsGateway } from './terminalWsGateway';
import { clearPty } from './ptyPromptDelivery';

interface PtyHostOptions {
    workspaceRoot: string;
}

export function parseArgs(args: string[]): PtyHostOptions {
    let workspaceRoot = process.cwd();
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--workspace' && i + 1 < args.length) {
            workspaceRoot = path.resolve(args[i + 1]);
            i++;
        }
    }
    return { workspaceRoot };
}

export async function runPtyHost(args: string[] = process.argv.slice(2)): Promise<void> {
    const { workspaceRoot } = parseArgs(args);

    if (!isPtyAvailable()) {
        console.error('[ptyHost] Error: node-pty is unavailable on this system.');
        process.exit(1);
    }

    const fleet = new PtyFleetService(workspaceRoot);
    const token = crypto.randomBytes(32).toString('hex');
    const gateway = new TerminalWsGateway(fleet, async () => token);

    const handlePtyVerb = async (verb: string, payload: any): Promise<any> => {
        switch (verb) {
            case 'ptyCreateTerminal': {
                const terminal = await fleet.create(
                    payload.role || 'coder',
                    payload.name,
                    payload.cwd,
                    payload.worktreePath
                );
                return {
                    success: true,
                    terminal: {
                        friendlyName: terminal.friendlyName,
                        role: terminal.role,
                        status: terminal.status
                    }
                };
            }
            case 'ptyCloseTerminal': {
                const ok = fleet.kill(payload.name);
                return { success: ok };
            }
            case 'ptyListTerminals': {
                return {
                    success: true,
                    terminals: fleet.list().map(t => ({
                        friendlyName: t.friendlyName,
                        role: t.role,
                        status: t.status,
                        pid: t.pty.pid,
                        startTime: t.startTime,
                        worktreePath: t.worktreePath
                    }))
                };
            }
            case 'ptyRenameTerminal': {
                const ok = fleet.rename(payload.name, payload.alias);
                return { success: ok };
            }
            case 'ptyClearTerminal': {
                const handle = fleet.get(payload.name);
                if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
                if (handle.status === 'active') { await clearPty(handle); }
                return { success: true };
            }
            case 'ptyClearAllTerminals': {
                const active = fleet.listActive();
                await Promise.all(active.map(t => clearPty(t)));
                return { success: true, cleared: active.length };
            }
            case 'ptyWrite': {
                const handle = fleet.get(payload.name);
                if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
                if (handle.status === 'active') {
                    handle.write(payload.data || '');
                    return { success: true };
                }
                return { success: false, error: `Terminal ${payload.name} is not active` };
            }
            default:
                return { success: false, error: `Unknown terminal verb '${verb}'` };
        }
    };

    const server = http.createServer((req, res) => {
        const parsed = parseUrl(req.url || '', true);
        if (req.method === 'POST' && parsed.pathname?.startsWith('/api/pty/')) {
            const verb = parsed.pathname.replace('/api/pty/', '');
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                let payload = {};
                if (body) {
                    try {
                        payload = JSON.parse(body);
                    } catch (e) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload' }));
                        return;
                    }
                }
                try {
                    const result = await handlePtyVerb(verb, payload);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
                }
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Not Found' }));
    });

    server.on('upgrade', (req, socket, head) => {
        gateway.handleUpgrade(req, socket, head);
    });

    // Parent death monitor
    const cleanupAndExit = () => {
        try {
            fleet.disposeAll();
        } catch (e) {
            // silent
        }
        process.exit(0);
    };

    process.on('SIGTERM', cleanupAndExit);
    process.on('SIGINT', cleanupAndExit);
    process.stdin.on('end', cleanupAndExit);
    process.stdin.resume();

    // Check parent process liveness if ppid is supported
    if (process.ppid) {
        const parentPid = process.ppid;
        const ppidInterval = setInterval(() => {
            try {
                // process.kill(pid, 0) throws if process doesn't exist (on POSIX)
                process.kill(parentPid, 0);
            } catch (e) {
                clearInterval(ppidInterval);
                cleanupAndExit();
            }
        }, 2000);
        ppidInterval.unref();
    }

    server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        const readyMessage = JSON.stringify({ t: 'ready', port, token });
        process.stdout.write(readyMessage + '\n');
    });
}

if (require.main === module) {
    runPtyHost().catch(err => {
        console.error('[ptyHost] Fatal error:', err);
        process.exit(1);
    });
}
