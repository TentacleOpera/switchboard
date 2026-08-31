import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as util from 'util';
import { spawn } from 'child_process';
import type { HeadlessSwitchboardOptions, HeadlessSwitchboardInstance } from './bootstrap';
import { DEFAULT_DISPLAY_HOSTNAME, isLoopbackHostname } from '../utils/loopbackHostname';
import { detectTailnetAddress, resolveMagicDnsNames } from '../utils/tailnetDetect';

function usage(): string {
    return `Usage: npx switchboard                        (interactive board console — default)
       npx switchboard local [options]            (serve the loopback board)
       npx switchboard tailnet [options]          (serve the loopback board AND your tailnet)
       npx switchboard plans [column] [--project <name>] [--search <query>] [--limit N] [--offset N] [--json]
       npx switchboard ready [--project <name>] [--json]
       npx switchboard dispatch <planId|prefix> [column] [--project <name>] [--json]
       npx switchboard clear <terminal|--all> [--json]
       npx switchboard fleet [--json]
       npx switchboard verb <verbName> [jsonPayload] [--json]
       npx switchboard setup [init|scaffold|control-plane] [options]
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
       npx switchboard export [--out <path>] [--workspace <path>]
       npx switchboard import <bundle.json> [--workspace <path>]
       npx switchboard help [command]
       npx switchboard about | version

Board commands (drive the board from a terminal):
  (bare)              Interactive board console — browse columns, search, dispatch.
                      Connects to a running server; exits 1 if none is running.
  plans               List cards with optional column/project/search filtering.
  ready               List cards ready to dispatch (PLAN REVIEWED + CREATED,
                      subtasks excluded) — the same set the Mission Control
                      protocol's "What Is Ready To Go" defines.
                      Interactive picker on a TTY; lists and exits 0 otherwise.
  dispatch            Dispatch a card by planId or unique prefix. Column defaults
                      to auto (complexity routing). Exit codes:
                        0 dispatched  1 offline  2 nothing ready  3 refused
                        4 auth failed  5 bad input  6 unavailable
  clear               Clear a terminal seat (or --all seats).
  fleet               Show live terminal seats, roles, and assigned plans.
  verb                Call any protocol verb directly: switchboard verb <name> <json>
  setup               Unified setup wizard (init, scaffold, control-plane).
  help                Show this help (alias: --help, -h).
  about               Show version and system info (alias: version, --version, -v).

Serve modes:
  local               Serve the board on loopback (127.0.0.1) only.
  tailnet             Serve the board on loopback AND on this machine's Tailscale
                      interface address, so any device on your tailnet can open it.
                      No token, no enrolment — tailnet membership is the control.
                      Fails loudly (non-zero) if Tailscale is absent or down; never
                      silently falls back to loopback-only and never binds 0.0.0.0.
                      'switchboard local' is always available as the answer.

  'start' has been replaced. Use 'switchboard local' (this machine) or
  'switchboard tailnet' (reachable on your tailnet).

Aliases for secrets commands:
  clickup   -> switchboard.clickup.apiToken
  linear    -> switchboard.linear.apiToken
  notion    -> switchboard.notion.apiToken
  stitch    -> switchboard.stitch.apiKey
  apiToken  -> switchboard.apiToken

Options:
  --workspace <path>   Workspace root to serve or init (default: cwd)
  --out <path>         export: bundle destination (default: ~/.switchboard/transfer/)
  --import-bundle <p>  serve: import a transfer bundle once the plan files have
                       been ingested. This is what the interactive first-run
                       menu's option 3 passes through; use it directly for a
                       non-interactive first run.
  --port <number>      Preferred port; 0 for ephemeral (default: 7777)
  --hostname <name>    Hostname for the board URL (default: ${DEFAULT_DISPLAY_HOSTNAME},
                       falling back to 127.0.0.1 if that name is unreachable).
                       Under 'local' must be a loopback name: localhost, 127.0.0.1,
                       or anything under the reserved .localhost TLD, e.g.
                       ${DEFAULT_DISPLAY_HOSTNAME}. Under 'tailnet' a MagicDNS name
                       or tailnet address is also accepted.
  --detach             serve: run in background (detached). Implies --no-open unless --open is given.
  --no-open            Do not open a browser
  --open               serve --detach: open a browser anyway (overrides implied --no-open)
  --json               Machine-readable JSON output (status, plans, fleet, verb, etc.)
  -f, --follow         logs: tail live output
  --target <name>      Protocol target for 'init': agents, claude, or both (default: both)
  --pat <token>        PAT for cloning (visible in process list — prefer SWITCHBOARD_PAT env var)
  --keep-sub-repo-db   Keep an existing sub-repo kanban.db instead of deleting it (headless default: delete)
  --cleanup <repo>     migrate: archive the named source repo's .switchboard/ after merging (repeatable)
  --cleanup-all        migrate: archive ALL source repos' .switchboard/ after merging
  --project <name>     plans/ready/dispatch: filter by project (empty = no filter)
  --search <query>     plans: search card titles and plan files
  --limit <N>          plans: pagination limit (default: 10)
  --offset <N>         plans: pagination offset (default: 0)
  --help               Show this help
  --version            Show version and system info
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

function parseArgs(argv: string[]): { workspace?: string; port?: number; hostname?: string; noOpen: boolean; open: boolean; detach: boolean; help: boolean; version: boolean; out?: string; importBundle?: string } {
    const args = { noOpen: false, open: false, detach: false, help: false, version: false, port: 7777 } as any;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--workspace') { args.workspace = argv[++i]; }
        else if (a === '--out') { args.out = argv[++i]; }
        else if (a === '--import-bundle') { args.importBundle = argv[++i]; }
        else if (a === '--port') { args.port = parseInt(argv[++i], 10); }
        else if (a === '--hostname') { args.hostname = argv[++i]; }
        else if (a === '--no-open') { args.noOpen = true; }
        else if (a === '--open') { args.open = true; }
        else if (a === '--detach') { args.detach = true; }
        else if (a === '--help' || a === '-h') { args.help = true; }
        else if (a === '--version' || a === '-v') { args.version = true; }
    }
    return args;
}

/**
 * Reject a `--hostname` the server would 403 on, at parse time.
 *
 * The failure this prevents is silent and expensive: a non-loopback name would
 * print an inviting URL, open a browser, and then hit the DNS-rebinding guard —
 * burning the one-time token on a request that can never succeed.
 *
 * Under `tailnet` mode the tailnet address and MagicDNS names are also accepted
 * (the server's Host guard widens to match — see `isAllowedHostFor`). Under
 * `local` mode only loopback names pass.
 */
function resolveHostname(input: string | undefined, tailnetAcceptable: string[] = []): string | undefined {
    if (input === undefined) { return undefined; }
    const candidate = input.trim().toLowerCase();
    if (isLoopbackHostname(candidate)) { return candidate; }
    if (tailnetAcceptable.some(a => a.toLowerCase() === candidate)) { return candidate; }
    if (tailnetAcceptable.length > 0) {
        console.error(`[switchboard] --hostname '${input}' is not a loopback name or a tailnet name.`);
        console.error('Under tailnet mode the hostname must be a loopback name (localhost, 127.0.0.1,');
        console.error('*.localhost), the tailnet address, or a MagicDNS name for this tailnet.');
    } else {
        console.error(`[switchboard] --hostname '${input}' is not a loopback name.`);
        console.error('Switchboard binds 127.0.0.1 only, so the hostname must resolve there:');
        console.error('  127.0.0.1, localhost, or any name under the reserved .localhost TLD');
        console.error('  e.g. --hostname switchboard.localhost');
    }
    process.exit(1);
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
            // The terminal mirror is best-effort. Once the controlling terminal is
            // gone (SIGHUP — closed window, dropped SSH session) these writes EPIPE,
            // and a server that survives SIGHUP would otherwise die on its next log
            // line instead — externally indistinguishable from the bug the SIGHUP
            // handler fixes. The file sink stays live either way.
            if (alsoStdout) {
                try { orig(...args); } catch { /* terminal gone */ }
            }
        };
    };

    // Node delivers a mid-write EPIPE as a stream 'error' event, not a synchronous
    // throw, and an unhandled 'error' on stdout/stderr is an uncaught exception.
    // Same reasoning as the try/catch above: losing the terminal must not stop the
    // process.
    process.stdout.on('error', () => { /* terminal gone */ });
    process.stderr.on('error', () => { /* terminal gone */ });

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

/**
 * Can we bind `port` on loopback right now?
 *
 * Used to choose the listen port before `startHeadlessSwitchboard` builds anything,
 * so a busy default port costs one throwaway socket rather than a half-booted
 * instance that has to be abandoned mid-flight.
 */
function isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.once('listening', () => probe.close(() => resolve(true)));
        try { probe.listen(port, '127.0.0.1'); } catch { resolve(false); }
    });
}

async function waitForHealth(port: number, timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await probeHealth(port, '127.0.0.1', 1000)) return;
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`Health check timed out on port ${port}`);
}

// ── Board command helpers ──────────────────────────────────────
//
// The functions below serve the `plans`, `ready`, `dispatch`, `clear`, `fleet`,
// `verb`, and bare-`switchboard` console commands. They are HTTP clients over
// loopback — they never open kanban.db, never call move-card.js, and never
// reimplement dispatch routing. The server's `performKanbanDispatch` is the
// single implementation; the CLI is a third door onto it.

/**
 * Discover an auth token for the running server.
 *
 * Reads `.switchboard/api-server-token.txt` (published by the sibling
 * `publish-agent-api-token-for-out-of-process-agents` plan). When no token file
 * exists, returns null — the server's `_checkAuth` returns true on loopback with
 * no token configured, so the CLI works unauthenticated locally. The token value
 * is never printed; only its source (file / none) is reported in debug output.
 */
function discoverAuthToken(workspaceRoot: string): string | null {
    const tokenFile = path.join(workspaceRoot, '.switchboard', 'api-server-token.txt');
    try {
        if (fs.existsSync(tokenFile)) {
            const raw = fs.readFileSync(tokenFile, 'utf8').trim();
            return raw || null;
        }
    } catch { /* ignore */ }
    return null;
}

interface ApiResponse {
    status: number;
    body: string;
    json: () => any;
}

/**
 * HTTP GET against the running server with auth headers attached.
 * Rejects on network error or timeout — callers handle the rejection.
 */
function apiGet(port: number, pathname: string, workspaceRoot: string, query?: Record<string, string>): Promise<ApiResponse> {
    const token = discoverAuthToken(workspaceRoot);
    let url = `http://127.0.0.1:${port}${pathname}`;
    // `workspaceRoot` is NOT optional on the read path. `_resolveDbFromQuery`
    // falls back to the host's own selected root when the param is absent — on
    // the extension host that is a DIFFERENT board from the one the CLI's cwd
    // names. The dispatch POST already carries `workspaceRoot` in its body, so
    // omitting it here lets `ready` list one board's cards and `dispatch`
    // resolve them against another (404 → exit 5, "plan not found" for a card
    // the CLI just printed). The Mission Control protocol passes
    // `workspaceRoot=$WS` on every read for exactly this reason.
    const params: Record<string, string> = { ...(query || {}), workspaceRoot };
    const qs = new URLSearchParams(params).toString();
    if (qs) { url += `?${qs}`; }
    return new Promise((resolve, reject) => {
        const headers: http.OutgoingHttpHeaders = {};
        if (token) { headers['Authorization'] = `Bearer ${token}`; }
        const req = http.get(url, { headers }, (res) => {
            let body = '';
            res.on('data', (c: Buffer) => body += c.toString());
            res.on('end', () => {
                const status = res.statusCode ?? 200;
                resolve({
                    status,
                    body,
                    json: () => { try { return JSON.parse(body); } catch { return null; } },
                });
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { try { req.destroy(); } catch { /* */ } reject(new Error('Request timed out')); });
    });
}

/**
 * HTTP POST against the running server with auth headers and a JSON body.
 */
function apiPost(port: number, pathname: string, workspaceRoot: string, payload: unknown): Promise<ApiResponse> {
    const token = discoverAuthToken(workspaceRoot);
    const url = `http://127.0.0.1:${port}${pathname}`;
    const bodyStr = payload === undefined ? '' : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
        const headers: http.OutgoingHttpHeaders = {
            'Content-Type': 'application/json',
        };
        if (bodyStr) { headers['Content-Length'] = Buffer.byteLength(bodyStr); }
        if (token) { headers['Authorization'] = `Bearer ${token}`; }
        const req = http.request(url, { method: 'POST', headers }, (res) => {
            let body = '';
            res.on('data', (c: Buffer) => body += c.toString());
            res.on('end', () => {
                const status = res.statusCode ?? 200;
                resolve({
                    status,
                    body,
                    json: () => { try { return JSON.parse(body); } catch { return null; } },
                });
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { try { req.destroy(); } catch { /* */ } reject(new Error('Request timed out')); });
        if (bodyStr) { req.write(bodyStr); }
        req.end();
    });
}

/** The first 8 hex chars of a planId — short enough to type, unique in practice. */
function shortPrefix(planId: string): string {
    return String(planId || '').replace(/-/g, '').slice(0, 8);
}

/**
 * Resolve a short prefix to a full planId by fetching the full board and
 * matching. Returns the full planId, or null if no match, or an array of
 * candidates if the prefix is ambiguous.
 */
/** Extract plan array from /kanban/plans API response (handles { data: [...] } and raw arrays). */
function extractPlans(raw: any): any[] {
    if (Array.isArray(raw)) { return raw; }
    if (Array.isArray(raw?.data)) { return raw.data; }
    if (Array.isArray(raw?.plans)) { return raw.plans; }
    return [];
}

async function resolvePrefix(port: number, workspaceRoot: string, prefix: string): Promise<{ planId: string } | { ambiguous: string[] } | null> {
    // If it's already a full UUID, return it directly.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(prefix)) {
        return { planId: prefix.toLowerCase() };
    }
    const cleanPrefix = prefix.replace(/-/g, '').toLowerCase();
    if (cleanPrefix.length < 3) {
        return null; // too short to resolve
    }
    const res = await apiGet(port, '/kanban/plans', workspaceRoot);
    if (res.status !== 200) { return null; }
    const plans = extractPlans(res.json());
    if (plans.length === 0) { return null; }
    const matches: string[] = [];
    for (const p of plans) {
        const pid = String(p?.planId || '');
        if (pid.replace(/-/g, '').toLowerCase().startsWith(cleanPrefix)) {
            matches.push(pid);
        }
    }
    if (matches.length === 0) { return null; }
    if (matches.length === 1) { return { planId: matches[0] }; }
    return { ambiguous: matches };
}

/** Map an HTTP status code from /kanban/dispatch to the CLI exit code. */
function dispatchExitCode(status: number): number {
    switch (status) {
        case 200: return 0;
        case 401: return 4;
        case 409: return 3;
        case 502: return 3;
        case 400: return 5;
        case 404: return 5;
        case 503: return 6;
        default: return 1; // 500 or unknown → offline/broke
    }
}

/**
 * The two columns that constitute "ready to go".
 *
 * These are the protocol's, not a guess: `.agents/protocols/switchboard-mission-control/SKILL.md`
 * § "What Is Ready To Go" defines ready as the two dispatchable lanes —
 * `CREATED` (planning lane) and `PLAN REVIEWED` (coding lane) — and names
 * `STAGING` explicitly among the columns that are NOT ready ("a manual staging
 * column"). A CLI that answered the same question with a different column set
 * would be the "two definitions of one question" the plan's verification step 6
 * exists to prevent.
 */
const READY_COLUMNS = ['PLAN REVIEWED', 'CREATED'];

/** Filter subtasks (featureId === '') and optionally project, client-side. */
function filterPlans(plans: any[], projectFilter?: string): any[] {
    let filtered = plans.filter((p: any) => {
        const fid = String(p?.featureId ?? '');
        return fid === ''; // subtasks excluded
    });
    if (projectFilter) {
        filtered = filtered.filter((p: any) => String(p?.project ?? '') === projectFilter);
    }
    return filtered;
}

/**
 * A plan row's human title.
 *
 * The field is `topic`, NOT `title`. `GET /kanban/plans` serialises
 * `KanbanPlanRecord` straight out of `KanbanDatabase._readRows`, whose object
 * literal has no `title` key at all (KanbanDatabase.ts:10923 sets `topic`), and
 * the Mission Control protocol's own jq reads `.topic`. Reading `.title` is
 * always `undefined`, which silently degraded every listing to an absolute plan
 * file path and made `--search` unable to match a card by name.
 * `title` is kept as a leading fallback only so a future/aliased payload that
 * does carry one is not ignored.
 */
function planTitle(p: any): string {
    return String(p?.topic || p?.title || p?.planFile || '(untitled)');
}

/** Format a single plan row for human-readable listing. */
function formatPlanLine(p: any, index?: number): string {
    const prefix = shortPrefix(String(p?.planId || ''));
    const col = String(p?.kanbanColumn || '?');
    const title = planTitle(p);
    const proj = p?.project ? ` [${p.project}]` : '';
    const num = index !== undefined ? `${index + 1}. ` : '';
    return `${num}${prefix}  ${col.padEnd(16)} ${title}${proj}`;
}

/**
 * The transfer bundle's CLI surface. `export`/`import` are the same
 * TransferBundleService the extension's palette commands and the two
 * `/kanban/transfer/*` routes drive — the CLI is a third caller of one service,
 * not a fourth implementation. See
 * `.switchboard/plans/hand-a-workspace-to-another-machine.md`.
 */

/** The board's DB path, resolved WITHOUT constructing a KanbanDatabase.
 *
 * `forWorkspace()` caches one instance per workspace root and resolves the path
 * once, at construction. Calling it here to answer "does a board exist?" would
 * cache an instance pinned to the default path, and a db-pointer written
 * afterwards (menu option 2) would then be ignored for the whole process. Both
 * helpers used here are static and side-effect-free.
 */
function resolveBoardDbPath(workspaceRoot: string): string {
    const { KanbanDatabase } = require('../services/KanbanDatabase');
    return KanbanDatabase.readDbPointer(workspaceRoot)
        || path.join(workspaceRoot, '.switchboard', 'kanban.db');
}

/** A 0-byte file is not a board: standalone pre-creates the file and lets
 *  `_initialize()` populate it, so size is the only honest existence test. */
function boardExists(workspaceRoot: string): boolean {
    try {
        const st = fs.statSync(resolveBoardDbPath(workspaceRoot));
        return st.isFile() && st.size > 0;
    } catch {
        return false;
    }
}

async function openBoardDatabase(workspaceRoot: string): Promise<any> {
    const { KanbanDatabase } = require('../services/KanbanDatabase');
    const db = KanbanDatabase.forWorkspace(workspaceRoot);
    if (!(await db.ensureReady())) {
        throw new Error(`No Switchboard board at ${db.dbPath}. Start the board once (npx switchboard) before transferring it.`);
    }
    return db;
}

function makeTransferService(db: any, workspaceRoot: string): any {
    const { TransferBundleService } = require('../services/TransferBundleService');
    return new TransferBundleService({
        db,
        getWorkspaceRoot: () => workspaceRoot,
        log: (msg: string) => console.error(msg),
    });
}

/** Print an import result. The exclusion list is reported whenever it is
 *  non-empty — for a bundle this version wrote it is empty by construction,
 *  because the export already filtered and reports its own exclusions. */
function printImportResult(result: any): void {
    console.log(`  ✓ ${result.cardsUpdated} cards matched   ✓ ${result.settingsApplied.length} settings applied`);
    if (result.cardsSkipped.length > 0) {
        console.log(`  – ${result.cardsSkipped.length} card(s) skipped (plan file not in this checkout):`);
        for (const c of result.cardsSkipped) { console.log(`      ${c.planFile} — ${c.reason}`); }
    }
    if (result.partialFailures.length > 0) {
        console.log(`  – ${result.partialFailures.length} card(s) partially applied:`);
        for (const c of result.partialFailures) { console.log(`      ${c.planFile} — ${c.reason}`); }
    }
    if (result.settingsExcluded.length > 0) {
        console.log(`  – ${result.settingsExcluded.length} setting(s) excluded (machine-local): ${result.settingsExcluded.join(', ')}`);
    }
    console.log('  Secrets do not travel in a bundle — re-authenticate on this machine, or copy');
    console.log('  ~/.switchboard/secrets.enc and ~/.switchboard/.master-key over a secure channel.');
}

/** Detached children have stdio 'ignore', so they must never prompt. */
function isDetachedChildProcess(): boolean {
    return process.env.SWITCHBOARD_DETACHED === '1';
}

/**
 * One readline interface for a whole interactive block, not one per question.
 * A per-question interface attaches and detaches its stdin listeners around each
 * prompt, so anything typed (or piped into a pty) between two questions is
 * dropped on the floor — the answer is read by nobody and the prompt repeats.
 */
function openPrompter(): { ask: (question: string) => Promise<string | null>; close: () => void } {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let closed = false;
    rl.on('close', () => { closed = true; });
    return {
        // Resolves to null when stdin closes without an answer (Ctrl-D). Without
        // this the question callback simply never fires, the promise never
        // settles, and the process exits with no message and no server — a
        // silent death at a prompt the user was staring at.
        ask: (question: string) => new Promise<string | null>((resolve) => {
            if (closed) { resolve(null); return; }
            rl.once('close', () => resolve(null));
            rl.question(question, (answer: string) => resolve(String(answer || '').trim()));
        }),
        close: () => { try { rl.close(); } catch { /* already closed */ } },
    };
}

/** Expand a leading `~` and resolve, so a pasted path from another machine's
 *  instructions behaves the way the shell would have. */
function resolveUserPath(input: string): string {
    return path.resolve(input.replace(/^~(?=$|[/\\])/, os.homedir()));
}

/**
 * First-run database menu. Shown only when there is no board AND stdin is a TTY:
 * a blocking prompt in a detached child, a cron run or a piped invocation would
 * hang the boot, so a non-interactive first run keeps today's behaviour exactly
 * (bootstrap creates the board and the server comes up).
 *
 * Returns a bundle path when option 3 is chosen. The import CANNOT run here —
 * it is update-only and the plan files have not been ingested yet, so every card
 * would resolve to nothing and the transfer would report success having done
 * nothing. It is deferred until after the ingestion startup scan settles.
 */
async function firstRunDatabaseMenu(workspaceRoot: string): Promise<{ pendingBundlePath?: string; cancelled?: boolean }> {
    const { KanbanDatabase } = require('../services/KanbanDatabase');
    const defaultDbPath = path.join(workspaceRoot, '.switchboard', 'kanban.db');
    const prompter = openPrompter();

    console.log('No Switchboard database found.');
    console.log(`  1) Create a new board       (${defaultDbPath})`);
    console.log('  2) Use an existing database (path)');
    console.log('  3) Import a transfer bundle (path)');

    try {
        for (;;) {
            const choice = await prompter.ask('> ');
            if (choice === null) { return { cancelled: true }; }
            if (choice === '' || choice === '1') {
                // Nothing to do: bootstrap creates the file and _initialize populates it.
                console.log(`[switchboard] Creating a new board at ${defaultDbPath}`);
                return {};
            }
            if (choice === '2') {
                const answer = await prompter.ask('  Path to an existing kanban.db: ');
                if (answer === null) { return { cancelled: true }; }
                if (!answer) { console.log('  Enter a path, or 1 to start a new board.'); continue; }
                const resolved = resolveUserPath(answer);
                if (!fs.existsSync(resolved)) { console.log(`  Not found: ${resolved}`); continue; }
                KanbanDatabase.writeDbPointer(workspaceRoot, resolved);
                console.log(`[switchboard] This workspace now points at ${resolved}`);
                return {};
            }
            if (choice === '3') {
                const answer = await prompter.ask('  Path to switchboard-transfer.json: ');
                if (answer === null) { return { cancelled: true }; }
                if (!answer) { console.log('  Enter a path, or 1 to start a new board.'); continue; }
                const resolved = resolveUserPath(answer);
                if (!fs.existsSync(resolved)) { console.log(`  Not found: ${resolved}`); continue; }
                console.log(`[switchboard] Creating a new board at ${defaultDbPath}, then importing ${resolved}`);
                return { pendingBundlePath: resolved };
            }
            console.log('  Enter 1, 2 or 3.');
        }
    } finally {
        prompter.close();
    }
}

/**
 * Run a deferred bundle import once the plan watcher's startup scan has settled.
 *
 * `PlanIngestionEngine.initialize()` fires `_runStartupScan()` as
 * `void (async () => …)()` and returns immediately, so "the host has booted" does
 * NOT mean "the plan files are rows". The import is update-only and keys on
 * plan_file, so running it early is the plan's named silent failure: every card
 * lands in the skipped list and the transfer reports success having done nothing.
 * Waiting for the row count to stop changing is the "upsert-and-wait" arm of that
 * requirement — a count that never moves off zero is still honoured after the
 * timeout, because a workspace with no committed plan files is legitimate and the
 * skip report is then the true answer.
 */
async function runPendingBundleImport(workspaceRoot: string, bundlePath: string): Promise<void> {
    const SETTLE_POLL_MS = 400;
    const SETTLE_STABLE_READS = 3;
    const SETTLE_TIMEOUT_MS = 30000;

    console.log(`\n[switchboard] Importing transfer bundle: ${bundlePath}`);
    try {
        const db = await openBoardDatabase(workspaceRoot);
        const workspaceId = await db.getWorkspaceId();
        if (!workspaceId) {
            console.error('[switchboard] Transfer import failed: no workspace ID resolved.');
            return;
        }

        let lastCount = -1;
        let stableReads = 0;
        const deadline = Date.now() + SETTLE_TIMEOUT_MS;
        while (Date.now() < deadline && stableReads < SETTLE_STABLE_READS) {
            const count = (await db.getBoard(workspaceId)).length;
            stableReads = count === lastCount ? stableReads + 1 : 0;
            lastCount = count;
            if (stableReads < SETTLE_STABLE_READS) {
                await new Promise(r => setTimeout(r, SETTLE_POLL_MS));
            }
        }
        if (stableReads < SETTLE_STABLE_READS) {
            console.warn(`[switchboard] Plan ingestion had not settled after ${SETTLE_TIMEOUT_MS / 1000}s — importing against ${lastCount} card(s) as they stand.`);
        }

        const result = await makeTransferService(db, workspaceRoot).importBundle(bundlePath);
        if (!result.success) {
            console.error(`[switchboard] Transfer import failed: ${result.error || 'unknown error'}`);
            return;
        }
        printImportResult(result);
    } catch (err) {
        console.error(`[switchboard] Transfer import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

// ── Board command implementations ──────────────────────────────

/** Read the version string from package.json (the source of truth). */
function readVersion(): string {
    try {
        const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return String(pkg.version || 'unknown');
    } catch { return 'unknown'; }
}

/** The UFO ANSI banner used by `about` and the bare console. */
function banner(version: string): string {
    return [
        '       .---.',
        " _...-'     '-..._       SWITCHBOARD v" + version,
        '.-~  ●   ●   ●   ●  ~-.   Autonomous Agent Fleet Console',
        '(________________________)',
        '      \\   :    :   /       https://github.com/TentacleOpera/switchboard',
        '       \\  :    :  /        Host: Standalone (' + process.platform + ' ' + process.arch + ')',
        '',
    ].join('\n');
}

/** `switchboard about` / `switchboard version` / `--version` / `-v` */
async function cmdAbout(workspaceRoot: string, jsonFlag: boolean): Promise<void> {
    const version = readVersion();
    if (jsonFlag) {
        routeLogsToStderr();
        const payload: Record<string, unknown> = {
            version,
            service: 'switchboard',
            host: 'standalone',
            platform: process.platform,
            arch: process.arch,
            workspaceRoot,
        };
        const port = await findRunningInstance(workspaceRoot);
        if (port !== null) {
            payload.serverUrl = `http://127.0.0.1:${port}`;
            payload.running = true;
            try {
                const health = await getHealthJson(port);
                payload.pid = health.pid;
                payload.terminalCount = health.terminalCount ?? 0;
                payload.terminals = health.terminals ?? [];
            } catch { /* server may have stopped */ }
        } else {
            payload.running = false;
        }
        emitJson(payload);
        exitFlushed(0);
    }
    console.log(banner(version));
    const port = await findRunningInstance(workspaceRoot);
    if (port !== null) {
        console.log(`Active Server:    http://127.0.0.1:${port} (Local)`);
        try {
            const health = await getHealthJson(port);
            console.log(`Workspace:        ${health.selectedWorkspaceRoot ?? workspaceRoot}`);
            const seats = health.terminals ?? [];
            console.log(`Active Fleet:     ${seats.length} seat${seats.length === 1 ? '' : 's'}${seats.length > 0 ? ' (' + seats.join(', ') + ')' : ''}`);
        } catch { /* */ }
    } else {
        console.log('Active Server:    (not running)');
        console.log(`Workspace:        ${workspaceRoot}`);
    }
    exitFlushed(0);
}

/** `switchboard help [command]` — alias for `--help` / `-h`. */
function cmdHelp(command?: string): void {
    if (command && command !== 'help') {
        // Could add per-command help in the future; for now, show full usage.
        console.log(usage());
    } else {
        console.log(usage());
    }
    process.exit(0);
}

/**
 * `switchboard plans [column] [--project <name>] [--search <query>] [--limit N] [--offset N] [--json]`
 *
 * Lists cards from GET /kanban/plans with optional column, project, and search
 * filtering. Project and search are filtered client-side (the API has no params
 * for them). Pagination via --limit and --offset.
 */
async function cmdPlans(workspaceRoot: string, argv: string[]): Promise<void> {
    const jsonFlag = argv.includes('--json');
    if (jsonFlag) { routeLogsToStderr(); }

    let column: string | undefined;
    let project: string | undefined;
    let search: string | undefined;
    let limit = 10;
    let offset = 0;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') { continue; }
        if (a === '--project') { project = argv[++i]; continue; }
        if (a === '--search') { search = argv[++i]; continue; }
        if (a === '--limit') { limit = parseInt(argv[++i], 10) || 10; continue; }
        if (a === '--offset') { offset = parseInt(argv[++i], 10) || 0; continue; }
        if (!a.startsWith('-') && !column) { column = a; continue; }
    }

    const port = await findRunningInstance(workspaceRoot);
    if (port === null) {
        if (jsonFlag) { emitJson({ success: false, error: 'No running Switchboard instance' }); }
        else { console.error('[switchboard] No running Switchboard instance for this workspace.'); }
        exitFlushed(1);
    }

    const query: Record<string, string> = {};
    if (column) { query.column = column; }
    const res = await apiGet(port, '/kanban/plans', workspaceRoot, query);
    if (res.status === 401) {
        if (jsonFlag) { emitJson({ success: false, error: 'Authentication failed' }); }
        else { console.error('[switchboard] Authentication failed (401). The server requires a token.'); }
        exitFlushed(4);
    }
    if (res.status !== 200) {
        if (jsonFlag) { emitJson({ success: false, error: `Server returned ${res.status}`, body: res.body }); }
        else { console.error(`[switchboard] Server returned ${res.status}: ${res.body}`); }
        exitFlushed(1);
    }

    let plans = extractPlans(res.json());

    // Client-side filters (matching the Mission Control protocol's jq).
    // Subtasks (featureId !== '') are excluded from the ready/dispatch view but
    // `plans` is a general listing — include subtasks unless filtering by column
    // that implies ready. For `plans` we include all cards but still apply
    // project and search filters.
    if (project) {
        plans = plans.filter((p: any) => String(p?.project ?? '') === project);
    }
    if (search) {
        const q = search.toLowerCase();
        plans = plans.filter((p: any) => {
            const title = planTitle(p).toLowerCase();
            const planFile = String(p?.planFile || '').toLowerCase();
            const pid = String(p?.planId || '').toLowerCase();
            return title.includes(q) || planFile.includes(q) || pid.includes(q);
        });
    }

    const total = plans.length;
    const paged = plans.slice(offset, offset + limit);

    if (jsonFlag) {
        emitJson({ success: true, count: total, plans: paged });
        exitFlushed(0);
    }

    if (total === 0) {
        console.log('[switchboard] No cards found.');
        exitFlushed(0);
    }
    console.log(`[switchboard] ${total} card${total === 1 ? '' : 's'}${column ? ` in ${column}` : ''}${project ? ` [${project}]` : ''}${search ? ` matching "${search}"` : ''}:`);
    for (let i = 0; i < paged.length; i++) {
        console.log(`  ${formatPlanLine(paged[i], i + offset)}`);
    }
    if (offset + limit < total) {
        console.log(`  ... ${total - offset - limit} more (use --offset ${offset + limit} to see them)`);
    }
    exitFlushed(0);
}

/**
 * `switchboard ready [--project <name>] [--json]`
 *
 * Lists cards ready to dispatch: the two ready columns (PLAN REVIEWED, CREATED
 * — see READY_COLUMNS), subtasks excluded (featureId === ''). Picker on a TTY; lists and
 * exits 0 on non-interactive stdin or --json. EOF/SIGINT during the prompt
 * exits 0 without dispatching.
 */
async function cmdReady(workspaceRoot: string, argv: string[]): Promise<void> {
    const jsonFlag = argv.includes('--json');
    if (jsonFlag) { routeLogsToStderr(); }

    let project: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--json') { continue; }
        if (argv[i] === '--project') { project = argv[++i]; continue; }
    }

    const port = await findRunningInstance(workspaceRoot);
    if (port === null) {
        if (jsonFlag) { emitJson({ success: false, error: 'No running Switchboard instance' }); }
        else { console.error('[switchboard] No running Switchboard instance for this workspace.'); }
        exitFlushed(1);
    }

    // Fetch plans from both ready columns and merge.
    const readyPlans: any[] = [];
    for (const col of READY_COLUMNS) {
        const res = await apiGet(port, '/kanban/plans', workspaceRoot, { column: col });
        if (res.status === 401) {
            if (jsonFlag) { emitJson({ success: false, error: 'Authentication failed' }); }
            else { console.error('[switchboard] Authentication failed (401). The server requires a token.'); }
            exitFlushed(4);
        }
        if (res.status === 200) {
            const plans = extractPlans(res.json());
            readyPlans.push(...plans);
        }
    }

    // Filter subtasks and project client-side.
    const filtered = filterPlans(readyPlans, project);

    if (filtered.length === 0) {
        if (jsonFlag) { emitJson({ success: true, count: 0, plans: [] }); }
        else { console.log('[switchboard] Nothing ready to dispatch.'); }
        exitFlushed(2);
    }

    if (jsonFlag) {
        emitJson({ success: true, count: filtered.length, plans: filtered });
        exitFlushed(0);
    }

    // Print the list.
    console.log(`[switchboard] ${filtered.length} card${filtered.length === 1 ? '' : 's'} ready to dispatch:`);
    for (let i = 0; i < filtered.length; i++) {
        console.log(`  ${formatPlanLine(filtered[i], i)}`);
    }

    // Non-interactive: print and exit 0 (never block on a hidden prompt).
    if (!process.stdin.isTTY) {
        exitFlushed(0);
    }

    // Interactive picker. EOF/SIGINT/dropped pipe = exit 0, no dispatch.
    const prompter = openPrompter();
    try {
        // Install SIGINT handler that exits 0 without dispatching.
        const onSigInt = (): void => { prompter.close(); exitFlushed(0); };
        process.once('SIGINT', onSigInt);

        const answer = await prompter.ask('\nSelect a card to dispatch (1-' + filtered.length + ') [or Enter to exit]: ');
        process.removeListener('SIGINT', onSigInt);

        // null = EOF or closed stdin → exit 0, no dispatch.
        if (answer === null || answer === '') {
            exitFlushed(0);
        }
        const num = parseInt(answer, 10);
        if (isNaN(num) || num < 1 || num > filtered.length) {
            console.error(`[switchboard] Invalid selection '${answer}'. No card dispatched.`);
            exitFlushed(5);
        }
        const selected = filtered[num - 1];
        const planId = String(selected?.planId || '');
        console.log(`[switchboard] Dispatching ${shortPrefix(planId)} (${planTitle(selected)})…`);
        await doDispatch(port, workspaceRoot, planId, 'auto');
    } finally {
        prompter.close();
    }
}

/**
 * Core dispatch logic shared by `ready` picker and `dispatch` subcommand.
 * Calls POST /kanban/dispatch and maps the exit code. When `jsonFlag` is true,
 * emits the result as JSON on stdout (logs already routed to stderr by caller).
 */
async function doDispatch(port: number, workspaceRoot: string, planId: string, targetColumn: string, jsonFlag = false): Promise<void> {
    const res = await apiPost(port, '/kanban/dispatch', workspaceRoot, {
        plan: planId,
        targetColumn,
        workspaceRoot,
    });
    const code = dispatchExitCode(res.status);
    const data = res.json();
    if (jsonFlag) {
        emitJson({ success: code === 0, status: res.status, exitCode: code, result: data });
    } else if (code === 0) {
        console.log(`[switchboard] Dispatched: ${String(data?.dispatchedAgent || 'agent')} → ${String(data?.column || targetColumn)}`);
        if (data?.role) { console.log(`  Role: ${data.role}`); }
    } else {
        const errMsg = String(data?.error || res.body || 'dispatch failed');
        console.error(`[switchboard] ${errMsg}`);
    }
    exitFlushed(code);
}

/**
 * `switchboard dispatch <planId|prefix> [column] [--project <name>] [--json]`
 *
 * Resolves a full UUID or short prefix, then calls POST /kanban/dispatch.
 * Omitted column defaults to 'auto' (complexity routing).
 */
async function cmdDispatch(workspaceRoot: string, argv: string[]): Promise<void> {
    const jsonFlag = argv.includes('--json');
    if (jsonFlag) { routeLogsToStderr(); }

    let ref: string | undefined;
    let column = 'auto';
    let project: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') { continue; }
        if (a === '--project') { project = argv[++i]; continue; }
        if (!a.startsWith('-') && !ref) { ref = a; continue; }
        if (!a.startsWith('-') && ref && column === 'auto') { column = a; continue; }
    }

    if (!ref) {
        if (jsonFlag) { emitJson({ success: false, error: 'Missing planId or prefix' }); }
        else { console.error('Usage: npx switchboard dispatch <planId|prefix> [column] [--project <name>] [--json]'); }
        exitFlushed(5);
    }

    const port = await findRunningInstance(workspaceRoot);
    if (port === null) {
        if (jsonFlag) { emitJson({ success: false, error: 'No running Switchboard instance' }); }
        else { console.error('[switchboard] No running Switchboard instance for this workspace.'); }
        exitFlushed(1);
    }

    // Resolve prefix to full planId.
    const resolved = await resolvePrefix(port, workspaceRoot, ref);
    if (resolved === null) {
        if (jsonFlag) { emitJson({ success: false, error: `No plan matches prefix '${ref}'` }); }
        else { console.error(`[switchboard] No plan matches prefix '${ref}'.`); }
        exitFlushed(5);
    }
    if ('ambiguous' in resolved) {
        if (jsonFlag) { emitJson({ success: false, error: 'Ambiguous prefix', matches: resolved.ambiguous }); }
        else {
            console.error(`[switchboard] Ambiguous prefix '${ref}' — matches ${resolved.ambiguous.length} cards:`);
            for (const pid of resolved.ambiguous) {
                console.error(`  ${shortPrefix(pid)}  ${pid}`);
            }
        }
        exitFlushed(5);
    }

    const planId = (resolved as { planId: string }).planId;

    // If --project was given, verify the plan's project matches.
    if (project) {
        const plansRes = await apiGet(port, '/kanban/plans', workspaceRoot);
        if (plansRes.status === 200) {
            const plans = extractPlans(plansRes.json());
            const plan = plans.find((p: any) => p?.planId === planId);
            if (plan && String(plan.project ?? '') !== project) {
                if (jsonFlag) { emitJson({ success: false, error: `Plan ${shortPrefix(planId)} is in project '${plan.project ?? ''}', not '${project}'` }); }
                else { console.error(`[switchboard] Plan ${shortPrefix(planId)} is in project '${plan.project ?? ''}', not '${project}'.`); }
                exitFlushed(5);
            }
        }
    }

    await doDispatch(port, workspaceRoot, planId, column, jsonFlag);
}

/**
 * `switchboard clear <terminal|--all> [--json]`
 *
 * Clears a terminal seat by calling POST /terminals/verb/ptyClearTerminal.
 * `--all` iterates all active seats from /health.
 */
async function cmdClear(workspaceRoot: string, argv: string[]): Promise<void> {
    const jsonFlag = argv.includes('--json');
    if (jsonFlag) { routeLogsToStderr(); }

    // `--all` is a flag, so it cannot be read out of the positional list — the
    // positional filter strips every leading-dash token. Reading it from
    // `positional[0]` made `switchboard clear --all` exit 5 ("Missing terminal
    // name or --all") and left the whole fan-out branch below unreachable.
    const clearAll = argv.includes('--all');
    const positional = argv.filter(a => !a.startsWith('-'));
    const target = clearAll ? '--all' : positional[0];
    if (!target) {
        if (jsonFlag) { emitJson({ success: false, error: 'Missing terminal name or --all' }); }
        else { console.error('Usage: npx switchboard clear <terminal|--all> [--json]'); }
        exitFlushed(5);
    }

    const port = await findRunningInstance(workspaceRoot);
    if (port === null) {
        if (jsonFlag) { emitJson({ success: false, error: 'No running Switchboard instance' }); }
        else { console.error('[switchboard] No running Switchboard instance for this workspace.'); }
        exitFlushed(1);
    }

    const targets: string[] = [];
    if (clearAll) {
        try {
            const health = await getHealthJson(port);
            targets.push(...(health.terminals ?? []));
        } catch { /* */ }
        if (targets.length === 0) {
            if (jsonFlag) { emitJson({ success: true, cleared: [] }); }
            else { console.log('[switchboard] No active terminals to clear.'); }
            exitFlushed(0);
        }
    } else {
        targets.push(target);
    }

    const results: Array<{ name: string; ok: boolean; error?: string }> = [];
    for (const name of targets) {
        const res = await apiPost(port, '/terminals/verb/ptyClearTerminal', workspaceRoot, { name });
        const ok = res.status === 200;
        const data = res.json();
        results.push({ name, ok, error: ok ? undefined : String(data?.error || res.body) });
        if (!jsonFlag) {
            if (ok) { console.log(`Cleared ${name} (OK)`); }
            else { console.error(`Failed to clear ${name}: ${String(data?.error || res.body)}`); }
        }
    }

    if (jsonFlag) {
        emitJson({ success: results.every(r => r.ok), cleared: results });
        exitFlushed(0);
    }
    exitFlushed(results.every(r => r.ok) ? 0 : 1);
}

/**
 * `switchboard fleet [--json]`
 *
 * Queries /health and POST /terminals/verb/ptyListTerminals for a compact
 * table of live terminal seats, roles, liveness, and assigned plans.
 */
async function cmdFleet(workspaceRoot: string, argv: string[]): Promise<void> {
    const jsonFlag = argv.includes('--json');
    if (jsonFlag) { routeLogsToStderr(); }

    const port = await findRunningInstance(workspaceRoot);
    if (port === null) {
        if (jsonFlag) { emitJson({ success: false, error: 'No running Switchboard instance' }); }
        else { console.error('[switchboard] No running Switchboard instance for this workspace.'); }
        exitFlushed(1);
    }

    let health: Awaited<ReturnType<typeof getHealthJson>>;
    try {
        health = await getHealthJson(port);
    } catch {
        if (jsonFlag) { emitJson({ success: false, error: 'Could not reach server' }); }
        else { console.error('[switchboard] No running Switchboard instance for this workspace.'); }
        exitFlushed(1);
    }

    // Fetch detailed terminal info via ptyListTerminals.
    let terminals: any[] = [];
    const res = await apiPost(port, '/terminals/verb/ptyListTerminals', workspaceRoot, {});
    if (res.status === 200) {
        const data = res.json();
        // ptyListTerminals returns { success, terminals } or an array.
        if (Array.isArray(data)) { terminals = data; }
        else if (data?.terminals && Array.isArray(data.terminals)) { terminals = data.terminals; }
        else if (data?.result && Array.isArray(data.result)) { terminals = data.result; }
    }

    if (jsonFlag) {
        emitJson({
            success: true,
            port,
            pid: health.pid,
            terminalCount: health.terminalCount ?? 0,
            terminals,
        });
        exitFlushed(0);
    }

    if (terminals.length === 0) {
        console.log('[switchboard] No active terminals.');
        exitFlushed(0);
    }

    // Compact table.
    const header = ['SEAT', 'ROLE', 'STATUS', 'CURRENT PLAN / TASK'];
    const rows: string[][] = [header];
    // Field names come from the ptyListTerminals projection, not from a guess:
    // bootstrap.ts:1857 (and ptyHost.ts's identical shape) emits
    // `friendlyName` / `role` / `status`. There is no `name`, `terminalName`,
    // `alive` or `active` key on those rows — reading them printed `?` for every
    // seat and `idle` for every status, on a table whose entire job is to say
    // which seats are live.
    for (const t of terminals) {
        const name = String(t?.friendlyName || t?.name || t?.terminalName || '?');
        const role = String(t?.role || '-');
        const status = String(t?.status || (t?.alive || t?.active ? 'active' : 'idle'));
        const planLabel = t?.currentPlanTitle || t?.planTitle || t?.topic || '';
        const plan = String(planLabel || (t?.planId ? shortPrefix(String(t.planId)) : '') || '-');
        rows.push([name, role, status, plan]);
    }
    // Compute column widths.
    const widths = header.map((_, i) => Math.max(...rows.map(r => r[i].length)));
    for (const row of rows) {
        console.log('  ' + row.map((cell, i) => cell.padEnd(widths[i] + 2)).join('').trimEnd());
    }
    exitFlushed(0);
}

/**
 * `switchboard verb <verbName> [jsonPayload] [--json]`
 *
 * Direct CLI access to any protocol verb via POST /terminals/verb/<verbName>
 * or POST /kanban/verb/<verbName>. Automatically handles auth, port discovery,
 * and response formatting.
 */
async function cmdVerb(workspaceRoot: string, argv: string[]): Promise<void> {
    const jsonFlag = argv.includes('--json');
    if (jsonFlag) { routeLogsToStderr(); }

    const positional = argv.filter(a => !a.startsWith('-'));
    const verbName = positional[0];
    const payloadArg = positional[1];

    if (!verbName) {
        if (jsonFlag) { emitJson({ success: false, error: 'Missing verb name' }); }
        else { console.error('Usage: npx switchboard verb <verbName> [jsonPayload] [--json]'); }
        exitFlushed(5);
    }

    let payload: unknown = {};
    if (payloadArg) {
        try { payload = JSON.parse(payloadArg); }
        catch {
            if (jsonFlag) { emitJson({ success: false, error: 'Invalid JSON payload' }); }
            else { console.error(`[switchboard] Invalid JSON payload: ${payloadArg}`); }
            exitFlushed(5);
        }
    }

    const port = await findRunningInstance(workspaceRoot);
    if (port === null) {
        if (jsonFlag) { emitJson({ success: false, error: 'No running Switchboard instance' }); }
        else { console.error('[switchboard] No running Switchboard instance for this workspace.'); }
        exitFlushed(1);
    }

    // Try /terminals/verb/<name> first, then /kanban/verb/<name>.
    //
    // The terminal rail NEVER answers 404 for an unknown verb: the path prefix
    // matches, the request reaches the host's terminalVerb seam, and its
    // `default:` arm returns `{success:false, error:"...not implemented..."}` /
    // `"Unknown terminal verb '<verb>'"` — which LocalApiServer turns into a
    // 502 (LocalApiServer.ts:4424). A 404-only fallback therefore never fired,
    // and every kanban verb (including the plan's own `verb moveCard` example)
    // died on the terminal rail. Retry only on those two non-executing
    // refusals, never on a generic 502 — a blind retry could run a
    // side-effecting terminal verb twice.
    const VERB_NOT_HERE = /not implemented|unknown (terminal |pty )?verb|missing verb/i;
    let res = await apiPost(port, `/terminals/verb/${encodeURIComponent(verbName)}`, workspaceRoot, payload);
    if (res.status === 404 || (res.status >= 400 && VERB_NOT_HERE.test(String(res.json()?.error || '')))) {
        res = await apiPost(port, `/kanban/verb/${encodeURIComponent(verbName)}`, workspaceRoot, payload);
    }

    if (jsonFlag) {
        const data = res.json();
        emitJson({ success: res.status >= 200 && res.status < 300, status: res.status, result: data });
        exitFlushed(res.status >= 200 && res.status < 300 ? 0 : 1);
    }

    if (res.status >= 200 && res.status < 300) {
        const data = res.json();
        if (data && typeof data === 'object') {
            console.log(JSON.stringify(data, null, 2));
        } else {
            console.log(res.body || 'OK');
        }
        exitFlushed(0);
    }
    console.error(`[switchboard] verb '${verbName}' returned ${res.status}: ${res.body}`);
    exitFlushed(1);
}

/**
 * `switchboard setup [init|scaffold|control-plane] [options]`
 *
 * Unified setup wizard. When run bare on a TTY, presents a numbered menu.
 * Subcommands are callable directly for non-interactive use.
 */
async function cmdSetup(workspaceRoot: string, argv: string[]): Promise<void> {
    const sub = argv[0];

    // Direct subcommand passthrough: rewrite process.argv to replace 'setup'
    // with the subcommand, then return so main() falls through to the existing
    // handler. Splicing 'setup' out (rather than overwriting) keeps the
    // subcommand's own args in their original positions.
    if (sub === 'init' || sub === 'scaffold' || sub === 'control-plane') {
        const setupIdx = process.argv.indexOf('setup');
        if (setupIdx >= 0) {
            process.argv.splice(setupIdx, 1);
        }
        return; // main() continues to the init/scaffold/control-plane handler
    }

    // Interactive menu (TTY only).
    if (!process.stdin.isTTY) {
        console.error('[switchboard] Non-interactive setup requires a subcommand: init, scaffold, or control-plane.');
        console.error('  switchboard setup init [--target <agents|claude|both>]');
        console.error('  switchboard setup scaffold --parent-dir <dir> --workspace-name <name> --repo <url>');
        console.error('  switchboard setup control-plane <detect|preview|migrate>');
        exitFlushed(5);
    }

    const version = readVersion();
    console.log(banner(version).replace('Autonomous Agent Fleet Console', 'Workspace & Scaffolding Wizard'));
    console.log('  [1] Initialize Switchboard in this repository (rules, skills, constitution, workflows)');
    console.log('  [2] Scaffold Multi-Repo Control Plane (link & group multiple repos)');
    console.log('  [3] Detect & Migrate Existing Sub-Repos');
    console.log('  [4] Configure API Tokens & Secrets (ClickUp, Linear, Notion, Stitch)');
    console.log('');

    const prompter = openPrompter();
    try {
        const answer = await prompter.ask('Select an option [1-4] (or Enter to exit): ');
        if (answer === null || answer === '') { exitFlushed(0); }
        const setupIdx = process.argv.indexOf('setup');
        switch (answer) {
            case '1':
                prompter.close();
                if (setupIdx >= 0) { process.argv[setupIdx] = 'init'; }
                return; // → init handler
            case '2':
                prompter.close();
                if (setupIdx >= 0) { process.argv[setupIdx] = 'scaffold'; }
                return; // → scaffold handler
            case '3':
                prompter.close();
                if (setupIdx >= 0) { process.argv[setupIdx] = 'control-plane'; }
                return; // → control-plane handler
            case '4':
                console.log('\n[switchboard] Use `npx switchboard secrets set <key> <value>` to configure API tokens.');
                console.log('  Keys: clickup, linear, notion, stitch, apiToken');
                exitFlushed(0);
            default:
                console.error(`[switchboard] Invalid option '${answer}'.`);
                exitFlushed(5);
        }
    } finally {
        prompter.close();
    }
}

/**
 * `switchboard` (bare, interactive TTY) — top-level front-door menu.
 *
 * Always presents the Main Menu (GUI / CLI / Setup / Exit) regardless of
 * whether a server is running. GUI mode re-spawns the process with the
 * `local`/`tailnet` subcommand (reusing the entire existing serve path);
 * CLI mode launches the board console when a server is online, or offers to
 * boot a detached local server on demand. Non-TTY invocations exit 0 with
 * usage so a piped/cron bare call never hangs.
 */
async function cmdMainMenu(workspaceRoot: string): Promise<void> {
    // Non-TTY guard: a piped/cron bare invocation has no menu to show.
    if (!process.stdin.isTTY) {
        console.error('[switchboard] No subcommand given and stdin is not a TTY.');
        console.error('[switchboard] Run `switchboard` in an interactive terminal, or use a subcommand:');
        console.error('  switchboard local | tailnet | plans | ready | dispatch | fleet | setup | stop | status | logs');
        exitFlushed(0);
    }

    const version = readVersion();

    for (;;) {
        // Probe server status once per loop iteration so a server that
        // started/stopped between renders is reflected.
        const port = await findRunningInstance(workspaceRoot);

        console.log(banner(version));
        console.log(`  Active Server:    ${port !== null ? `Online: http://127.0.0.1:${port}` : 'Offline'}`);
        console.log(`  Workspace:        ${workspaceRoot}`);
        console.log('');
        console.log('MAIN MENU:');
        console.log('  [1] GUI Mode  — Start Local (127.0.0.1) or Remote Tailnet Board');
        console.log('  [2] CLI Mode  — Interactive Terminal Board Navigator (Plans, Fleet, Dispatch)');
        console.log('  [3] Setup     — Workspace & Multi-Repo Scaffolding Wizard');
        console.log('  [q] Exit (or Enter)');
        console.log('');

        const prompter = openPrompter();
        try {
            const onSigInt = (): void => { prompter.close(); exitFlushed(0); };
            process.once('SIGINT', onSigInt);
            const answer = await prompter.ask('Select an option [1-3/q]: ');
            process.removeListener('SIGINT', onSigInt);

            if (answer === null || answer === '' || answer === 'q') {
                exitFlushed(0);
            }

            if (answer === '1') {
                // GUI Mode — sub-prompt for local or tailnet, then re-spawn.
                for (;;) {
                    console.log('');
                    console.log('  GUI Mode:');
                    console.log('    [1] switchboard local   (serve the loopback board)');
                    console.log('    [2] switchboard tailnet  (serve loopback AND your tailnet)');
                    console.log('    [q] Back to Main Menu');
                    const sub = await prompter.ask('  Select [1-2/q]: ');
                    if (sub === null || sub === '' || sub === 'q') { break; }
                    if (sub === '1' || sub === '2') {
                        const serveSub = sub === '1' ? 'local' : 'tailnet';
                        prompter.close();
                        // Re-spawn the process with the serve subcommand. The
                        // child inherits the TTY and runs the full existing
                        // serve path (first-run DB menu, port fallback, browser
                        // open, detach). The menu process is replaced.
                        const child = spawn(process.execPath, [__filename, serveSub], { stdio: 'inherit' });
                        const code: number = await new Promise((resolve) => {
                            child.on('exit', (c) => resolve(c ?? 0));
                            child.on('error', (err) => {
                                console.error(`[switchboard] Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
                                resolve(1);
                            });
                        });
                        exitFlushed(code);
                    }
                    // Invalid sub-choice — re-prompt.
                }
                // Back to main menu (q/empty on sub-prompt).
                prompter.close();
                continue;
            }

            if (answer === '2') {
                if (port !== null) {
                    // Server online — hand off to the board console.
                    prompter.close();
                    await cmdBoardConsole(workspaceRoot);
                    return;
                }
                // Offline — offer to boot a detached local server.
                const start = await prompter.ask('  Server is offline. Start local server now? [Y/n] ');
                if (start === null) { exitFlushed(0); }
                if (start === '' || start.toLowerCase() === 'y') {
                    // Close our readline BEFORE the child inherits stdin. The
                    // child may run firstRunDatabaseMenu on the same TTY, and
                    // two readline interfaces reading one tty split the
                    // operator's keystrokes between them.
                    prompter.close();
                    // Spawn `switchboard local --detach` — the intermediate
                    // process prints its startup messages, forks the actual
                    // detached server, and exits. We then poll for the server
                    // to be answering /health.
                    const child = spawn(process.execPath, [__filename, 'local', '--detach'], { stdio: 'inherit' });
                    const startCode: number = await new Promise((resolve) => {
                        child.on('exit', (c) => resolve(c ?? 1));
                        child.on('error', (err) => {
                            console.error(`[switchboard] Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
                            resolve(1);
                        });
                    });
                    if (startCode !== 0) {
                        // The intermediate polls /health for 15s itself and
                        // prints its own diagnosis before exiting non-zero.
                        // Polling a second time would add 15 silent seconds and
                        // a duplicate error to a failure already reported.
                        exitFlushed(startCode);
                    }
                    const AUTO_START_TIMEOUT_MS = 15000;
                    const autoStartBegin = Date.now();
                    let autoPort: number | null = null;
                    while (Date.now() - autoStartBegin < AUTO_START_TIMEOUT_MS) {
                        autoPort = await findRunningInstance(workspaceRoot);
                        if (autoPort !== null) break;
                        await new Promise(r => setTimeout(r, 250));
                    }
                    if (autoPort === null) {
                        console.error(`[switchboard] Detached server failed to start within ${AUTO_START_TIMEOUT_MS / 1000}s.`);
                        console.error('[switchboard] Check the log file: .switchboard/logs/server.log');
                        exitFlushed(1);
                    }
                    prompter.close();
                    await cmdBoardConsole(workspaceRoot);
                    return;
                }
                // Declined — loop back to the main menu.
                prompter.close();
                continue;
            }

            if (answer === '3') {
                prompter.close();
                // Re-spawn with the `setup` subcommand rather than calling
                // cmdSetup() here. cmdSetup does NOT run the wizard's choice
                // itself: it rewrites process.argv ('setup' -> 'init' /
                // 'scaffold' / 'control-plane') and returns, relying on main()
                // to fall through to those handlers. From the bare front door
                // that fallthrough is impossible twice over — argv carries no
                // 'setup' token to rewrite, and the init/scaffold/control-plane
                // handlers sit ABOVE this routing point in main(). Calling it
                // in-process makes every wizard choice a no-op that then falls
                // through to the serve path and silently starts a board.
                const child = spawn(process.execPath, [__filename, 'setup'], { stdio: 'inherit' });
                const code: number = await new Promise((resolve) => {
                    child.on('exit', (c) => resolve(c ?? 0));
                    child.on('error', (err) => {
                        console.error(`[switchboard] Failed to open the setup wizard: ${err instanceof Error ? err.message : String(err)}`);
                        resolve(1);
                    });
                });
                exitFlushed(code);
            }

            // Invalid input — re-prompt (loop continues).
            prompter.close();
        } finally {
            prompter.close();
        }
    }
}

/**
 * `switchboard` (bare) — interactive board console.
 *
 * Connects to the running server and presents a menu: browse by column, search,
 * filter by project, inspect fleet, or type a plan prefix to dispatch directly.
 * If no server is running, exits 1 with advice.
 */
async function cmdBoardConsole(workspaceRoot: string): Promise<void> {
    const port = await findRunningInstance(workspaceRoot);
    if (port === null) {
        console.error('[switchboard] No running Switchboard instance for this workspace.');
        console.error('[switchboard] Start one with `switchboard local` (this machine) or `switchboard tailnet` (your tailnet).');
        exitFlushed(1);
    }

    let health: Awaited<ReturnType<typeof getHealthJson>>;
    try {
        health = await getHealthJson(port);
    } catch {
        console.error('[switchboard] No running Switchboard instance for this workspace.');
        exitFlushed(1);
    }

    const version = readVersion();
    const seats = health.terminals ?? [];

    // Board summary — fetch column counts.
    let boardSummary = '';
    try {
        const plansRes = await apiGet(port, '/kanban/plans', workspaceRoot);
        if (plansRes.status === 200) {
            const plans = extractPlans(plansRes.json());
            if (plans.length > 0) {
                const colCounts: Record<string, number> = {};
                for (const p of plans) {
                    const col = String(p?.kanbanColumn || '?');
                    colCounts[col] = (colCounts[col] || 0) + 1;
                }
                const cols = Object.entries(colCounts);
                if (cols.length > 0) {
                    boardSummary = 'BOARD SUMMARY:\n  ' + cols.map(([col, n]) => `${col} (${n})`).join('  ·  ');
                }
            }
        }
    } catch { /* */ }

    console.log(banner(version));
    console.log(`  Active Server:    http://127.0.0.1:${port}`);
    console.log(`  Workspace:        ${health.selectedWorkspaceRoot ?? workspaceRoot}`);
    console.log(`  Active Fleet:     ${seats.length} seat${seats.length === 1 ? '' : 's'}`);
    if (boardSummary) { console.log(''); console.log(boardSummary); }
    console.log('');
    console.log('MENU:');
    console.log('  [1] Browse & Dispatch by Column');
    console.log('  [2] Search Plans & Features (keyword, title, or UUID prefix)');
    console.log('  [3] Filter by Project');
    console.log('  [4] Inspect Fleet Status');
    console.log('  [5] Setup & Scaffolding Wizard');
    console.log('  [q] Exit (or Enter)');
    console.log('');

    const prompter = openPrompter();
    try {
        const onSigInt = (): void => { prompter.close(); exitFlushed(0); };
        process.once('SIGINT', onSigInt);

        const answer = await prompter.ask('Select an option [1-5] (or enter plan ID / prefix to dispatch): ');
        process.removeListener('SIGINT', onSigInt);

        if (answer === null || answer === '' || answer === 'q') { exitFlushed(0); }

        // Numeric menu option.
        if (/^[1-5]$/.test(answer)) {
            switch (answer) {
                case '1': {
                    // Browse by column — list all columns, let user pick one.
                    const plansRes = await apiGet(port, '/kanban/plans', workspaceRoot);
                    if (plansRes.status !== 200) {
                        console.error(`[switchboard] Could not fetch plans (HTTP ${plansRes.status}).`);
                        exitFlushed(1);
                    }
                    const plans = extractPlans(plansRes.json());
                    if (plans.length === 0) {
                        console.log('[switchboard] No cards on the board.');
                        exitFlushed(0);
                    }
                    const colCounts: Record<string, number> = {};
                    for (const p of plans) {
                        const col = String(p?.kanbanColumn || '?');
                        colCounts[col] = (colCounts[col] || 0) + 1;
                    }
                    const cols = Object.keys(colCounts);
                    console.log('\nColumns:');
                    cols.forEach((col, i) => console.log(`  ${i + 1}. ${col} (${colCounts[col]})`));
                    const colAnswer = await prompter.ask('\nSelect a column [1-' + cols.length + ']: ');
                    if (colAnswer === null || colAnswer === '') { exitFlushed(0); }
                    const colNum = parseInt(colAnswer, 10);
                    if (isNaN(colNum) || colNum < 1 || colNum > cols.length) {
                        console.error(`[switchboard] Invalid selection '${colAnswer}'.`);
                        exitFlushed(5);
                    }
                    const selectedCol = cols[colNum - 1];
                    const colPlans = plans.filter((p: any) => String(p?.kanbanColumn) === selectedCol);
                    console.log(`\n${selectedCol} (${colPlans.length}):`);
                    colPlans.forEach((p: any, i: number) => console.log(`  ${formatPlanLine(p, i)}`));
                    if (colPlans.length === 0) { exitFlushed(0); }
                    const pickAnswer = await prompter.ask('\nSelect a card to dispatch [1-' + colPlans.length + '] (or Enter to exit): ');
                    if (pickAnswer === null || pickAnswer === '') { exitFlushed(0); }
                    const pickNum = parseInt(pickAnswer, 10);
                    if (isNaN(pickNum) || pickNum < 1 || pickNum > colPlans.length) {
                        console.error(`[switchboard] Invalid selection '${pickAnswer}'.`);
                        exitFlushed(5);
                    }
                    const selected = colPlans[pickNum - 1];
                    const planId = String(selected?.planId || '');
                    console.log(`\n[switchboard] Dispatching ${shortPrefix(planId)} (${planTitle(selected)})…`);
                    await doDispatch(port, workspaceRoot, planId, 'auto');
                    break;
                }
                case '2': {
                    const q = await prompter.ask('Search query: ');
                    if (q === null || q === '') { exitFlushed(0); }
                    const plansRes = await apiGet(port, '/kanban/plans', workspaceRoot);
                    if (plansRes.status !== 200) { console.error(`[switchboard] Could not fetch plans (HTTP ${plansRes.status}).`); exitFlushed(1); }
                    const plans = extractPlans(plansRes.json());
                    const ql = q.toLowerCase();
                    const matches = plans.filter((p: any) => {
                        return planTitle(p).toLowerCase().includes(ql)
                            || String(p?.planFile || '').toLowerCase().includes(ql)
                            || String(p?.planId || '').toLowerCase().includes(ql);
                    });
                    if (matches.length === 0) { console.log('[switchboard] No matches.'); exitFlushed(0); }
                    console.log(`\n${matches.length} match${matches.length === 1 ? '' : 'es'}:`);
                    matches.forEach((p: any, i: number) => console.log(`  ${formatPlanLine(p, i)}`));
                    const pickAnswer = await prompter.ask('\nSelect a card to dispatch [1-' + matches.length + '] (or Enter to exit): ');
                    if (pickAnswer === null || pickAnswer === '') { exitFlushed(0); }
                    const pickNum = parseInt(pickAnswer, 10);
                    if (isNaN(pickNum) || pickNum < 1 || pickNum > matches.length) { console.error(`[switchboard] Invalid selection.`); exitFlushed(5); }
                    const selected = matches[pickNum - 1];
                    const planId = String(selected?.planId || '');
                    console.log(`\n[switchboard] Dispatching ${shortPrefix(planId)} (${planTitle(selected)})…`);
                    await doDispatch(port, workspaceRoot, planId, 'auto');
                    break;
                }
                case '3': {
                    const proj = await prompter.ask('Project name (or Enter for all): ');
                    if (proj === null) { exitFlushed(0); }
                    // Re-run ready with project filter.
                    const projArg = proj ? ['--project', proj] : [];
                    prompter.close();
                    await cmdReady(workspaceRoot, projArg);
                    break;
                }
                case '4': {
                    prompter.close();
                    await cmdFleet(workspaceRoot, []);
                    break;
                }
                case '5': {
                    prompter.close();
                    // The setup wizard is a separate workflow — print instructions
                    // rather than attempting in-process delegation (the init/scaffold
                    // handlers are above this point in main()'s flow and cannot be
                    // re-entered from here).
                    console.log('\n[switchboard] Setup & Scaffolding Wizard:');
                    console.log('  Run `switchboard setup` to access the interactive wizard,');
                    console.log('  or use a direct subcommand:');
                    console.log('    switchboard setup init [--target <agents|claude|both>]');
                    console.log('    switchboard setup scaffold --parent-dir <dir> --workspace-name <name> --repo <url>');
                    console.log('    switchboard setup control-plane <detect|preview|migrate>');
                    exitFlushed(0);
                }
            }
            exitFlushed(0);
        }

        // Not numeric — try as a plan prefix to dispatch directly.
        const resolved = await resolvePrefix(port, workspaceRoot, answer);
        if (resolved === null) {
            console.error(`[switchboard] No plan matches '${answer}'.`);
            exitFlushed(5);
        }
        if ('ambiguous' in resolved) {
            console.error(`[switchboard] Ambiguous prefix '${answer}' — matches ${resolved.ambiguous.length} cards:`);
            for (const pid of resolved.ambiguous) { console.error(`  ${shortPrefix(pid)}  ${pid}`); }
            exitFlushed(5);
        }
        const planId = (resolved as { planId: string }).planId;
        console.log(`\n[switchboard] Dispatching ${shortPrefix(planId)}…`);
        await doDispatch(port, workspaceRoot, planId, 'auto');
    } finally {
        prompter.close();
    }
}

async function main() {
    // ── Serve-mode whitelist ──────────────────────────────────────
    //
    // 'local' and 'tailnet' are the two serve subcommands. No subcommand (the
    // bare `npx switchboard`) means 'local' — the historical default. 'start'
    // is retired: it is the one subcommand an existing script or alias is most
    // likely to type, so it gets a dedicated redirect rather than the generic
    // unknown-subcommand error. Any other unrecognized leading token is NOT
    // silently treated as a hostname or serve mode — it is an error, because
    // the previous CLI accepted `npx switchboard --hostname foo` (no
    // subcommand) and that shape must keep working, but `npx switchboard foo`
    // (a bare token that is not a known subcommand) should not fall through to
    // serve and silently start a board.
    const KNOWN_SUBCOMMANDS = new Set([
        'local', 'tailnet', 'stop', 'status', 'logs', 'init', 'scaffold',
        'control-plane', 'secrets', 'token', 'export', 'import',
        'plans', 'ready', 'dispatch', 'clear', 'fleet', 'verb',
        'help', 'about', 'version', 'setup',
    ]);
    const firstArg = process.argv[2];
    const isFlag = firstArg && firstArg.startsWith('-');
    let serveMode: 'local' | 'tailnet';
    if (firstArg === 'start') {
        console.error('[switchboard] \'start\' has been replaced.');
        console.error('  Use \'switchboard local\'  — serve the board on this machine (loopback).');
        console.error('  Use \'switchboard tailnet\' — serve the board on this machine AND your tailnet.');
        process.exit(1);
    }
    if (firstArg && !isFlag && !KNOWN_SUBCOMMANDS.has(firstArg)) {
        console.error(`[switchboard] Unknown subcommand '${firstArg}'.`);
        console.error('  Serve modes: switchboard local | switchboard tailnet');
        console.error('  Run \'switchboard --help\' for the full command list.');
        process.exit(1);
    }
    if (firstArg === 'tailnet') {
        serveMode = 'tailnet';
        // Strip the subcommand so parseArgs sees only the options.
        process.argv.splice(2, 1);
    } else if (firstArg === 'local') {
        serveMode = 'local';
        process.argv.splice(2, 1);
    } else {
        // Bare `npx switchboard` or `npx switchboard --hostname foo` → local.
        serveMode = 'local';
    }

    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        cmdHelp(process.argv[3]);
    }
    if (args.version) {
        // `--json` is honoured here too: `about --json` and `--version --json`
        // are the same command and must not disagree about their output shape.
        await cmdAbout(path.resolve(args.workspace || process.cwd()), process.argv.includes('--json'));
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
    // `stop`, `status`, `logs`, and the board commands (`plans`, `ready`,
    // `dispatch`, `clear`, `fleet`, `verb`, `help`, `about`, `version`, `setup`)
    // are read-only queries against an existing .switchboard/ — they must not
    // create one in a directory that has none. The bare `switchboard` (no
    // subcommand) renders the front-door menu and writes nothing itself:
    // `!firstArg` covers it. Every branch of that menu that DOES write
    // re-spawns with a real subcommand (`local`/`tailnet`/`setup`), so the
    // child re-enters here with `firstArg` set and scaffolds normally.
    // Every other path (server start, secrets, init) does use workspaceRoot.
    const subcommand = process.argv[2];
    const subcommandTargetsCwd = !!firstArg
        && subcommand !== 'scaffold' && subcommand !== 'control-plane'
        && subcommand !== 'stop' && subcommand !== 'status' && subcommand !== 'logs'
        && subcommand !== 'plans' && subcommand !== 'ready' && subcommand !== 'dispatch'
        && subcommand !== 'clear' && subcommand !== 'fleet' && subcommand !== 'verb'
        && subcommand !== 'help' && subcommand !== 'about' && subcommand !== 'version'
        && subcommand !== 'setup';
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
                            // Exit here. Falling through returns to main(), which has no
                            // `token` guard left to stop it — it would reach the server
                            // launch path, hit the single-writer check against the very
                            // instance we just minted against, and print "already
                            // running" + exit 1 on top of a successful mint.
                            exitFlushed(0);
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
            // Every branch of the response handler above (and the error handler)
            // exits the process, so this await deliberately never resolves — it
            // only keeps the event loop alive until one of them does. Resolving on
            // 'close' instead would race the exit and let control fall through to
            // main()'s server-launch path.
            await new Promise<never>(() => { /* exits via the handlers above */ });
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


    if (process.argv[2] === 'export') {
        try {
            const db = await openBoardDatabase(workspaceRoot);
            const result = await makeTransferService(db, workspaceRoot).exportBundle({ outPath: args.out });
            if (!result.success) {
                console.error(`[switchboard] Transfer export failed: ${result.error || 'unknown error'}`);
                process.exit(1);
            }
            console.log(`Wrote ${result.path}`);
            console.log(`  ${result.cardCount} cards · ${result.settingCount} settings · 0 credentials`);
            if (result.settingsExcluded.length > 0) {
                console.log(`  – ${result.settingsExcluded.length} setting(s) excluded (machine-local): ${result.settingsExcluded.join(', ')}`);
            }
            if (result.untrackedPlanFiles.length > 0 || result.unpushedCommits > 0) {
                console.log(`  ⚠ ${result.untrackedPlanFiles.length} untracked plan/feature file(s) and ${result.unpushedCommits} unpushed commit(s) — push first or those`);
                console.log('    cards will not resolve on the destination.');
                for (const f of result.untrackedPlanFiles) { console.log(`      ${f}`); }
            }
            if (result.scpLine) {
                console.log(`\nMove it across, then import on the destination:\n  ${result.scpLine}`);
                console.log('  npx switchboard import switchboard-transfer.json');
            }
            process.exit(0);
        } catch (err) {
            console.error(`[switchboard] Transfer export failed: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    }

    if (process.argv[2] === 'import') {
        const bundleArg = process.argv[3];
        if (!bundleArg || bundleArg.startsWith('-')) {
            console.error('Usage: npx switchboard import <bundle.json> [--workspace <path>]');
            process.exit(1);
        }
        const bundlePath = resolveUserPath(bundleArg);
        if (!fs.existsSync(bundlePath)) {
            console.error(`[switchboard] Bundle not found: ${bundlePath}`);
            process.exit(1);
        }
        try {
            const db = await openBoardDatabase(workspaceRoot);
            const result = await makeTransferService(db, workspaceRoot).importBundle(bundlePath);
            if (!result.success) {
                console.error(`[switchboard] Transfer import failed: ${result.error || 'unknown error'}`);
                process.exit(1);
            }
            printImportResult(result);
            process.exit(0);
        } catch (err) {
            console.error(`[switchboard] Transfer import failed: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    }

    // `setup` is placed before init/scaffold/control-plane so it can delegate
    // by rewriting process.argv and returning — the code falls through to the
    // matching handler below.
    if (process.argv[2] === 'setup') {
        await cmdSetup(workspaceRoot, process.argv.slice(3));
        // cmdSetup exits or returns after rewriting process.argv.
        // If it returned, process.argv[2] is now init/scaffold/control-plane
        // and the matching handler below will fire.
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

    // ── help ──────────────────────────────────────────────────────
    if (process.argv[2] === 'help') {
        cmdHelp(process.argv[3]);
    }

    // ── about / version ───────────────────────────────────────────
    if (process.argv[2] === 'about' || process.argv[2] === 'version') {
        const jsonFlag = process.argv.slice(3).includes('--json');
        await cmdAbout(workspaceRoot, jsonFlag);
    }

    // ── plans ─────────────────────────────────────────────────────
    if (process.argv[2] === 'plans') {
        await cmdPlans(workspaceRoot, process.argv.slice(3));
    }

    // ── ready ─────────────────────────────────────────────────────
    if (process.argv[2] === 'ready') {
        await cmdReady(workspaceRoot, process.argv.slice(3));
    }

    // ── dispatch ──────────────────────────────────────────────────
    if (process.argv[2] === 'dispatch') {
        await cmdDispatch(workspaceRoot, process.argv.slice(3));
    }

    // ── clear ─────────────────────────────────────────────────────
    if (process.argv[2] === 'clear') {
        await cmdClear(workspaceRoot, process.argv.slice(3));
    }

    // ── fleet ─────────────────────────────────────────────────────
    if (process.argv[2] === 'fleet') {
        await cmdFleet(workspaceRoot, process.argv.slice(3));
    }

    // ── verb ──────────────────────────────────────────────────────
    if (process.argv[2] === 'verb') {
        await cmdVerb(workspaceRoot, process.argv.slice(3));
    }

    // ── Bare `switchboard`: interactive front-door menu ───────────
    //
    // No subcommand (truly bare `npx switchboard`) presents the top-level
    // Main Menu (GUI / CLI / Setup / Exit) regardless of whether a server
    // is running. This is the primary terminal interface — the default
    // front door. `switchboard local` and `switchboard tailnet` are the
    // serve commands; flags without a subcommand (e.g. `--hostname foo`)
    // still fall through to the serve path below for backward compatibility.
    if (!firstArg) {
        await cmdMainMenu(workspaceRoot);
    }

    // ── Server start path (local / tailnet / serve flags) ─────────
    const existing = await findRunningInstance(workspaceRoot);
    if (existing !== null) {
        console.error(`[switchboard] Another Switchboard instance is already running on port ${existing} for ${workspaceRoot}.`);
        console.error(`[switchboard] Reusing is not supported (single writer). Use that instance or shut it down.`);
        process.exit(1);
    }

    // ── Tailnet detection ─────────────────────────────────────────
    //
    // 'switchboard tailnet' reads the interface address itself — the operator
    // types a word, never an IP. detectTailnetAddress probes the CLI binary
    // (ordered absolute paths, never a bare spawn) then falls back to the
    // LocalAPI socket. A failure at both steps exits non-zero naming Tailscale,
    // never silently falls back to loopback-only, and never binds 0.0.0.0.
    let tailnetAddress: string | null = null;
    let magicDnsNames: string[] = [];
    if (serveMode === 'tailnet') {
        tailnetAddress = await detectTailnetAddress();
        if (!tailnetAddress) {
            console.error('[switchboard] Tailscale is not running on this machine (no interface address found).');
            console.error('[switchboard] Start Tailscale and retry, or use \'switchboard local\' for loopback-only access.');
            process.exit(1);
        }
        magicDnsNames = await resolveMagicDnsNames();
        console.log(`[switchboard] Tailnet address: ${tailnetAddress}${magicDnsNames.length ? ` (${magicDnsNames.join(', ')})` : ''}`);
    }

    // Under tailnet mode the hostname may also be a tailnet name; under local
    // mode only loopback names pass.
    const tailnetAcceptable = tailnetAddress ? [tailnetAddress, ...magicDnsNames] : [];
    const hostname = resolveHostname(args.hostname, tailnetAcceptable);

    // ── First run: no board yet ────────────────────────────────────
    //
    // Runs BEFORE the detach fork, so the prompt lands on the parent's TTY and
    // never on a child whose stdio is 'ignore'. Options 1 and 2 are pure file
    // side effects (the board file, or a db-pointer), so the child inherits them
    // with no plumbing; option 3's import has to be deferred until the plan files
    // are ingested, so it travels to the child as --import-bundle.
    let pendingBundlePath = args.importBundle;
    if (!pendingBundlePath && !boardExists(workspaceRoot) && process.stdin.isTTY && !isDetachedChildProcess()) {
        const menu = await firstRunDatabaseMenu(workspaceRoot);
        if (menu.cancelled) {
            console.log('\n[switchboard] Cancelled — no board was created.');
            process.exit(1);
        }
        pendingBundlePath = menu.pendingBundlePath;
    }

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
        // host has no browser to open). Re-inject the serve subcommand so the
        // child re-enters the same mode (tailnet detection runs again in the
        // child — the address is stable across the fork).
        const childArgv = process.argv.slice(2).filter(a => a !== '--detach');
        if (serveMode === 'tailnet' && !childArgv.includes('tailnet')) {
            childArgv.unshift('tailnet');
        } else if (serveMode === 'local' && !childArgv.includes('local')) {
            childArgv.unshift('local');
        }
        if (!args.open && !childArgv.includes('--no-open')) {
            childArgv.push('--no-open');
        }
        // The menu ran in this process; the child is the one that boots the
        // ingestion engine, so the deferred import has to cross the fork.
        if (pendingBundlePath && !childArgv.includes('--import-bundle')) {
            childArgv.push('--import-bundle', pendingBundlePath);
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
        if (tailnetAddress) {
            console.log(`  Tailnet: http://${tailnetAddress}:${detachPort}/ (no token, on your tailnet only)`);
        }
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
    const isDetachedChild = isDetachedChildProcess();
    const logsDir = path.join(switchboardDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, 'server.log');
    setupFileLogging(logFile, !isDetachedChild);

    // Default port is 7777 (parseArgs). If it is taken, fall back to ephemeral
    // (port 0) and log the fallback. `--port 0` is an explicit opt-in to ephemeral.
    //
    // The probe happens BEFORE the boot, not as a catch-and-retry around it:
    // startHeadlessSwitchboard opens the kanban DB, initialises the plan-ingestion
    // engine (which attaches fs watchers) and constructs the PTY fleet well before
    // it calls server.start(), and it disposes none of that when the listen fails.
    // Retrying after an EADDRINUSE would therefore leave the half-built first
    // instance's watchers and DB handle live and stack a second full instance on
    // top — two engines importing the same plan files. Probing first keeps the
    // fallback to exactly one boot.
    let listenPort = args.port;
    if (typeof listenPort === 'number' && listenPort > 0 && !(await isPortFree(listenPort))) {
        console.warn(`[switchboard] Port ${listenPort} is in use, falling back to an ephemeral port.`);
        listenPort = 0;
    }
    // Loaded here rather than at module scope: every non-serving subcommand
    // (export, import, token, secrets, status, stop, logs) would otherwise pull in
    // the entire host graph — sync services, the PTY backend, node-pty probing —
    // to print one line. `import type` above is erased, so nothing loads until a
    // board is actually being served.
    const { startHeadlessSwitchboard } = require('./bootstrap') as {
        startHeadlessSwitchboard: (opts: HeadlessSwitchboardOptions) => Promise<HeadlessSwitchboardInstance>;
    };
    const bindPolicy = tailnetAddress
        ? { tailnetAddress, magicDnsNames }
        : { loopbackOnly: true as const };
    const instance = await startHeadlessSwitchboard({
        workspaceRoot,
        port: listenPort,
        hostname,
        verbose: true,
        bindPolicy,
    });

    await waitForHealth(instance.port);

    const displayHost = new URL(instance.url).hostname;
    const boardUrl = `${instance.url}/?token=${instance.oneTimeToken}`;

    console.log(`\nSwitchboard is running at ${instance.url}`);
    if (instance.usingDurableToken) {
        console.log(`Board URL (one-time token, expires in 15 minutes): ${boardUrl}`);
        console.log(`To enrol another device or re-enter after expiry: npx switchboard token show`);
    } else {
        // Ephemeral mode: this token does not expire, because there is no durable
        // secret for `token show` to authenticate a replacement mint with.
        console.log(`Board URL (one-time token): ${boardUrl}`);
        console.log(`For a token that survives restarts and can enrol a second device: npx switchboard token rotate`);
    }
    if (tailnetAddress) {
        // Tailnet mode: no token is required on the tailnet listener (decision 4:
        // tailnet membership is the control). Print the bare tailnet URL so the
        // operator can hand it to a phone or tablet on the same tailnet.
        const tailnetUrl = `http://${tailnetAddress}:${instance.port}/`;
        console.log(`\nTailnet URL (no token needed, on your tailnet only): ${tailnetUrl}`);
        if (magicDnsNames.length > 0) {
            console.log(`  MagicDNS: ${magicDnsNames.map(n => `http://${n}:${instance.port}/`).join(', ')}`);
        }
    }
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

    if (pendingBundlePath) {
        await runPendingBundleImport(workspaceRoot, pendingBundlePath);
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
