/**
 * resolveApiTarget — the Node client's single board-resolution seam (plan:
 * the-cli-reaches-a-remote-board-over-the-tailnet, "A tagged ApiTarget").
 *
 * Every command resolves an ApiTarget ONCE before its first request. The
 * target is { baseUrl, workspaceRoot, auth, source } and every value carries
 * where it came from — "which host and which board answered?" must be
 * answerable after the fact (the fallback rule applied to a routing read).
 * The shape mirrors the Go client's shipped resolver (internal/client/
 * resolve.go): same env names, same precedence, same refusals. Client parity
 * is this card's divergence rule — a behaviour that differs by which binary
 * the operator installed is a failure, not a porting detail.
 *
 * Endpoint precedence, highest first:
 *   --remote <name|url>  (a URL is equivalent to --server; a bare name resolves
 *   through remotes.json) → SWITCHBOARD_REMOTE (name or URL) →
 *   --server/--endpoint/SWITCHBOARD_SERVER_URL (URL only) → remotes.json
 *   `defaultRemote` → local discovery.
 *
 * Root precedence: --workspace-root / SWITCHBOARD_WORKSPACE_ROOT → the stored
 * remote's root → single-root auto-pick tagged `health-roots` → refusal
 * listing the advertised roots. A remote root is NEVER guessed — the remote's
 * /health names its roots, and `selectedWorkspaceRoot` is never read as a
 * fallback (it is the quiet-wrong-answer shape).
 *
 * Token precedence: SWITCHBOARD_API_TOKEN → --token-file → workspace token
 * file → tagged none. A token value is never accepted in argv.
 *
 * There is no fallback between tiers: a named remote that fails to resolve is
 * an error, never a demotion to local. When an explicit or env endpoint
 * resolves, local discovery is skipped entirely — a seat carrying
 * SWITCHBOARD_SERVER_URL never touches findRunningInstance. A remote that is
 * unreachable resolves to an error naming it, never to the local board.
 *
 * This module is deliberately free of cli.ts imports — cli.ts runs main() at
 * load. The sibling subtask (*Every Node command dials the resolved target*)
 * converts the call sites; this module only exports the resolver.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { stateFile } from '../utils/stateHome';
import { PORT_BASE, PORT_SPAN } from '../utils/portResolver';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ApiTarget {
    /** e.g. 'http://labcom.taile9aab9.ts.net:7777' | 'https://labcom...ts.net' | 'http://127.0.0.1:7777' */
    baseUrl: string;
    /** The REMOTE's root (from its /health or the stored remote), or the local cwd root for a local target. */
    workspaceRoot: string;
    /** Where workspaceRoot came from — 'flag:--workspace-root' | 'env:SWITCHBOARD_WORKSPACE_ROOT' | 'config:remotes.<name>.workspaceRoot' | 'health-roots' | 'local:cwd'. */
    rootSource: string;
    auth: { token: string; source: string } | { token: null; source: 'tailnet-listener-trusted' | 'none' };
    /** 'flag:--remote labcom' | 'env:SWITCHBOARD_REMOTE' | 'env:SWITCHBOARD_SERVER_URL' | 'flag:--server' | 'config:remotes.labcom' | 'local:port-file' | 'local:probe' */
    source: string;
    /** True when the endpoint came from any explicit/env/config tier — NOT local discovery. */
    isRemote: boolean;
    /** The remotes.json entry name, when the endpoint resolved through one. */
    remoteName?: string;
}

export interface ResolveApiTargetOptions {
    /** --remote <name|url>. */
    remote?: string;
    /** --server / --endpoint <url>. */
    server?: string;
    /** --workspace-root <server-path>. */
    workspaceRoot?: string;
    /** --token-file <path>. */
    tokenFile?: string;
    /** Client-local cwd. Default process.cwd(). */
    clientCwd?: string;
    /** Env snapshot (injectable for tests). Default process.env. */
    env?: Record<string, string | undefined>;
    /** remotes.json path (injectable for tests). Default stateFile('remotes.json') — which honours SWITCHBOARD_STATE_HOME first, then ~/.switchboard. */
    remotesPath?: string;
    /** Health fetch (injectable for tests). Default fetchHealthJson. */
    fetchHealth?: (baseUrl: string, timeoutMs: number) => Promise<HealthJson>;
    /** Local discovery (injectable for tests). Default discoverLocalBoard. */
    discoverLocal?: (cwd: string) => Promise<{ port: number; via: 'probe' | 'port-file' } | null>;
}

/** The subset of /health the resolver reads. Extra fields pass through unused. */
export interface HealthJson {
    service?: string;
    status?: string;
    port?: number;
    pid?: number;
    roots?: string[];
    selectedWorkspaceRoot?: string | null;
    [k: string]: unknown;
}

/** A named remote as stored in ~/.switchboard/remotes.json by `switchboard remote add`. */
export interface StoredRemote {
    url: string;
    workspaceRoot?: string;
    roots?: string[];
    lastContact?: string;
}

export interface RemotesConfig {
    defaultRemote?: string;
    remotes?: Record<string, StoredRemote>;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * The remote endpoint advertised more than one root and none was named —
 * the refusal lists them so the operator can pick one with --workspace-root.
 * Mirrors the Go client's MissingRootError (resolve.go).
 */
export class MissingRootError extends Error {
    public constructor(public readonly roots: string[]) {
        super('no server workspace root supplied');
        this.name = 'MissingRootError';
    }
}

/**
 * A stored remote's recorded root is absent from the remote's CURRENT
 * /health.roots — the board's roots changed since `remote add`. Refuse and
 * re-list; never silently switch to a surviving root.
 */
export class StaleRemoteRootError extends Error {
    public constructor(
        public readonly remoteName: string,
        public readonly storedRoot: string,
        public readonly roots: string[],
    ) {
        super(`stored root '${storedRoot}' for remote '${remoteName}' is not advertised by the board (stale)`);
        this.name = 'StaleRemoteRootError';
    }
}

// ─── URL parsing (mirrors internal/client/resolve.go parseServerURL) ────────

interface ParsedEndpoint {
    baseUrl: string;
    host: string;
    port: number;
    scheme: 'http' | 'https';
}

/**
 * Validate an explicit remote URL. Accepts only http/https, rejects embedded
 * credentials, requires an explicit port — EXCEPT https, where the absent
 * port means 443 (the `tailscale serve` spelling `https://host` is the
 * natural way to name that endpoint). Mirrors the Go parseServerURL.
 */
function parseServerUrl(raw: string): ParsedEndpoint {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new Error(`invalid server URL '${raw}'`);
    }
    const scheme = u.protocol.replace(':', '');
    if (scheme !== 'http' && scheme !== 'https') {
        throw new Error(`scheme must be http or https, got '${scheme}'`);
    }
    if (u.username || u.password) {
        throw new Error('embedded credentials are not allowed in the server URL');
    }
    if (!u.hostname) {
        throw new Error('missing host');
    }
    let port: number;
    if (u.port) {
        port = parseInt(u.port, 10);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
            throw new Error(`invalid port '${u.port}'`);
        }
    } else if (scheme === 'https') {
        port = 443;
    } else {
        throw new Error('missing port — the board endpoint must include an explicit port');
    }
    // Base URL is scheme://host[:port], no path, no trailing slash — the same
    // construction as Go's parseServerURL (u.host keeps an explicit port and
    // IPv6 brackets; a defaulted port is appended only when absent).
    const base = u.host.includes(':') ? `${scheme}://${u.host}` : `${scheme}://${u.host}:${port}`;
    return { baseUrl: base.replace(/\/+$/, ''), host: u.hostname, port, scheme };
}

// ─── remotes.json (read side; written by `switchboard remote`) ──────────────

/**
 * Read remotes.json. An absent file is an ABSENT TIER, not an error (null).
 * A corrupt file is surfaced as corrupt — `catch { return {} }` on a config
 * load reads a broken file as an unconfigured one, which is the exact
 * fallback shape the rules forbid.
 */
export function loadRemotesConfig(remotesPath: string): RemotesConfig | null {
    let raw: string;
    try {
        raw = fs.readFileSync(remotesPath, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') { return null; }
        throw err;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`remotes.json at ${remotesPath} is corrupt: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`remotes.json at ${remotesPath} is corrupt: top level is not an object`);
    }
    return parsed as RemotesConfig;
}

interface ResolvedEndpoint extends ParsedEndpoint {
    source: string;
    remoteName?: string;
    storedRoot?: string;
}

/**
 * Resolve a name-or-URL remote spec. A URL parses directly (equivalent to
 * --server). A bare name resolves through remotes.json — a named remote that
 * fails to resolve is an error, NEVER a demotion to local.
 */
function resolveRemoteSpec(spec: string, remotesPath: string): Omit<ResolvedEndpoint, 'source'> {
    if (spec.includes('://')) {
        return parseServerUrl(spec);
    }
    const cfg = loadRemotesConfig(remotesPath);
    if (!cfg) {
        throw new Error(`remote '${spec}' is not configured — no remotes.json at ${remotesPath}`);
    }
    const entry = cfg.remotes?.[spec];
    if (!entry) {
        throw new Error(`remote '${spec}' is not configured in ${remotesPath}`);
    }
    if (typeof entry.url !== 'string' || !entry.url.trim()) {
        throw new Error(`remote '${spec}' in ${remotesPath} has no url`);
    }
    let ep: ParsedEndpoint;
    try {
        ep = parseServerUrl(entry.url);
    } catch (err) {
        throw new Error(`remote '${spec}' in ${remotesPath} has an unusable url '${entry.url}': ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
        ...ep,
        remoteName: spec,
        storedRoot: typeof entry.workspaceRoot === 'string' && entry.workspaceRoot.trim() ? entry.workspaceRoot.trim() : undefined,
    };
}

// ─── Health fetch (http + https, self-contained) ────────────────────────────

/**
 * Fetch and validate /health at a resolved base URL. The scheme picks the
 * transport — a `tailscale serve` HTTPS endpoint is dialed with TLS while the
 * board it fronts still reports its http port. Sends the positive client
 * marker unconditionally (the CSRF guard's non-loopback path accepts it).
 */
export function fetchHealthJson(baseUrl: string, timeoutMs = 2000): Promise<HealthJson> {
    return new Promise((resolve, reject) => {
        const mod = baseUrl.startsWith('https:') ? https : http;
        const req = mod.get(`${baseUrl}/health`, { headers: { 'X-Switchboard-Client': 'switchboard-cli' } }, (res) => {
            let body = '';
            res.on('data', (c: Buffer) => body += c.toString());
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
        req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch { /* */ } reject(new Error('Health check timed out')); });
    });
}

/**
 * Name an unreachable remote precisely. ENOTFOUND/EAI_AGAIN is the rename
 * case ("the machine may have been renamed"), ECONNREFUSED is a reachable
 * host with a stopped board. Distinguishing them is the difference between
 * "check the name" and "start the board".
 */
function unreachableMessage(ep: ResolvedEndpoint, err: unknown): string {
    // Name the resolved URL AND the tier that produced it — "the URL and the
    // env var" is what the operator edits.
    const target = ep.remoteName
        ? `remote '${ep.remoteName}' (${ep.baseUrl}, via ${ep.source})`
        : `remote ${ep.baseUrl} (via ${ep.source})`;
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return `${target} does not resolve — the machine may have been renamed or is off the tailnet`;
    }
    if (code === 'ECONNREFUSED') {
        return `${target} refused the connection — the host is reachable but the board is not listening`;
    }
    return `${target} is unreachable: ${err instanceof Error ? err.message : String(err)}`;
}

// ─── Local discovery (mirrors cli.ts findRunningInstance, source-tagged) ────

/**
 * Probe the loopback port span for a board whose /health.roots contains the
 * client cwd, then fall back to the workspace port file. Returns the port and
 * WHICH mechanism answered — 'local:probe' vs 'local:port-file' are different
 * sources and the target records which one fired.
 */
export async function discoverLocalBoard(cwd: string): Promise<{ port: number; via: 'probe' | 'port-file' } | null> {
    const targetRoot = path.resolve(cwd);
    for (let i = 0; i < PORT_SPAN; i++) {
        const port = PORT_BASE + i;
        try {
            const json = await fetchHealthJson(`http://127.0.0.1:${port}`, 500);
            if (Array.isArray(json.roots) && json.roots.some(r => typeof r === 'string' && path.resolve(r) === targetRoot)) {
                return { port, via: 'probe' };
            }
        } catch { /* not listening, not switchboard, or timed out */ }
    }
    const portFile = path.join(cwd, '.switchboard', 'api-server-port.txt');
    try {
        const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
        if (Number.isInteger(port) && port > 0) {
            const json = await fetchHealthJson(`http://127.0.0.1:${port}`, 2000);
            if (json.service === 'switchboard') { return { port, via: 'port-file' }; }
        }
    } catch { /* no port file, unreadable, or board down */ }
    return null;
}

// ─── The resolver ───────────────────────────────────────────────────────────

/**
 * Resolve the board a command talks to. See the module docblock for the
 * precedence contract — it is identical to the Go client's.
 */
export async function resolveApiTarget(opts: ResolveApiTargetOptions = {}): Promise<ApiTarget> {
    const env = opts.env ?? process.env;
    const cwd = opts.clientCwd ?? process.cwd();
    const remotesPath = opts.remotesPath ?? stateFile('remotes.json');
    const fetchHealth = opts.fetchHealth ?? fetchHealthJson;
    const discoverLocal = opts.discoverLocal ?? discoverLocalBoard;

    const flagRemote = (opts.remote ?? '').trim();
    const flagServer = (opts.server ?? '').trim();
    const envRemote = (env.SWITCHBOARD_REMOTE ?? '').trim();
    const envServer = (env.SWITCHBOARD_SERVER_URL ?? '').trim();

    let ep: ResolvedEndpoint;

    // A conflict pair is only checked when ITS tier is the winning one — a
    // higher-tier answer outranks a disagreeing lower pair.
    if (flagRemote) {
        const a = resolveRemoteSpecChecked(flagRemote, remotesPath, '--remote');
        if (flagServer) {
            const b = parseServerUrlChecked(flagServer, '--server');
            if (a.baseUrl !== b.baseUrl) {
                throw new Error(`conflicting endpoints: --remote '${flagRemote}' resolves to ${a.baseUrl} but --server names ${b.baseUrl} — pick one`);
            }
        }
        ep = { ...a, source: `flag:--remote ${flagRemote}` };
    } else if (envRemote) {
        const a = resolveRemoteSpecChecked(envRemote, remotesPath, 'SWITCHBOARD_REMOTE');
        if (envServer) {
            const b = parseServerUrlChecked(envServer, 'SWITCHBOARD_SERVER_URL');
            if (a.baseUrl !== b.baseUrl) {
                throw new Error(`conflicting endpoints: SWITCHBOARD_REMOTE '${envRemote}' resolves to ${a.baseUrl} but SWITCHBOARD_SERVER_URL names ${b.baseUrl} — pick one`);
            }
        }
        ep = { ...a, source: 'env:SWITCHBOARD_REMOTE' };
    } else if (flagServer) {
        ep = { ...parseServerUrlChecked(flagServer, '--server'), source: 'flag:--server' };
    } else if (envServer) {
        ep = { ...parseServerUrlChecked(envServer, 'SWITCHBOARD_SERVER_URL'), source: 'env:SWITCHBOARD_SERVER_URL' };
    } else {
        // Configured default remote — a stored default IS a named remote and
        // routes bare commands; absent config is an absent tier.
        const cfg = loadRemotesConfig(remotesPath);
        const def = (cfg?.defaultRemote ?? '').trim();
        if (def) {
            const a = resolveRemoteSpecChecked(def, remotesPath, 'default remote');
            ep = { ...a, source: `config:remotes.${def}` };
        } else {
            // Local discovery — today's local path, untouched.
            const local = await discoverLocal(cwd);
            if (!local) {
                throw new Error('no running Switchboard instance found for this workspace');
            }
            ep = {
                baseUrl: `http://127.0.0.1:${local.port}`,
                host: '127.0.0.1',
                port: local.port,
                scheme: 'http',
                source: local.via === 'probe' ? 'local:probe' : 'local:port-file',
            };
        }
    }

    const isRemote = !ep.source.startsWith('local:');

    // A remote endpoint's health is fetched during resolution — the root
    // tiers below need it, and an unreachable remote is an error naming it,
    // never a demotion to the local board.
    let health: HealthJson | undefined;
    if (isRemote) {
        try {
            health = await fetchHealth(ep.baseUrl, 2000);
        } catch (err) {
            throw new Error(unreachableMessage(ep, err));
        }
    }

    // ── Root tier ────────────────────────────────────────────────────────
    const flagRoot = (opts.workspaceRoot ?? '').trim();
    const envRoot = (env.SWITCHBOARD_WORKSPACE_ROOT ?? '').trim();
    let workspaceRoot: string;
    let rootSource: string;
    if (flagRoot) {
        workspaceRoot = flagRoot;
        rootSource = 'flag:--workspace-root';
    } else if (envRoot) {
        workspaceRoot = envRoot;
        rootSource = 'env:SWITCHBOARD_WORKSPACE_ROOT';
    } else if (!isRemote) {
        // Local: today's path — the client cwd IS the board root.
        workspaceRoot = path.resolve(cwd);
        rootSource = 'local:cwd';
    } else if (ep.storedRoot) {
        // The stored remote's root. Stale check: a remote that advertises
        // roots but not THIS one is a changed board — refuse and re-list,
        // never silently switch to a surviving root. Absent roots (version
        // skew) is absence, not a mismatch — the stored value stands.
        if (Array.isArray(health!.roots) && health!.roots.length > 0
            && !health!.roots.some(r => path.resolve(r) === path.resolve(ep.storedRoot!))) {
            throw new StaleRemoteRootError(ep.remoteName ?? '', ep.storedRoot, health!.roots);
        }
        workspaceRoot = ep.storedRoot;
        rootSource = `config:remotes.${ep.remoteName}.workspaceRoot`;
    } else if (Array.isArray(health!.roots) && health!.roots.length === 1) {
        // One advertised root: use it, tagged — never the remote's
        // selectedWorkspaceRoot, which is the quiet-wrong-answer shape.
        workspaceRoot = health!.roots[0];
        rootSource = 'health-roots';
    } else if (Array.isArray(health!.roots) && health!.roots.length > 1) {
        throw new MissingRootError(health!.roots);
    } else {
        throw new Error('no server workspace root supplied and none advertised');
    }

    // ── Token tier ───────────────────────────────────────────────────────
    let auth: ApiTarget['auth'] | undefined;
    const envToken = (env.SWITCHBOARD_API_TOKEN ?? '').trim();
    if (envToken) {
        auth = { token: envToken, source: 'env:SWITCHBOARD_API_TOKEN' };
    } else {
        const tf = (opts.tokenFile ?? '').trim();
        if (tf) {
            // An explicitly requested credential source that fails is an
            // ERROR, never a demotion — the same no-inter-tier-fallback rule
            // as the endpoint chain. A silent fallthrough would produce a
            // target byte-identical to a correct resolution but tagged
            // `tailnet-listener-trusted`: the tag asserting no credential is
            // the CORRECT posture when one was requested and could not be
            // read. Tag it or fail loudly; a wrong tag is neither.
            let v = '';
            try {
                v = fs.readFileSync(tf, 'utf8').trim();
            } catch (err) {
                throw new Error(`--token-file '${tf}': cannot read token — ${err instanceof Error ? err.message : String(err)}`);
            }
            if (!v) {
                throw new Error(`--token-file '${tf}': file is empty — no token to send`);
            }
            auth = { token: v, source: 'flag:--token-file' };
        }
        if (!auth) {
            try {
                const v = fs.readFileSync(path.join(cwd, '.switchboard', 'api-server-token.txt'), 'utf8').trim();
                if (v) { auth = { token: v, source: 'token-file' }; }
            } catch { /* no workspace token file */ }
        }
        if (!auth) {
            // A remote seat is trusted by the tailnet listener — no credential
            // is the CORRECT posture there, not a missing one.
            auth = { token: null, source: isRemote ? 'tailnet-listener-trusted' : 'none' };
        }
    }

    return {
        baseUrl: ep.baseUrl,
        workspaceRoot,
        rootSource,
        auth,
        source: ep.source,
        isRemote,
        remoteName: ep.remoteName,
    };
}

function resolveRemoteSpecChecked(spec: string, remotesPath: string, label: string) {
    try {
        return resolveRemoteSpec(spec, remotesPath);
    } catch (err) {
        throw new Error(`${label} '${spec}': ${err instanceof Error ? err.message : String(err)}`);
    }
}

function parseServerUrlChecked(raw: string, label: string): ParsedEndpoint {
    try {
        return parseServerUrl(raw);
    } catch (err) {
        throw new Error(`${label} '${raw}': ${err instanceof Error ? err.message : String(err)}`);
    }
}
