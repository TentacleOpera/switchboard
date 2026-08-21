import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as util from 'util';
import { spawn } from 'child_process';
import { startHeadlessSwitchboard } from './bootstrap';
import { DEFAULT_DISPLAY_HOSTNAME, isLoopbackHostname } from '../utils/loopbackHostname';

function usage(): string {
    return `Usage: npx switchboard [options]
       npx switchboard start [--detach] [--port <number>] [--hostname <name>] [--workspace <path>] [--no-open|--open]
       npx switchboard stop
       npx switchboard status [--json]
       npx switchboard logs [-f|--follow]
       npx switchboard init [--target <agents|claude|both>] [--workspace <path>]
       npx switchboard scaffold --parent-dir <dir> --workspace-name <name> --repo <url> [--repo <url>...] [--pat <token>] [--keep-sub-repo-db]
       npx switchboard control-plane <detect|preview|migrate> [parent-dir] [--cleanup <repo>...] [--cleanup-all]
       npx switchboard secrets set <clickup|linear|notion|stitch|apiToken|key> <value>
       npx switchboard secrets list
       npx switchboard secrets delete <clickup|linear|notion|stitch|apiToken|key>
       npx switchboard token show
       npx switchboard token set <value>
       npx switchboard token rotate
       npx switchboard token clear

Aliases for secrets commands:
  clickup   -> switchboard.clickup.apiToken
  linear    -> switchboard.linear.apiToken
  notion    -> switchboard.notion.apiToken
  stitch    -> switchboard.stitch.apiKey
  apiToken  -> switchboard.apiToken

Options:
  --workspace <path>   Workspace root to serve or init (default: cwd)
  --port <number>      Preferred port; 0 for ephemeral (default: 7777)
  --hostname <name>    Hostname for the board URL (default: ${DEFAULT_DISPLAY_HOSTNAME},
                       falling back to 127.0.0.1 if that name is unreachable).
                       Must be a loopback name: localhost, 127.0.0.1, or anything
                       under the reserved .localhost TLD, e.g. ${DEFAULT_DISPLAY_HOSTNAME}
  --detach             start: run in background (detached). Implies --no-open unless --open is given.
  --no-open            Do not open a browser
  --open               start --detach: open a browser anyway (overrides implied --no-open)
  --json               status: machine-readable JSON output
  -f, --follow         logs: tail live output
  --target <name>      Protocol target for 'init': agents, claude, or both (default: both)
  --pat <token>        PAT for cloning (visible in process list — prefer SWITCHBOARD_PAT env var)
  --keep-sub-repo-db   Keep an existing sub-repo kanban.db instead of deleting it (headless default: delete)
  --cleanup <repo>     migrate: archive the named source repo's .switchboard/ after merging (repeatable)
  --cleanup-all        migrate: archive ALL source repos' .switchboard/ after merging
  --help               Show this help
`;
}

const SECRET_ALIASES: Record<string, string> = {
    clickup: 'switchboard.clickup.apiToken',
    linear: 'switchboard.linear.apiToken',
    notion: 'switchboard.notion.apiToken',
    stitch: 'switchboard.stitch.apiKey',
    apiToken: 'switchboard.apiToken',
};

/**
 * Resolve a CLI secret argument to the key a service actually reads, or exit.
 *
 * The bug this command exists to fix was writing a token under a key nothing
 * reads, so a bare unrecognised word must be a hard error rather than a
 * pass-through. Fully-qualified keys (anything dotted) still pass through as the
 * escape hatch for keys the alias table has not caught up with.
 */
function resolveSecretKey(inputKey: string): string {
    const aliased = SECRET_ALIASES[inputKey];
    if (aliased) { return aliased; }
    if (inputKey.includes('.')) { return inputKey; }
    console.error(`Unknown secret name '${inputKey}'. Use one of:`);
    for (const [alias, resolved] of Object.entries(SECRET_ALIASES)) {
        console.error(`  ${alias.padEnd(9)} -> ${resolved}`);
    }
    console.error('...or pass a fully-qualified key such as switchboard.clickup.apiToken.');
    process.exit(1);
}

function parseArgs(argv: string[]): { workspace?: string; port?: number; hostname?: string; noOpen: boolean; open: boolean; detach: boolean; help: boolean } {
    const args = { noOpen: false, open: false, detach: false, help: false, port: 7777 } as any;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--workspace') { args.workspace = argv[++i]; }
        else if (a === '--port') { args.port = parseInt(argv[++i], 10); }
        else if (a === '--hostname') { args.hostname = argv[++i]; }
        else if (a === '--no-open') { args.noOpen = true; }
        else if (a === '--open') { args.open = true; }
        else if (a === '--detach') { args.detach = true; }
        else if (a === '--help' || a === '-h') { args.help = true; }
    }
    return args;
}

/**
 * Reject a `--hostname` the server would 403 on, at parse time.
 *
 * The failure this prevents is silent and expensive: a non-loopback name would
 * print an inviting URL, open a browser, and then hit the DNS-rebinding guard —
 * burning the one-time token on a request that can never succeed.
 */
function resolveHostname(input: string | undefined): string | undefined {
    if (input === undefined) { return undefined; }
    const candidate = input.trim().toLowerCase();
    if (!isLoopbackHostname(candidate)) {
        console.error(`[switchboard] --hostname '${input}' is not a loopback name.`);
        console.error('Switchboard binds 127.0.0.1 only, so the hostname must resolve there:');
        console.error('  127.0.0.1, localhost, or any name under the reserved .localhost TLD');
        console.error('  e.g. --hostname switchboard.localhost');
        process.exit(1);
    }
    return candidate;
}

/**
 * Expand a leading `~` the way the scaffolding services do.
 *
 * `--parent-dir`/`<parent-dir>` reach the services through
 * `MultiRepoScaffoldingService._normalizeOptions` (expandHome + path.resolve), so the
 * CLI must resolve them the same way before installing the shim workspace root —
 * otherwise the root points at a literal `./~/...` that holds no config.
 */
function expandHomePath(input: string): string {
    if (input === '~') { return os.homedir(); }
    if (input.startsWith('~/') || input.startsWith('~\\')) {
        return path.join(os.homedir(), input.slice(2));
    }
    return input;
}

/**
 * Exit only once stdout has drained.
 *
 * `process.exit()` discards queued async writes, and when stdout is a pipe (rather
 * than a TTY) Node buffers asynchronously — so `control-plane preview <dir> | jq`
 * could lose the JSON that is the entire product of the command. A hard exit is still
 * required: the DB services leave handles behind, so returning normally is not
 * guaranteed to end the process.
 */
function exitFlushed(code: number): never {
    if (process.stdout.writableLength === 0) {
        process.exit(code);
    }
    process.stdout.write('', () => process.exit(code));
    // Belt-and-braces: if the drain callback never fires, do not hang forever.
    setTimeout(() => process.exit(code), 2000).unref();
    return undefined as never;
}

/**
 * Drain pending kanban.db writes for `workspaceRoot`, then exit.
 *
 * `KanbanDatabase._persist()` does NOT write — it arms a 300 ms trailing debounce and
 * returns true immediately (KanbanDatabase.ts:9056). So a one-shot command that exits
 * as soon as `createIfMissing()`/`executeMigration()` resolves kills the process before
 * the export()+atomic-rename ever runs: `init` reported a created DB and left no
 * kanban.db on disk at all. `invalidateWorkspace` is the existing drain — it awaits the
 * in-flight write tail, flushes the pending coalesced persist, then closes the handle.
 * The long-running server path does not need this (its debounce fires normally).
 */
/**
 * Send every stdout-bound console channel to stderr for the rest of the process.
 *
 * `control-plane detect|preview|migrate` exist to put machine-readable JSON on stdout,
 * but the services they call narrate constantly: `KanbanDatabase._loadSqlJs` logs five
 * lines per DB open, V17/V18 report skipped migration steps via console.debug and
 * V27/V29 via console.info. In Node **log, info and debug all write to stdout** — so all
 * three have to move, not just console.log — otherwise that chatter prefixes the payload
 * and `npx switchboard control-plane preview <dir> | jq` fails on invalid JSON.
 *
 * Deliberately never restored: background DB work (board-mirror and state-backup writes)
 * reopens the database and logs *after* the awaited call returns, so scoping the redirect
 * to the service call still lets a late line race the payload. These handlers always
 * exit, so a one-way redirect is safe. warn/error already go to stderr and are untouched.
 */
function routeLogsToStderr(): void {
    const toStderr = (...args: unknown[]): void => { console.error(...args); };
    console.log = toStderr;
    console.info = toStderr;
    console.debug = toStderr;
}

/** Write a JSON payload to stdout directly, bypassing the redirected console.log. */
function emitJson(payload: unknown): void {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Size cap before the active log file is rotated to `server.log.1`.
 *
 * 10 MiB is enough for a multi-day orchestration run of startup banners,
 * status lines, and error output — the high-volume PTY chatter goes through
 * the WS gateway, not console.log. One rotation keeps the cap at ~20 MiB
 * total (active + .1) rather than growing without bound.
 */
const LOG_CAP_BYTES = 10 * 1024 * 1024;

/**
 * Wrap every console channel to also write to `.switchboard/logs/server.log`.
 *
 * In foreground mode (`alsoStdout = true`) output goes to both the terminal
 * and the file, so the two modes report identically. In detached mode
 * (`alsoStdout = false`, stdout is /dev/null) only the file is written.
 *
 * Rotation: on each write the current file size is checked. If it exceeds
 * `LOG_CAP_BYTES`, the existing file is renamed to `server.log.1` (replacing
 * any previous rotation) and a fresh file is opened. The write stream is
 * reopened on every line via `appendFileSync`, so rotation never loses the
 * active handle — there is no long-lived fd to reopen.
 */
function setupFileLogging(logFile: string, alsoStdout: boolean): void {
    const origLog = console.log.bind(console);
    const origInfo = console.info.bind(console);
    const origDebug = console.debug.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);

    const writeToFile = (msg: string): void => {
        try {
            try {
                const stat = fs.statSync(logFile);
                if (stat.size > LOG_CAP_BYTES) {
                    try { fs.unlinkSync(`${logFile}.1`); } catch { /* no prior rotation */ }
                    try { fs.renameSync(logFile, `${logFile}.1`); } catch { /* rename failed — keep writing */ }
                }
            } catch { /* file does not exist yet */ }
            fs.appendFileSync(logFile, msg);
        } catch { /* logging must never crash the server */ }
    };

    const wrap = (orig: (...args: unknown[]) => void): ((...args: unknown[]) => void) => {
        return (...args: unknown[]) => {
            const msg = `${util.format(...args)}\n`;
            writeToFile(msg);
            if (alsoStdout) { orig(...args); }
        };
    };

    // log, info, and debug all write to stdout in Node — wrap all three so the
    // file captures everything routeLogsToStderr would redirect.
    console.log = wrap(origLog);
    console.info = wrap(origInfo);
    console.debug = wrap(origDebug);
    console.warn = wrap(origWarn);
    console.error = wrap(origError);
}

async function flushWorkspaceDb(workspaceRoot: string): Promise<void> {
    try {
        const { KanbanDatabase } = require('../services/KanbanDatabase');
        await KanbanDatabase.invalidateWorkspace(workspaceRoot);
    } catch (err) {
        console.error(`[switchboard] Warning: could not flush the kanban database: ${err instanceof Error ? err.message : String(err)}`);
    }
}

async function probeHealth(port: number, hostname = '127.0.0.1', timeoutMs = 2000): Promise<boolean> {
    try {
        const json = await getHealthJson(port, hostname, timeoutMs);
        return json.port === port;
    } catch { return false; }
}

/**
 * Fetch and parse the /health JSON from a running Switchboard instance.
 *
 * Rejects if the endpoint is unreachable or does not identify as a switchboard
 * service — callers must never signal a PID based on a port that a non-switchboard
 * process happens to be listening on.
 */
async function getHealthJson(port: number, hostname = '127.0.0.1', timeoutMs = 2000): Promise<{
    service: string; status: string; port: number; pid: number; roots: string[];
    terminals?: string[]; terminalCount?: number; selectedWorkspaceRoot?: string | null;
}> {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://${hostname}:${port}/health`, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    if (json.service === 'switchboard' && json.status === 'ok') {
                        resolve(json);
                    } else {
                        reject(new Error('Health endpoint did not identify as switchboard'));
                    }
                } catch (err) { reject(err); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch { } reject(new Error('Health check timed out')); });
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
        if (await probeHealth(port, '127.0.0.1', 1000)) return;
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

    // `scaffold` and `control-plane` operate on a directory named by their own
    // arguments and never touch the cwd. Creating .switchboard/ here would leave a
    // stray control-plane marker in whatever directory the command was launched from
    // — including $HOME, which `isAllowedSwitchboardLocation` exists to keep out.
    // `stop`, `status`, and `logs` are read-only queries against an existing
    // .switchboard/ — they must not create one in a directory that has none.
    // Every other path (server start, secrets, init) does use workspaceRoot.
    const subcommand = process.argv[2];
    const subcommandTargetsCwd = subcommand !== 'scaffold' && subcommand !== 'control-plane'
        && subcommand !== 'stop' && subcommand !== 'status' && subcommand !== 'logs';
    const switchboardDir = path.join(workspaceRoot, '.switchboard');
    if (subcommandTargetsCwd && !fs.existsSync(switchboardDir)) {
        fs.mkdirSync(switchboardDir, { recursive: true });
    }

    if (process.argv[2] === 'secrets') {
        const sub = process.argv[3];
        const { createStandaloneHostSecrets } = require('./hostServices');
        const secrets = createStandaloneHostSecrets(workspaceRoot);

        if (sub === 'set') {
            const rawKey = process.argv[4];
            const secretValue = process.argv[5];
            if (!rawKey || !secretValue) {
                console.error('Usage: npx switchboard secrets set <clickup|linear|notion|stitch|apiToken|key> <value>');
                process.exit(1);
            }
            const secretKey = resolveSecretKey(rawKey);
            await secrets.store(secretKey, secretValue);
            console.log(`[switchboard] Secret '${secretKey}' saved securely to standalone store.`);
            process.exit(0);
        } else if (sub === 'list') {
            const keys = await secrets.keys();
            if (keys.length === 0) {
                console.log('[switchboard] No secrets stored in standalone store.');
            } else {
                console.log('[switchboard] Stored secrets (keys only):');
                for (const k of keys) {
                    console.log(`  - ${k}`);
                }
            }
            process.exit(0);
        } else if (sub === 'delete' || sub === 'rm') {
            const rawKey = process.argv[4];
            if (!rawKey) {
                console.error('Usage: npx switchboard secrets delete <clickup|linear|notion|stitch|apiToken|key>');
                process.exit(1);
            }
            const secretKey = resolveSecretKey(rawKey);
            await secrets.delete(secretKey);
            console.log(`[switchboard] Secret '${secretKey}' deleted from standalone store.`);
            process.exit(0);
        } else {
            console.error(`Unknown secrets subcommand '${sub}'.`);
            console.error(usage());
            process.exit(1);
        }
    }


    if (process.argv[2] === 'token') {
        const sub = process.argv[3];
        const { createStandaloneHostSecrets } = require('./hostServices');
        const secrets = createStandaloneHostSecrets(workspaceRoot);

        if (sub === 'show') {
            // Mint a fresh single-use enrolment token against a running instance.
            // Resolves the port through findRunningInstance so it cannot print a URL
            // for a dead server. In ephemeral mode (no durable token stored), minting
            // is refused with a clear message — the boot-time URL is the only route.
            const port = await findRunningInstance(workspaceRoot);
            if (port === null) {
                console.error('[switchboard] No running Switchboard instance found for this workspace.');
                console.error('[switchboard] Start one with `npx switchboard`, then run `token show` to enrol a second device or re-enter after cookie expiry.');
                process.exit(1);
            }
            const storedToken = await secrets.get('switchboard.apiToken');
            const trimmed = (storedToken || '').trim();
            if (!trimmed) {
                console.error('[switchboard] No durable session token is configured. Minting is unavailable in ephemeral mode.');
                console.error('[switchboard] Set one with `npx switchboard token set <value>` or `npx switchboard token rotate`, then restart the server.');
                process.exit(1);
            }
            // POST /auth/mint with the durable secret as Bearer auth.
            const mintUrl = `http://127.0.0.1:${port}/auth/mint`;
            const req = http.request(mintUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${trimmed}`,
                    'Content-Length': 0,
                },
                timeout: 5000,
            }, (mres) => {
                let body = '';
                mres.on('data', (c: Buffer) => body += c.toString());
                mres.on('end', () => {
                    if (mres.statusCode === 200) {
                        try {
                            const json = JSON.parse(body);
                            console.log(`[switchboard] Board URL (single-use, expires in 15 minutes):`);
                            console.log(json.boardUrl || `http://127.0.0.1:${port}/?token=${json.token}`);
                        } catch {
                            console.error('[switchboard] Unexpected response from server.');
                            process.exit(1);
                        }
                    } else if (mres.statusCode === 503) {
                        try {
                            const json = JSON.parse(body);
                            console.error(`[switchboard] ${json.detail || 'Minting unavailable.'}`);
                        } catch {
                            console.error('[switchboard] Minting unavailable.');
                        }
                        process.exit(1);
                    } else if (mres.statusCode === 401) {
                        console.error('[switchboard] Authentication failed — the stored token does not match the running server\'s session token.');
                        console.error('[switchboard] The server may have been started with a different token, or the token was rotated. Restart the server after updating the token.');
                        process.exit(1);
                    } else {
                        console.error(`[switchboard] Unexpected status ${mres.statusCode} from server.`);
                        process.exit(1);
                    }
                });
            });
            req.on('error', (err) => {
                console.error(`[switchboard] Failed to contact running server: ${err.message}`);
                process.exit(1);
            });
            req.on('timeout', () => { req.destroy(); });
            req.end();
            // Wait for the response to drain before exiting — the http callback
            // calls process.exit() internally, so this await just keeps the event
            // loop alive until the response arrives.
            await new Promise<void>((resolve) => {
                req.on('close', () => resolve());
            });
        } else if (sub === 'set') {
            const value = process.argv[4];
            if (!value) {
                console.error('Usage: npx switchboard token set <value>');
                process.exit(1);
            }
            await secrets.store('switchboard.apiToken', value);
            console.log('[switchboard] Durable session token saved. Live sessions will be invalidated on next server restart.');
            console.log('[switchboard] Restart the running server for the new token to take effect.');
            process.exit(0);
        } else if (sub === 'rotate') {
            const newToken = crypto.randomBytes(32).toString('hex');
            await secrets.store('switchboard.apiToken', newToken);
            console.log('[switchboard] Durable session token rotated. Live sessions will be invalidated on next server restart.');
            console.log('[switchboard] Restart the running server for the new token to take effect.');
            process.exit(0);
        } else if (sub === 'clear') {
            await secrets.delete('switchboard.apiToken');
            console.log('[switchboard] Durable session token cleared. The server will use an ephemeral per-launch token on next restart.');
            process.exit(0);
        } else {
            console.error(`Unknown token subcommand '${sub}'.`);
            console.error(usage());
            process.exit(1);
        }
    }


    if (process.argv[2] === 'init') {
        const { __setStandaloneWorkspaceRoot } = require('./vscodeShim');
        const { ControlPlaneMigrationService } = require('../services/ControlPlaneMigrationService');
        const { KanbanDatabase } = require('../services/KanbanDatabase');
        const { StandaloneHostPathConfigProvider } = require('./hostServices');
        const { ensureWorkspaceIdentity } = require('../services/WorkspaceIdentityService');

        let target: string = 'both';
        let targetExplicit = false;
        for (let i = 3; i < process.argv.length; i++) {
            if (process.argv[i] === '--target' && process.argv[i + 1]) {
                target = process.argv[++i];
                targetExplicit = true;
            }
        }
        if (targetExplicit && !['agents', 'claude', 'both'].includes(target)) {
            console.error(`[switchboard] --target must be 'agents', 'claude', or 'both' (got '${target}')`);
            process.exit(1);
        }

        __setStandaloneWorkspaceRoot(workspaceRoot);

        const configProvider = new StandaloneHostPathConfigProvider(workspaceRoot);
        KanbanDatabase.setPathConfigProvider(configProvider);
        if (targetExplicit) {
            // Persist via the EXISTING provider write path so _getProtocolTargets honours
            // --target (the shim reads switchboard.protocol.target from
            // .switchboard/config.json). Do NOT use getConfiguration().update() — the
            // shim's update() is a deliberate no-op (vscodeShim.ts:178).
            await configProvider.updateConfigWorkspace('protocol.target', target);
        } else {
            // No --target: adopt whatever the workspace already declares. Writing the
            // 'both' default unconditionally would silently clobber an existing
            // 'agents'/'claude' pin on every re-init and then seed the very protocol
            // layer the user excluded — init is required to be re-runnable safely.
            target = configProvider.getConfigStringWithDefault('protocol.target', 'both');
        }
        // Mirror _getProtocolTargets' exact derivation (ControlPlaneMigrationService.ts:752)
        // so the report cannot claim a layer the bootstrap did not scaffold — including
        // the case where a config value is neither 'agents', 'claude', nor 'both'.
        const reportAgents = target === 'agents' || target === 'both';
        const reportClaude = target === 'claude' || target === 'both';

        const repoRoot = path.resolve(__dirname, '..', '..');

        console.log(`[switchboard] Initialising Switchboard scaffolding in ${workspaceRoot} (target: ${target})…`);

        try {
            await ControlPlaneMigrationService.bootstrapControlPlaneLayout(workspaceRoot, repoRoot);

            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            const dbExisted = fs.existsSync(db.dbPath);
            const dbCreated = await db.createIfMissing();
            if (!dbCreated) {
                console.error(`[switchboard] Failed to create kanban database at ${db.dbPath}.`);
                process.exit(1);
            }
            if (dbExisted) {
                console.log(`[switchboard] Existing kanban.db kept (${db.dbPath}).`);
            }

            await ensureWorkspaceIdentity(workspaceRoot);

            // Land the DB before reporting. createIfMissing()'s _persist() only arms a
            // trailing debounce, so both the report below and the process exit would
            // otherwise race the actual write — and win, leaving no kanban.db at all.
            await flushWorkspaceDb(workspaceRoot);

            // bootstrapControlPlaneLayout silently skips the bundled-file copy when the
            // package root lacks .agents/ (ControlPlaneMigrationService.ts:693); AGENTS.md
            // and the CLAUDE.md seed are gated on <repoRoot>/AGENTS.md separately (:703,
            // :729), so both have to be checked or init reports files it never wrote.
            const missingBundled: string[] = [];
            if (!fs.existsSync(path.join(repoRoot, '.agents'))) { missingBundled.push('.agents/'); }
            if (!fs.existsSync(path.join(repoRoot, 'AGENTS.md'))) { missingBundled.push('AGENTS.md'); }
            if (missingBundled.length > 0) {
                console.warn(`[switchboard] Warning: bundled ${missingBundled.join(' and ')} not found at ${repoRoot}. Directory structure created, but those protocol files were not copied.`);
            }

            // Report what is actually on disk rather than what was requested.
            const reportLine = (relativePath: string, label: string): void => {
                if (fs.existsSync(path.join(workspaceRoot, relativePath))) {
                    console.log(`[switchboard]   ${label}`);
                }
            };

            console.log('[switchboard] Scaffolding complete.');
            console.log('[switchboard]   .switchboard/  (plans, inbox, archive)');
            reportLine(path.join('.switchboard', 'kanban.db'), '.switchboard/kanban.db');
            reportLine('.agents', '.agents/       (workflows, skills)');
            if (reportAgents) { reportLine('AGENTS.md', 'AGENTS.md      (protocol file)'); }
            if (reportClaude) {
                reportLine('CLAUDE.md', 'CLAUDE.md      (Claude Code managed block)');
                reportLine(path.join('.claude', 'skills'), '.claude/skills (mirror)');
            }
            reportLine('worktrees', 'worktrees/');
            if (!fs.existsSync(path.join(workspaceRoot, '.git'))) {
                console.log(`[switchboard] Note: no git repository detected in ${workspaceRoot}.`);
            }
            exitFlushed(0);
        } catch (err) {
            console.error(`[switchboard] Init failed: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    }

    if (process.argv[2] === 'scaffold') {
        const { __setStandaloneWorkspaceRoot } = require('./vscodeShim');
        const { MultiRepoScaffoldingService } = require('../services/MultiRepoScaffoldingService');
        const { StandaloneHostPathConfigProvider } = require('./hostServices');
        const { KanbanDatabase } = require('../services/KanbanDatabase');

        let parentDir = '';
        let workspaceName = '';
        let repoUrls: string[] = [];
        let pat = process.env.SWITCHBOARD_PAT || '';
        let subRepoDbAction: 'delete' | 'keep' = 'delete';
        for (let i = 3; i < process.argv.length; i++) {
            const a = process.argv[i];
            if (a === '--parent-dir') { parentDir = process.argv[++i]; }
            else if (a === '--workspace-name') { workspaceName = process.argv[++i]; }
            else if (a === '--repo') { repoUrls.push(process.argv[++i]); }
            else if (a === '--pat') {
                pat = process.argv[++i];
                console.warn('[switchboard] --pat is visible in the process list. Prefer SWITCHBOARD_PAT env var.');
            }
            else if (a === '--keep-sub-repo-db') { subRepoDbAction = 'keep'; }
        }

        if (!parentDir) { console.error('Usage: npx switchboard scaffold --parent-dir <dir> --workspace-name <name> --repo <url> [--repo <url>...]'); process.exit(1); }
        if (!workspaceName) { console.error('--workspace-name is required'); process.exit(1); }
        if (repoUrls.length === 0) { console.error('At least one --repo <url> is required'); process.exit(1); }
        if (!pat) { console.error('PAT is required. Pass --pat <token> or set SWITCHBOARD_PAT env var.'); process.exit(1); }

        // The scaffold target — not the cwd — is the workspace these services resolve
        // config against. `bootstrapControlPlaneLayout` → `_getProtocolTargets` reads
        // switchboard.protocol.target through the shim, which ignores the Uri scope it is
        // handed and uses this root; `KanbanDatabase.forWorkspace` asks the path provider
        // for kanban.dbPath. Rooted at the cwd, a stray protocol.target or kanban.dbPath
        // belonging to the directory the command was launched from would silently govern
        // the layout of — or relocate the DB of — the control plane being created.
        const scaffoldRoot = path.resolve(expandHomePath(parentDir));
        __setStandaloneWorkspaceRoot(scaffoldRoot);
        KanbanDatabase.setPathConfigProvider(new StandaloneHostPathConfigProvider(scaffoldRoot));
        const repoRoot = path.resolve(__dirname, '..', '..');

        console.log(`[switchboard] Scaffolding multi-repo control plane into ${scaffoldRoot}…`);
        const result = await MultiRepoScaffoldingService.scaffold(
            { parentDir, workspaceName, repoUrls, pat, headlessDefaults: { subRepoDbAction } },
            repoRoot
        );

        // The control-plane DB _doScaffold created is only debounce-armed, not written.
        await flushWorkspaceDb(scaffoldRoot);

        for (const repo of result.repos) {
            const tag = repo.status === 'cloned' ? '✓' : repo.status === 'skipped' ? '○' : '✗';
            console.log(`  ${tag} ${repo.dir} — ${repo.status}${repo.error ? ': ' + repo.error : ''}`);
        }
        if (result.warnings?.length) {
            console.log('Warnings:');
            for (const w of result.warnings) { console.log(`  ! ${w}`); }
        }
        // The service is lazily `require`d above, so `result` is untyped here — annotate
        // the callback param rather than widening noImplicitAny.
        const anyFailed = result.repos.some((r: { status: string }) => r.status === 'failed');
        if (result.success) {
            console.log(`\n[switchboard] Workspace file: ${result.workspaceFilePath}`);
            console.log(`[switchboard] Open with: code "${result.workspaceFilePath}"`);
            exitFlushed(anyFailed ? 1 : 0);
        } else {
            console.error(`\n[switchboard] Scaffold failed: ${result.error || 'unknown error'}`);
            exitFlushed(1);
        }
    }

    if (process.argv[2] === 'control-plane') {
        const sub = process.argv[3];
        const { __setStandaloneWorkspaceRoot } = require('./vscodeShim');
        const { ControlPlaneMigrationService } = require('../services/ControlPlaneMigrationService');
        const { StandaloneHostPathConfigProvider } = require('./hostServices');
        const { KanbanDatabase } = require('../services/KanbanDatabase');

        if (sub !== 'detect' && sub !== 'preview' && sub !== 'migrate') {
            console.error('Usage: npx switchboard control-plane <detect|preview|migrate> [parent-dir] [--cleanup <repo>...] [--cleanup-all]');
            process.exit(1);
        }

        // Parsed before the shim root is installed: preview/migrate operate on the named
        // parent dir, and that dir — not the cwd — is the root the services must resolve
        // config against (see the scaffold block for why).
        const positional: string[] = [];
        const cleanupRepos: string[] = [];
        let cleanupAll = false;
        for (let i = 4; i < process.argv.length; i++) {
            const a = process.argv[i];
            if (a === '--cleanup') { cleanupRepos.push(process.argv[++i]); }
            else if (a === '--cleanup-all') { cleanupAll = true; }
            else { positional.push(a); }
        }

        if (sub !== 'detect' && !positional[0]) {
            console.error(`Usage: npx switchboard control-plane ${sub} <parent-dir>${sub === 'migrate' ? ' [--cleanup <repo>...] [--cleanup-all]' : ''}`);
            process.exit(1);
        }

        // `detect` scans the parent of the current workspace, so it keeps the cwd root.
        const parentDir = sub === 'detect' ? workspaceRoot : path.resolve(expandHomePath(positional[0]));
        __setStandaloneWorkspaceRoot(parentDir);
        KanbanDatabase.setPathConfigProvider(new StandaloneHostPathConfigProvider(parentDir));
        const repoRoot = path.resolve(__dirname, '..', '..');

        // stdout is this subcommand's data channel from here on.
        routeLogsToStderr();

        if (sub === 'detect') {
            const candidate = await ControlPlaneMigrationService.detectCandidateParent(workspaceRoot);
            emitJson(candidate);
            exitFlushed(0);
        } else if (sub === 'preview') {
            const preview = await ControlPlaneMigrationService.previewMigration(parentDir);
            emitJson(preview);
            exitFlushed(0);
        } else {
            let cleanupConfirmed = cleanupRepos;
            if (cleanupAll) {
                const preview = await ControlPlaneMigrationService.previewMigration(parentDir);
                cleanupConfirmed = [...new Set([...cleanupRepos, ...preview.sources.map((s: { repoName: string }) => s.repoName)])];
            }

            const result = await ControlPlaneMigrationService.executeMigration(parentDir, {
                extensionPath: repoRoot,
                cleanupConfirmed
            });
            // executeMigration merges source rows and imports plan files into the parent
            // DB; every one of those writes is debounce-armed, so drain before exiting.
            await flushWorkspaceDb(parentDir);

            emitJson(result);
            if (result.success) {
                // Warnings go to stderr so stdout stays parseable JSON.
                console.warn('[switchboard] Note: integration sync of imported plans is deferred — open this workspace in the VS Code extension to sync ClickUp/Linear.');
                if (result.workspaceFilePath) {
                    console.warn(`[switchboard] Workspace file: ${result.workspaceFilePath}`);
                }
            }
            exitFlushed(result.success ? 0 : 1);
        }
    }

    // ── stop ───────────────────────────────────────────────────────
    if (process.argv[2] === 'stop') {
        const port = await findRunningInstance(workspaceRoot);
        if (port === null) {
            console.error('[switchboard] No running Switchboard instance found for this workspace.');
            process.exit(1);
        }
        // /health is authoritative for the PID — never signal based on the PID
        // file alone. A recycled PID could point at an innocent process.
        let health: Awaited<ReturnType<typeof getHealthJson>> | undefined;
        try {
            health = await getHealthJson(port);
        } catch (err) {
            console.error(`[switchboard] Found port file (port ${port}) but could not confirm server identity via /health: ${err instanceof Error ? err.message : String(err)}`);
            console.error('[switchboard] Refusing to signal — the PID may be stale. Remove .switchboard/api-server-port.txt manually if the server is known to be dead.');
            process.exit(1);
        }
        if (!health) { process.exit(1); }
        const pid = health.pid;
        console.log(`[switchboard] Stopping server (PID ${pid}, port ${port})…`);

        try { process.kill(pid, 'SIGTERM'); } catch (err) {
            console.error(`[switchboard] Failed to send SIGTERM to PID ${pid}: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }

        // Grace period: the debounced kanban.db persist (300 ms trailing) plus
        // the export/atomic-rename must complete before a SIGKILL would abandon it.
        // 5 seconds is conservative — 300 ms debounce + ~50 ms rename + margin.
        const GRACE_MS = 5000;
        const start = Date.now();
        let stopped = false;
        while (Date.now() - start < GRACE_MS) {
            if (!await probeHealth(port, '127.0.0.1', 500)) { stopped = true; break; }
            await new Promise(r => setTimeout(r, 200));
        }

        if (!stopped) {
            // Re-verify identity before SIGKILL: if the server died during the
            // grace period and the PID was recycled, /health would no longer
            // identify as switchboard — do not kill an innocent process.
            if (!await probeHealth(port, '127.0.0.1', 500)) {
                console.log('[switchboard] Server stopped during grace period.');
                stopped = true;
            } else {
                console.warn(`[switchboard] Server did not stop within ${GRACE_MS / 1000}s. Escalating to SIGKILL — this may abandon a pending database write.`);
                try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
                await new Promise(r => setTimeout(r, 500));
            }
        }

        if (await probeHealth(port, '127.0.0.1', 500)) {
            console.error('[switchboard] Server is still responding after SIGKILL. It may need to be killed manually.');
            process.exit(1);
        }

        // Clean up stale files if the process exited uncleanly (SIGKILL skips
        // the stop() cleanup that unlinks them).
        const portFile = path.join(switchboardDir, 'api-server-port.txt');
        const pidFile = path.join(switchboardDir, 'api-server.pid');
        try { if (fs.existsSync(portFile)) fs.unlinkSync(portFile); } catch { /* ignore */ }
        try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch { /* ignore */ }

        console.log('[switchboard] Server stopped.');
        process.exit(0);
    }

    // ── status ─────────────────────────────────────────────────────
    if (process.argv[2] === 'status') {
        const jsonFlag = process.argv.slice(3).includes('--json');
        if (jsonFlag) { routeLogsToStderr(); }

        const port = await findRunningInstance(workspaceRoot);
        if (port === null) {
            if (jsonFlag) { emitJson({ running: false }); }
            else { console.log('[switchboard] No running Switchboard instance for this workspace.'); }
            exitFlushed(1);
        }

        let health: Awaited<ReturnType<typeof getHealthJson>> | undefined;
        try {
            health = await getHealthJson(port);
        } catch {
            if (jsonFlag) { emitJson({ running: false }); }
            else { console.log('[switchboard] No running Switchboard instance for this workspace.'); }
            exitFlushed(1);
        }
        if (!health) { exitFlushed(1); }

        const payload = {
            running: true,
            pid: health.pid,
            port,
            url: `http://127.0.0.1:${port}`,
            workspaceRoot: health.selectedWorkspaceRoot ?? workspaceRoot,
            roots: health.roots,
            terminalCount: health.terminalCount ?? 0,
            terminals: health.terminals ?? [],
        };

        if (jsonFlag) {
            emitJson(payload);
        } else {
            console.log(`[switchboard] Running (PID ${health.pid}, port ${port})`);
            console.log(`  URL:       ${payload.url}`);
            console.log(`  Workspace: ${payload.workspaceRoot}`);
            console.log(`  Terminals: ${payload.terminalCount}`);
        }
        exitFlushed(0);
    }

    // ── logs ───────────────────────────────────────────────────────
    if (process.argv[2] === 'logs') {
        const follow = process.argv.slice(3).some(a => a === '-f' || a === '--follow');
        const logFile = path.join(switchboardDir, 'logs', 'server.log');
        if (!fs.existsSync(logFile)) {
            console.error(`[switchboard] No log file found at ${logFile}.`);
            console.error('[switchboard] The server may not have been started, or may be running in an older version without file logging.');
            process.exit(1);
        }

        // Print existing content.
        const content = fs.readFileSync(logFile, 'utf8');
        process.stdout.write(content);

        if (!follow) { exitFlushed(0); }

        // Follow: poll for new content. Polling (not fs.watch) handles rotation
        // transparently — when the file shrinks (rotated), we restart from 0.
        let size = fs.statSync(logFile).size;
        process.on('SIGINT', () => process.exit(0));
        process.on('SIGTERM', () => process.exit(0));

        const interval = setInterval(() => {
            try {
                const stat = fs.statSync(logFile);
                if (stat.size < size) {
                    // File was rotated or truncated — restart from the beginning.
                    size = 0;
                }
                if (stat.size > size) {
                    const fd = fs.openSync(logFile, 'r');
                    try {
                        const buf = Buffer.alloc(stat.size - size);
                        fs.readSync(fd, buf, 0, buf.length, size);
                        process.stdout.write(buf.toString());
                    } finally {
                        fs.closeSync(fd);
                    }
                    size = stat.size;
                }
            } catch { /* file may not exist momentarily during rotation */ }
        }, 500);
        interval.unref();

        // Keep the process alive for the interval.
        await new Promise(() => { /* never resolves */ });
    }

    const existing = await findRunningInstance(workspaceRoot);
    if (existing !== null) {
        console.error(`[switchboard] Another Switchboard instance is already running on port ${existing} for ${workspaceRoot}.`);
        console.error(`[switchboard] Reusing is not supported (single writer). Use that instance or shut it down.`);
        process.exit(1);
    }

    const hostname = resolveHostname(args.hostname);

    // ── --detach: spawn a child, wait for health, exit ─────────────
    //
    // The parent re-spawns itself without --detach, with stdio ignored and
    // SWITCHBOARD_DETACHED=1 in the env. The child detects the env var and
    // writes to the log file only (not stdout, which is /dev/null). The parent
    // polls findRunningInstance (port file + /health) so it never reports
    // success for a server that failed to boot — the failure this prevents is
    // a detached launch returning 0 and a URL for a dead process.
    if (args.detach) {
        const logsDir = path.join(switchboardDir, 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        const logFile = path.join(logsDir, 'server.log');

        // Build the child's argv: same args minus --detach, plus --no-open
        // unless --open was passed explicitly (a detached launch on a headless
        // host has no browser to open).
        const childArgv = process.argv.slice(2).filter(a => a !== '--detach');
        if (!args.open && !childArgv.includes('--no-open')) {
            childArgv.push('--no-open');
        }

        const child = spawn(process.execPath, [__filename, ...childArgv], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, SWITCHBOARD_DETACHED: '1' },
        });
        child.unref();
        child.on('error', (err) => {
            console.error(`[switchboard] Failed to spawn detached server: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        });

        // Poll for the child to come up. findRunningInstance reads the port file
        // and probes /health, so this succeeds only when the server is actually
        // answering — not just when the process spawned.
        const DETACH_TIMEOUT_MS = 15000;
        const detachStart = Date.now();
        let detachPort: number | null = null;
        while (Date.now() - detachStart < DETACH_TIMEOUT_MS) {
            detachPort = await findRunningInstance(workspaceRoot);
            if (detachPort !== null) break;
            // If the child exited early (bad port, missing workspace), bail.
            if (child.exitCode !== null) break;
            await new Promise(r => setTimeout(r, 250));
        }

        if (detachPort === null) {
            console.error(`[switchboard] Detached server failed to start within ${DETACH_TIMEOUT_MS / 1000}s.`);
            console.error(`[switchboard] Check the log file: ${logFile}`);
            process.exit(1);
        }

        let detachPid: number;
        try {
            const detachHealth = await getHealthJson(detachPort);
            detachPid = detachHealth.pid;
        } catch {
            // Health was confirmed by findRunningInstance moments ago — a failure
            // here is a race, not a misconfiguration. Report what we can.
            detachPid = child.pid ?? -1;
        }

        console.log(`[switchboard] Server started in background.`);
        console.log(`  PID:   ${detachPid}`);
        console.log(`  URL:   http://127.0.0.1:${detachPort}`);
        console.log(`  Logs:  ${logFile}`);
        console.log(`[switchboard] Use 'npx switchboard token show' for a board URL, 'npx switchboard status' to check, or 'npx switchboard stop' to shut down.`);
        process.exit(0);
    }

    // ── Foreground or detached child: set up file logging ──────────
    //
    // In foreground mode, console output goes to both the terminal and the file.
    // In detached mode (SWITCHBOARD_DETACHED=1), stdout is /dev/null so only the
    // file is written. This must happen before startHeadlessSwitchboard so the
    // bootstrap log() calls are captured.
    const isDetachedChild = process.env.SWITCHBOARD_DETACHED === '1';
    const logsDir = path.join(switchboardDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, 'server.log');
    setupFileLogging(logFile, !isDetachedChild);

    // Default port is 7777 (parseArgs). If it is taken, fall back to ephemeral
    // (port 0) and log the fallback. `--port 0` is an explicit opt-in to
    // ephemeral and bypasses the retry.
    let instance: Awaited<ReturnType<typeof startHeadlessSwitchboard>>;
    try {
        instance = await startHeadlessSwitchboard({
            workspaceRoot,
            port: args.port,
            hostname,
            verbose: true,
        });
    } catch (err) {
        const code = (err as any)?.code;
        if (args.port && args.port !== 0 && code === 'EADDRINUSE') {
            console.warn(`[switchboard] Port ${args.port} is in use, falling back to an ephemeral port.`);
            instance = await startHeadlessSwitchboard({
                workspaceRoot,
                port: 0,
                hostname,
                verbose: true,
            });
        } else {
            throw err;
        }
    }

    await waitForHealth(instance.port);

    const displayHost = new URL(instance.url).hostname;
    const boardUrl = `${instance.url}/?token=${instance.oneTimeToken}`;

    console.log(`\nSwitchboard is running at ${instance.url}`);
    console.log(`Board URL (one-time token, expires in 15 minutes): ${boardUrl}`);
    console.log(`To enrol another device or re-enter after expiry: npx switchboard token show`);
    if (displayHost !== '127.0.0.1') {
        // The token is consumed server-side, so a name the browser fails to
        // resolve never reaches the server and never spends it — this fallback
        // stays valid. Printed up front because the failure mode (a browser that
        // does not map *.localhost to loopback) looks like Switchboard is down.
        console.log(`If your browser cannot resolve ${displayHost}, use http://127.0.0.1:${instance.port}/?token=${instance.oneTimeToken} instead.`);
    }
    if (isDetachedChild) {
        console.log('Running detached. Use \'npx switchboard stop\' to shut down.\n');
    } else {
        console.log('Press Ctrl+C to stop.\n');
    }

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
