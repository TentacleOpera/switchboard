/**
 * Tailscale interface address detection.
 *
 * `switchboard tailnet` reads the interface address itself — the operator types
 * a word, never an IP. This module resolves the machine's Tailscale IPv4
 * address through an ordered probe that works on every platform, then falls
 * back to the LocalAPI socket. It NEVER calls a bare `spawn('tailscale')`:
 * the binary is not on PATH on macOS (it lives inside the app bundle), and a
 * GUI-launched VS Code inherits no login-shell PATH on any platform — so a
 * bare spawn fails invisibly on the exact host that needs it most.
 *
 * Order:
 *   1. `tailscale ip -4` via an ordered absolute-path probe (Linux, both macOS
 *      bundle forms, Windows). Returns a single IPv4 string identically on all
 *      three platforms.
 *   2. The Tailscale LocalAPI socket (`GET /localapi/v0/status`), address at
 *      `Self.TailscaleIPs[0]`. Internal and explicitly unstable per
 *      `tailscale.com/client/local` — the fallback, not the primary.
 *
 * A failure at both steps must produce the decision-3 exit (the caller exits
 * non-zero naming Tailscale), never a silent fall back to loopback and never a
 * guess.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as http from 'http';
import * as net from 'net';

const execFileAsync = promisify(execFile);

/** Ordered absolute-path probe for the `tailscale` CLI binary, per platform. */
function candidateCliPaths(): string[] {
    switch (process.platform) {
        case 'linux':
            return ['/usr/bin/tailscale', '/usr/sbin/tailscale'];
        case 'darwin':
            // Not on PATH on macOS — the binary lives inside the app bundle.
            // Both the standalone (CLI) and App Store installs ship the same
            // bundle path; the App Store one is sandboxed but the CLI binary is
            // still callable at this path.
            return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
        case 'win32':
            // The installer adds to PATH, but a GUI-launched editor may not see
            // it, so probe the absolute install path first.
            return ['C:\\Program Files\\Tailscale\\tailscale.exe'];
        default:
            return [];
    }
}

/** LocalAPI socket path per platform. */
function candidateLocalApiSockets(): string[] {
    if (__testSocketPathsOverride !== null) { return __testSocketPathsOverride; }
    switch (process.platform) {
        case 'linux':
            return ['/var/run/tailscale/tailscaled.sock'];
        case 'darwin':
            return [
                // Standalone install.
                '/var/run/tailscaled.socket',
                // App Store install (sandbox container).
                `${process.env.HOME || ''}/Library/Group Containers/63T6S2R9A9.com.tailscale.ipn.macos/tailscaled.sock`,
            ];
        case 'win32':
            // Named pipe — handled separately (not a unix socket).
            return [];
        default:
            return [];
    }
}

/**
 * Test-only override for the LocalAPI socket candidate list. The behavioural
 * contract test stands up a mock unix-socket server and must point the probe
 * at it; `candidateLocalApiSockets()` is platform-keyed and otherwise not
 * injectable. Pass `null` to restore real platform behaviour. Mirrors the
 * `_resetWslCacheForTests` seam in `wslDetect.ts`.
 */
let __testSocketPathsOverride: string[] | null = null;
export function _setLocalApiSocketPathsForTest(paths: string[] | null): void {
    __testSocketPathsOverride = paths;
}

async function probeCli(path: string): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync(path, ['ip', '-4'], { timeout: 4000 });
        const addr = stdout.trim().split('\n')[0].trim();
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(addr)) { return addr; }
        return null;
    } catch {
        return null;
    }
}

/**
 * The `Host` header Tailscale's LocalAPI requires on every request.
 *
 * The LocalAPI socket is world-readable (`srw-rw-rw- root root`), so the
 * daemon enforces this header as its cross-origin defence: a request that
 * omits it (or sends an unexpected value) is refused with
 * `403 invalid localapi request` — a status that looks like a transport
 * answer but is a policy refusal. Omitting the header yields that 403
 * rather than a connection error, so the failure is swallowed by a
 * `catch { return null }` and reads identically to "no MagicDNS name".
 * `local-tailscaled.sock` is the documented value and what the official
 * client sends; it is the single constant both probes share so they
 * cannot drift on this value (the bug reached only one of them).
 */
export const LOCALAPI_HOST_HEADER = 'local-tailscaled.sock';

async function probeLocalApiSocket(socketPath: string): Promise<string | null> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (v: string | null) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            resolve(v);
        };
        const timer = setTimeout(() => finish(null), 4000);
        try {
            const req = http.get(
                { socketPath, path: '/localapi/v0/status', timeout: 4000, headers: { Host: LOCALAPI_HOST_HEADER } },
                (res) => {
                    let body = '';
                    res.on('data', (c: Buffer) => body += c.toString());
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(body);
                            const ips: string[] | undefined = json?.Self?.TailscaleIPs;
                            const v4 = (ips || []).find((ip: string) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip));
                            finish(v4 || null);
                        } catch { finish(null); }
                    });
                }
            );
            req.on('error', () => finish(null));
            req.setTimeout(4000, () => { try { req.destroy(); } catch { /* */ } finish(null); });
        } catch {
            finish(null);
        }
    });
}

/**
 * Resolve the machine's Tailscale IPv4 address, or null when Tailscale is
 * absent or down. Never throws — the caller decides the exit posture.
 */
export async function detectTailnetAddress(): Promise<string | null> {
    for (const p of candidateCliPaths()) {
        const addr = await probeCli(p);
        if (addr) { return addr; }
    }
    for (const sock of candidateLocalApiSockets()) {
        const addr = await probeLocalApiSocket(sock);
        if (addr) { return addr; }
    }
    return null;
}

/**
 * Best-effort MagicDNS name resolution for the detected address.
 *
 * MagicDNS installs a DNS search domain on Linux/macOS/iOS, so a bare label
 * genuinely resolves and the browser may send `Host: <bare-label>`. We cannot
 * read the tailnet's FQDN from `tailscale ip` alone, so this returns an empty
 * name list when the LocalAPI socket is unreachable — the tailnet IP itself is
 * always accepted by `isAllowedHostFor` regardless, so a board reached by raw
 * IP still loads. The FQDN/bare-label acceptance is a quality-of-life widening
 * that depends on the LocalAPI status payload.
 *
 * Returns a tagged union, not a bare `string[]`, so an empty name list
 * (MagicDNS legitimately disabled, or the machine has no FQDN) is
 * distinguishable from a refused probe (the socket missing, the daemon
 * returning 403, a parse failure, or the 4s timeout). The two cases read
 * identically under `string[]` — both `[]` — and that is precisely the
 * fallback-as-real-value failure mode this project names: a loud refusal
 * became a quiet "this machine has no name", the bind policy was built
 * with an empty allowlist, and the Host guard then 403'd the only name a
 * human types. The `unavailable` variant carries an actionable `reason`
 * (the socket path that refused, the HTTP status, the parse error) so the
 * caller can surface it instead of printing a success banner.
 */
export type MagicDnsResult =
    | { names: string[]; source: 'localapi' }        // probe answered; names may legitimately be empty
    | { names: []; source: 'unavailable'; reason: string };  // socket missing, refused, or unparseable

export async function resolveMagicDnsNames(): Promise<MagicDnsResult> {
    const socketPaths = candidateLocalApiSockets();
    if (socketPaths.length === 0) {
        return { names: [], source: 'unavailable', reason: 'no candidate LocalAPI socket on this platform' };
    }
    const reasons: string[] = [];
    for (const sock of socketPaths) {
        const outcome = await new Promise<{ kind: 'ok'; names: string[] } | { kind: 'fail'; reason: string }>((resolve) => {
            let settled = false;
            const finish = (v: { kind: 'ok'; names: string[] } | { kind: 'fail'; reason: string }) => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                resolve(v);
            };
            const timer = setTimeout(() => finish({ kind: 'fail', reason: `timeout after 4s on ${sock}` }), 4000);
            try {
                const req = http.get(
                    { socketPath: sock, path: '/localapi/v0/status', timeout: 4000, headers: { Host: LOCALAPI_HOST_HEADER } },
                    (res) => {
                        let body = '';
                        res.on('data', (c: Buffer) => body += c.toString());
                        res.on('end', () => {
                            if (res.statusCode !== 200) {
                                const firstLine = body.split('\n', 1)[0].trim().slice(0, 120);
                                finish({ kind: 'fail', reason: `HTTP ${res.statusCode}${firstLine ? `: ${firstLine}` : ''} on ${sock}` });
                                return;
                            }
                            try {
                                const json = JSON.parse(body);
                                const dnsName: string | undefined = json?.Self?.DNSName;
                                // Tailscale reports the FQDN with a trailing dot,
                                // e.g. "patrickremotedev.taile9aab9.ts.net."
                                const fqdn = (dnsName || '').replace(/\.$/, '').toLowerCase();
                                // The node's IPv6 tailnet address lives in the same
                                // status payload (`Self.TailscaleIPs`), so reading it
                                // here costs no second probe. Tailscale allocates a
                                // `fd7a:115c:a1e0::/48` address to every node, and a
                                // v6-preferring client (Happy Eyeballs / RFC 8305)
                                // attempts it first — without a v6 listener it gets
                                // ECONNREFUSED. Carried bracketed so `isAllowedHostFor`
                                // bracket-matches it and the caller can strip the
                                // brackets to bind the v6 listener.
                                const ips: string[] = Array.isArray(json?.Self?.TailscaleIPs)
                                    ? json.Self.TailscaleIPs as string[]
                                    : [];
                                const v6 = ips.find((ip: string) =>
                                    typeof ip === 'string' && ip.includes(':'));
                                // `finish`, not a bare `resolve`: `resolve` leaves
                                // `settled` false and the 4s timer armed, so the
                                // probe keeps the event loop alive for four seconds
                                // after it has already answered.
                                const names: string[] = [];
                                if (fqdn && fqdn.includes('.')) { names.push(fqdn); }
                                if (v6) { names.push(`[${v6.toLowerCase()}]`); }
                                if (names.length > 0) {
                                    finish({ kind: 'ok', names });
                                } else {
                                    // 200 with no FQDN and no v6: MagicDNS is disabled
                                    // or the node has no name. This is a real answer,
                                    // not a refusal — distinguish it from the
                                    // unavailable case so the caller does not print a
                                    // warning.
                                    finish({ kind: 'ok', names: [] });
                                }
                            } catch (e) {
                                finish({ kind: 'fail', reason: `JSON parse failed on ${sock}: ${e instanceof Error ? e.message : String(e)}` });
                            }
                        });
                    }
                );
                req.on('error', (e) => finish({ kind: 'fail', reason: `socket error on ${sock}: ${e.message}` }));
                req.setTimeout(4000, () => { try { req.destroy(); } catch { /**/ } finish({ kind: 'fail', reason: `request timeout on ${sock}` }); });
            } catch (e) {
                finish({ kind: 'fail', reason: `request threw on ${sock}: ${e instanceof Error ? e.message : String(e)}` });
            }
        });
        if (outcome.kind === 'ok') {
            return { names: outcome.names, source: 'localapi' };
        }
        reasons.push(outcome.reason);
    }
    return { names: [], source: 'unavailable', reason: reasons.join('; ') };
}

// Keep `net` referenced for the named-pipe Windows path — a unix-domain-socket
// helper is not used there, but the import documents the platform surface and
// keeps a future Windows LocalAPI probe from re-deriving the transport.
void net;

// ── Serve-config + cert-domains detection ─────────────────────────
//
// Two read-only Tailscale surfaces that `switchboard tailnet` consults to emit
// the best available origin rather than merely a reachable one. Both reuse the
// same transport stack as `detectTailnetAddress` / `resolveMagicDnsNames`
// (LocalAPI socket first, absolute-path CLI fallback — never a bare
// `spawn('tailscale')`, see the file header for why). The `ipn.ServeConfig`
// schema is Tailscale-internal and explicitly unstable, so every parser here
// degrades to `null` ("no serve config detected") on any shape mismatch —
// never throws, never substitutes a plausible value.

/**
 * A serve-config mapping that fronts the board's listening port.
 *
 * `fqdn` is the host portion of the `Web` key whose handler proxies to the
 * board port — the origin to emit as `https://<fqdn>[:port]/`. `port` is the
 * public-facing port from the same key (typically 443). `isFunnel` is true when
 * `AllowFunnel[<key>] === true`, meaning the endpoint is internet-public
 * (Tailscale Funnel) rather than tailnet-only (Tailscale Serve).
 */
export interface ServeConfigMapping {
    fqdn: string;
    port: number;
    isFunnel: boolean;
}

/**
 * Read `Self.CertDomains` from `/localapi/v0/status`.
 *
 * Empty or null means HTTPS certificate generation is disabled in the tailnet
 * admin console — TLS termination will fail even if a serve config requests
 * `HTTPS: true`. This is the pre-flight check that short-circuits the TLS probe
 * before it can hang on a cert that will never issue. Returns `null` when the
 * probe is refused (socket missing, 403, parse failure, timeout) —
 * distinguishable from a real "cert generation disabled" answer, which returns
 * `[]`.
 */
export async function readCertDomains(): Promise<string[] | null> {
    const socketPaths = candidateLocalApiSockets();
    if (socketPaths.length === 0) { return null; }
    for (const sock of socketPaths) {
        const outcome = await new Promise<string[] | null>((resolve) => {
            let settled = false;
            const finish = (v: string[] | null) => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                resolve(v);
            };
            const timer = setTimeout(() => finish(null), 4000);
            try {
                const req = http.get(
                    { socketPath: sock, path: '/localapi/v0/status', timeout: 4000, headers: { Host: LOCALAPI_HOST_HEADER } },
                    (res) => {
                        let body = '';
                        res.on('data', (c: Buffer) => body += c.toString());
                        res.on('end', () => {
                            if (res.statusCode !== 200) { finish(null); return; }
                            try {
                                const json = JSON.parse(body);
                                const domains: unknown = json?.Self?.CertDomains;
                                if (Array.isArray(domains)) {
                                    finish(domains.filter((d): d is string => typeof d === 'string'));
                                } else {
                                    // 200 with no CertDomains: cert generation is
                                    // disabled. A real answer, not a refusal.
                                    finish([]);
                                }
                            } catch { finish(null); }
                        });
                    }
                );
                req.on('error', () => finish(null));
                req.setTimeout(4000, () => { try { req.destroy(); } catch { /**/ } finish(null); });
            } catch {
                finish(null);
            }
        });
        if (outcome !== null) { return outcome; }
    }
    return null;
}

/** Read the raw serve-config JSON via the LocalAPI socket (primary transport). */
async function readServeConfigViaSocket(): Promise<unknown | null> {
    const socketPaths = candidateLocalApiSockets();
    for (const sock of socketPaths) {
        const outcome = await new Promise<unknown | null>((resolve) => {
            let settled = false;
            const finish = (v: unknown | null) => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                resolve(v);
            };
            const timer = setTimeout(() => finish(null), 4000);
            try {
                const req = http.get(
                    { socketPath: sock, path: '/localapi/v0/serve-config', timeout: 4000, headers: { Host: LOCALAPI_HOST_HEADER } },
                    (res) => {
                        let body = '';
                        res.on('data', (c: Buffer) => body += c.toString());
                        res.on('end', () => {
                            if (res.statusCode !== 200) { finish(null); return; }
                            try { finish(JSON.parse(body)); } catch { finish(null); }
                        });
                    }
                );
                req.on('error', () => finish(null));
                req.setTimeout(4000, () => { try { req.destroy(); } catch { /**/ } finish(null); });
            } catch {
                finish(null);
            }
        });
        if (outcome !== null) { return outcome; }
    }
    return null;
}

/** Read the raw serve-config JSON via `tailscale serve status --json` (CLI fallback). */
async function readServeConfigViaCli(): Promise<unknown | null> {
    for (const p of candidateCliPaths()) {
        try {
            const { stdout } = await execFileAsync(p, ['serve', 'status', '--json'], { timeout: 4000 });
            return JSON.parse(stdout);
        } catch { /* try next path */ }
    }
    return null;
}

/**
 * Parse a `Web` key of the form `host:port` (or `https://host:port`) into its
 * host and port. Returns null on any shape mismatch — the key format is
 * Tailscale-internal and the parser must never throw.
 */
function parseWebKey(key: string): { host: string; port: number } | null {
    let s = key.trim();
    // Some builds prefix the scheme; strip it so the host:port split is uniform.
    const schemeMatch = s.match(/^[a-z]+:\/\//i);
    if (schemeMatch) { s = s.slice(schemeMatch[0].length); }
    // An IPv6 literal in a Web key would be bracketed; serve config host-port
    // keys use hostnames (SNI), so a bare colon-split is safe for the expected
    // input. Guard against an unbracketed v6 (multiple colons) by rejecting it.
    const lastColon = s.lastIndexOf(':');
    if (lastColon <= 0) { return null; }
    const host = s.slice(0, lastColon);
    const portStr = s.slice(lastColon + 1);
    if (!/^\d+$/.test(portStr)) { return null; }
    if (!host || host.includes(':')) { return null; }
    return { host: host.toLowerCase(), port: parseInt(portStr, 10) };
}

/**
 * True when a `Proxy` URL targets `127.0.0.1`/`localhost`/`[::1]` at the board's
 * listening port. A serve config fronting a *different* port must not be emitted
 * (Edge Case 3) — match on the destination port, not merely on the presence of
 * any serve config.
 */
function proxyMatchesBoardPort(proxy: unknown, boardPort: number): boolean {
    if (typeof proxy !== 'string') { return false; }
    try {
        const u = new URL(proxy);
        if (u.protocol !== 'http:') { return false; }
        const host = u.hostname.toLowerCase();
        if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') { return false; }
        return u.port === String(boardPort);
    } catch {
        return false;
    }
}

/**
 * Walk a serve-config `Web` block (a `HostPort → { Handlers: { path → { Proxy } } }`
 * map) for any handler proxying to `boardPort`. Returns the first match's
 * host/port and the funnel flag from `allowFunnel`. The `Web` block may live at
 * the top level or nested under `Services.*` — both are traversed.
 */
function findWebMappingForPort(
    web: unknown,
    allowFunnel: Record<string, unknown>,
    boardPort: number
): ServeConfigMapping | null {
    if (!web || typeof web !== 'object') { return null; }
    for (const [key, val] of Object.entries(web as Record<string, unknown>)) {
        if (!val || typeof val !== 'object') { continue; }
        const handlers = (val as Record<string, unknown>).Handlers;
        if (!handlers || typeof handlers !== 'object') { continue; }
        let matched = false;
        for (const handler of Object.values(handlers as Record<string, unknown>)) {
            if (!handler || typeof handler !== 'object') { continue; }
            const proxy = (handler as Record<string, unknown>).Proxy;
            if (proxyMatchesBoardPort(proxy, boardPort)) { matched = true; break; }
        }
        if (!matched) { continue; }
        const parsed = parseWebKey(key);
        if (!parsed) { continue; }
        return {
            fqdn: parsed.host,
            port: parsed.port,
            isFunnel: allowFunnel[key] === true,
        };
    }
    return null;
}

/**
 * Detect whether a `tailscale serve` config maps a MagicDNS FQDN to the board's
 * listening port. Primary transport: `GET /localapi/v0/serve-config` via the
 * LocalAPI socket. Fallback: `tailscale serve status --json` via the
 * absolute-path CLI probe. Both return the same `ipn.ServeConfig` JSON. Returns
 * `null` when no serve config exists, when none maps this port, or on any parse
 * failure — the schema is explicitly unstable and the parser degrades silently.
 */
export async function detectServeConfigMapping(boardPort: number): Promise<ServeConfigMapping | null> {
    const cfg = (await readServeConfigViaSocket()) ?? (await readServeConfigViaCli());
    if (!cfg || typeof cfg !== 'object') { return null; }
    try {
        const root = cfg as Record<string, unknown>;
        const allowFunnel: Record<string, unknown> =
            (root.AllowFunnel && typeof root.AllowFunnel === 'object')
                ? root.AllowFunnel as Record<string, unknown>
                : {};
        // Top-level Web.
        let mapping = findWebMappingForPort(root.Web, allowFunnel, boardPort);
        if (mapping) { return mapping; }
        // Services.*.Web — named service blocks with nested Web/TCP. Unknown
        // keys within are silently skipped.
        const services = root.Services;
        if (services && typeof services === 'object') {
            for (const svc of Object.values(services as Record<string, unknown>)) {
                if (!svc || typeof svc !== 'object') { continue; }
                const svcWeb = (svc as Record<string, unknown>).Web;
                mapping = findWebMappingForPort(svcWeb, allowFunnel, boardPort);
                if (mapping) { return mapping; }
            }
        }
        return null;
    } catch {
        return null;
    }
}
