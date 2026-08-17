import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { parse as parseUrl } from 'url';
import { isPtyAvailable } from './ptyBackend';
import { PtyFleetService } from './ptyFleetService';
import { TerminalWsGateway } from './terminalWsGateway';
import { clearPty, modelPty, sendPromptToPty, writeSlashCommand } from './ptyPromptDelivery';

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

    // The extension host must set ELECTRON_RUN_AS_NODE=1 to run this script at all
    // (its process.execPath is the Electron binary). Electron has already consumed
    // the variable by the time this line runs, so dropping it here is free — and it
    // must be dropped, because node-pty hands process.env to every shell it spawns
    // and an operator terminal carrying ELECTRON_RUN_AS_NODE=1 silently breaks any
    // Electron app launched from it, `code` included.
    delete process.env.ELECTRON_RUN_AS_NODE;

    if (!isPtyAvailable()) {
        console.error('[ptyHost] Error: node-pty is unavailable on this system.');
        process.exit(1);
    }

    const fleet = new PtyFleetService(workspaceRoot);
    const token = crypto.randomBytes(32).toString('hex');
    const gateway = new TerminalWsGateway(fleet, async () => token);

    // Sweep pasted-image temp files older than 1 hour every 10 minutes. The
    // ptyPasteImage verb writes screenshots to os.tmpdir()/switchboard-paste/;
    // without this, long sessions accumulate files unbounded. .unref() so the
    // timer never holds the process open.
    const PASTE_TEMP_DIR = path.join(os.tmpdir(), 'switchboard-paste');
    const PASTE_TTL_MS = 60 * 60 * 1000; // 1 hour
    setInterval(async () => {
        try {
            const files = await fs.promises.readdir(PASTE_TEMP_DIR);
            const now = Date.now();
            for (const f of files) {
                const fp = path.join(PASTE_TEMP_DIR, f);
                const stat = await fs.promises.stat(fp);
                if (now - stat.mtimeMs > PASTE_TTL_MS) {
                    await fs.promises.unlink(fp).catch(() => {});
                }
            }
        } catch { /* dir may not exist yet */ }
    }, 10 * 60 * 1000).unref();

    const handlePtyVerb = async (verb: string, payload: any): Promise<any> => {
        switch (verb) {
            case 'ptyCreateTerminal': {
                const terminal = await fleet.create(
                    payload.role || 'coder',
                    payload.name,
                    payload.cwd,
                    payload.worktreePath,
                    payload.parentInstanceId,
                    undefined,
                    {
                        hidden: payload.hidden === true,
                        // Boolean off the wire, resolved by whichever host proxied us.
                        // Defaults to true if absent so a caller that predates this
                        // field still gets the fixed behaviour.
                        claudeInlineRendering: payload.claudeInlineRendering !== false
                    }
                    // No `startupCommand` from the wire. The per-child command is an
                    // arbitrary shell line the host executes in the user's tree; it
                    // comes from the Agents tab via the delegate definition and is
                    // passed in-process by spawnDelegates. Honouring a caller-supplied
                    // one turns this verb into a command-execution endpoint reachable
                    // by anything holding the API token — which every pty child is
                    // handed by design (SWITCHBOARD_API_TOKEN).
                );
                const rawDelegates = Array.isArray(payload.delegates) ? payload.delegates : [];
                const spawned = rawDelegates.length > 0
                    ? await fleet.spawnDelegates(terminal, rawDelegates, { teamName: payload.teamName })
                    : { children: [], error: undefined as string | undefined };
                return {
                    success: true,
                    terminal: {
                        friendlyName: terminal.friendlyName,
                        agentInstanceId: terminal.agentInstanceId,
                        parentInstanceId: terminal.parentInstanceId,
                        role: terminal.role,
                        status: terminal.status,
                        hidden: terminal.hidden === true
                    },
                    delegates: spawned.children.map(t => ({
                        friendlyName: t.friendlyName,
                        agentInstanceId: t.agentInstanceId,
                        role: t.role,
                        status: t.status
                    })),
                    ...(spawned.error ? { delegateError: spawned.error } : {})
                };
            }
            case 'ptyCreateBatch': {
                const result = await fleet.createBatch(
                    Array.isArray(payload.allocation) ? payload.allocation : [],
                    payload.hidden === true,
                    payload.cwd,
                    payload.worktreePath,
                    // Boolean off the wire, resolved by whichever host proxied us.
                    // Defaults to true if absent so a caller that predates this
                    // field still gets the fixed behaviour.
                    payload.claudeInlineRendering !== false
                );
                return {
                    success: result.success,
                    created: result.created,
                    failed: result.failed,
                    estimatedDurationMs: result.estimatedDurationMs,
                    ...(result.error ? { error: result.error } : {})
                };
            }
            case 'ptyCloseTerminal': {
                const ok = fleet.kill(payload.name);
                return { success: ok };
            }
            case 'ptyListTerminals': {
                // Hidden terminals ride a SIBLING `hiddenTerminals` key, just like
                // `liveness`. The rendered `terminals` array stays the safe projection
                // it has always been — every consumer that selects by role reads it.
                const all = fleet.list();
                const project = (terminals: any[]) => terminals.map(t => ({
                    friendlyName: t.friendlyName,
                    agentInstanceId: t.agentInstanceId,
                    parentInstanceId: t.parentInstanceId,
                    role: t.role,
                    status: t.status,
                    pid: t.pty.pid,
                    startTime: t.startTime,
                    worktreePath: t.worktreePath,
                    cwd: t.cwd,
                    lastDataAt: t.lastDataAt,
                }));
                return {
                    success: true,
                    terminals: project(all.filter(t => !t.hidden)),
                    hiddenTerminals: project(all.filter(t => t.hidden)),
                    liveness: fleet.getLiveness(),
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
            case 'ptySendModel': {
                const handle = fleet.get(payload.name);
                if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
                if (handle.status === 'active') { await modelPty(handle); }
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
                    const data: string = payload.data || '';
                    // Content rule, mirroring sendToTerminal / bootstrap: a single-line
                    // leading-slash write is a slash command, and every slash command gets
                    // the input line reset first. writeSlashCommand also takes the
                    // per-terminal lock, so the command cannot splice into an in-flight
                    // chunked paste from sendPromptToPty (it previously could).
                    const body = data.replace(/[\r\n]+$/, '');
                    if (body && !body.includes('\n') && body.trimStart().startsWith('/')) {
                        await writeSlashCommand(handle, body);
                    } else {
                        handle.write(data);
                    }
                    return { success: true };
                }
                return { success: false, error: `Terminal ${payload.name} is not active` };
            }
            case 'ptyPasteImage': {
                const handle = fleet.get(payload.name);
                if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
                if (handle.status !== 'active') { return { success: false, error: `Terminal ${payload.name} is not active` }; }

                const imageBuffer: Buffer = payload.imageBuffer;
                const mimeType: string = payload.mimeType || 'image/png';
                if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
                    return { success: false, error: 'Missing imageBuffer payload' };
                }

                // 4 MB ceiling — comfortably under the Anthropic API's hard 5 MB
                // per-image limit. An oversize image that reaches the CLI triggers
                // "session poisoning" (the rejected payload stays in history and
                // bricks every later turn), so rejecting HERE, before the path is
                // injected, is the safety boundary.
                const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
                if (imageBuffer.length > MAX_IMAGE_BYTES) {
                    return { success: false, error: `Image exceeds max size (${MAX_IMAGE_BYTES} bytes)` };
                }

                const ext = mimeType === 'image/jpeg' ? '.jpg'
                    : mimeType === 'image/gif' ? '.gif'
                    : mimeType === 'image/webp' ? '.webp'
                    : '.png';

                const tempDir = path.join(os.tmpdir(), 'switchboard-paste');
                try { await fs.promises.mkdir(tempDir, { recursive: true }); } catch { /* may already exist */ }

                const fileName = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
                const filePath = path.join(tempDir, fileName);
                await fs.promises.writeFile(filePath, imageBuffer);

                // Inject the file path into the PTY (no trailing newline — let the
                // user press Enter). '@' prefix is Claude Code's explicit file-load
                // signal; quote when the path contains whitespace (Windows temp dirs
                // can include spaces); bracketed-paste wrap keeps it as one paste
                // block — no premature execution, user can append descriptive text.
                const atPath = /\s/.test(filePath) ? `@"${filePath}"` : `@${filePath}`;
                handle.write(`\x1b[200~${atPath}\x1b[201~`);

                return { success: true, filePath };
            }
            case 'ptySendPrompt': {
                // Dispatch delivery, not a raw write. sendPromptToPty owns bracketed-paste
                // framing, chunked writes and the confirm CR — a raw write submits a
                // multi-line prompt line by line and the agent runs fragments.
                //
                // This verb exists so that machinery runs HERE rather than in the
                // extension: withTerminalLock is per-process state, so serialising two
                // concurrent dispatches is only possible on the side that owns the pty.
                const handle = fleet.get(payload.name);
                if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
                if (handle.status !== 'active') { return { success: false, error: `Terminal ${payload.name} is not active` }; }
                try {
                    await sendPromptToPty(handle, payload.data || '', {
                        clearBeforePrompt: payload.clearBeforePrompt === true,
                        clearBeforePromptDelayMs: typeof payload.clearBeforePromptDelayMs === 'number'
                            ? payload.clearBeforePromptDelayMs
                            : undefined
                    });
                    return { success: true };
                } catch (err) {
                    return { success: false, error: err instanceof Error ? err.message : String(err) };
                }
            }
            default:
                return { success: false, error: `Unknown terminal verb '${verb}'` };
        }
    };

    const server = http.createServer((req, res) => {
        const parsed = parseUrl(req.url || '', true);
        if (req.method === 'POST' && parsed.pathname?.startsWith('/api/pty/')) {
            const verb = parsed.pathname.replace('/api/pty/', '');

            // Raw binary body for ptyPasteImage — the extension host forwards the
            // image as application/octet-stream (a Buffer does not survive
            // JSON.stringify/parse). name + mimeType travel in the query string.
            if (verb === 'ptyPasteImage' && req.headers['content-type'] === 'application/octet-stream') {
                const chunks: Buffer[] = [];
                // Capped BEFORE buffering, not after Buffer.concat. handlePtyVerb's 4 MB
                // check is an image-policy ceiling that only runs once the whole body is
                // already in memory; this route takes unauthenticated loopback POSTs, so
                // an oversize body would OOM this child process and take every live PTY
                // in the fleet with it. 10 MB mirrors LocalApiServer's transport cap.
                const MAX_BODY_BYTES = 10 * 1024 * 1024;
                let totalBytes = 0;
                let aborted = false;
                req.on('data', (chunk: Buffer) => {
                    if (aborted) { return; }
                    totalBytes += chunk.length;
                    if (totalBytes > MAX_BODY_BYTES) {
                        aborted = true;
                        chunks.length = 0;
                        res.writeHead(413, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Image exceeds max size' }));
                        req.destroy();
                        return;
                    }
                    chunks.push(chunk);
                });
                req.on('end', async () => {
                    if (aborted) { return; }
                    const imageBuffer = Buffer.concat(chunks);
                    const payload = {
                        name: parsed.query.name || '',
                        mimeType: parsed.query.mimeType || 'image/png',
                        imageBuffer
                    };
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

    // Parent death monitor.
    //
    // A pty host that outlives a crashed extension host orphans every child shell and
    // nothing reaps them until reboot — strictly worse than the in-process status quo,
    // where the ptys died with the extension. The parent's disposal path does not run
    // on a crash by definition, so this has to live here.
    let exiting = false;
    const cleanupAndExit = () => {
        if (exiting) { return; }
        exiting = true;
        // Awaited, not fire-and-forget: disposeAll owns the SIGTERM → grace → SIGKILL
        // budget, and exiting underneath it sends SIGTERM and never lives to escalate.
        // The 1s cap keeps a wedged shell from holding the host open indefinitely; the
        // fleet's own `process.once('exit')` reaper is the hard backstop either way.
        void Promise.race([
            fleet.disposeAll(),
            new Promise(r => setTimeout(r, 1000))
        ]).catch(() => { /* reaped on exit regardless */ })
            .then(() => process.exit(0));
    };

    process.on('SIGTERM', cleanupAndExit);
    process.on('SIGINT', cleanupAndExit);
    // stdin is a pipe from the parent; EOF fires the moment the parent goes away.
    process.stdin.on('end', cleanupAndExit);
    process.stdin.resume();

    // Belt-and-braces for hosts where the stdin pipe outlives the parent.
    if (process.ppid) {
        const parentPid = process.ppid;
        const ppidInterval = setInterval(() => {
            try {
                // Signal 0 probes liveness without delivering anything.
                process.kill(parentPid, 0);
            } catch (e: any) {
                // EPERM means the pid EXISTS but is not ours (pid reuse by another
                // user) — treating that as death would reap a live session's shells.
                // Only ESRCH is proof the parent is gone.
                if (e && e.code !== 'ESRCH') { return; }
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
