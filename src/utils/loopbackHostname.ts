/**
 * Loopback hostname policy — the single source of truth for "does this name
 * always resolve to this machine?".
 *
 * Two callers share it, and they must not drift:
 *  - `LocalApiServer` uses it as the DNS-rebinding guard on the `Host` header
 *    (and on `Origin` for CORS mirroring) whenever it serves the browser board.
 *  - The standalone CLI uses it to validate `--hostname`, so the URL it prints
 *    and opens can never be one the server would then 403.
 *
 * Why `*.localhost` is safe to accept alongside `localhost` / `127.0.0.1`:
 * RFC 6761 §6.3 reserves the `.localhost` TLD and requires resolvers to map it —
 * and every name beneath it — to loopback. An attacker cannot point
 * `anything.localhost` at their own IP, which is exactly the manoeuvre the
 * rebinding guard exists to stop. A hostile page at `https://evil.example` that
 * fetches `http://switchboard.localhost:<port>/` still sends
 * `Origin: https://evil.example`, so it gets no CORS mirror and — because the
 * session cookie is `SameSite=Strict` — no credentials either. Accepting the
 * subdomain widens the *name* space, not the *network* space: the socket-level
 * check in `_handleRequest` still rejects every non-loopback peer.
 *
 * What is deliberately NOT accepted: the wider `127.0.0.0/8` range, bare IPv6
 * forms other than `::1`, and any name that merely contains "localhost"
 * (`localhost.evil.example` is an attacker-controlled name and must 403).
 */

import * as http from 'http';

/** `*.localhost`: one or more LDH labels, then the reserved `.localhost` TLD. */
const DOT_LOCALHOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+localhost$/;

/**
 * Split a `Host` header into its hostname, dropping the port.
 *
 * Returns null for anything malformed rather than guessing — a caller that
 * cannot parse the header must reject the request, not fall back to a looser
 * comparison. Handles the bracketed IPv6 literal form (`[::1]`, `[::1]:8080`),
 * which the previous `startsWith('127.0.0.1:')` prefix test did not.
 */
export function hostnameFromHostHeader(host: string | undefined): string | null {
    if (!host) { return null; }
    const lower = host.trim().toLowerCase();
    if (!lower) { return null; }

    if (lower.startsWith('[')) {
        const close = lower.indexOf(']');
        if (close === -1) { return null; }
        const rest = lower.slice(close + 1);
        if (rest !== '' && !/^:\d+$/.test(rest)) { return null; }
        return lower.slice(0, close + 1);
    }

    const colon = lower.indexOf(':');
    if (colon === -1) { return lower; }
    // A second colon means an unbracketed IPv6 literal — not a valid Host header.
    if (lower.indexOf(':', colon + 1) !== -1) { return null; }
    if (!/^\d+$/.test(lower.slice(colon + 1))) { return null; }
    return lower.slice(0, colon);
}

/** True when `hostname` (no port) is guaranteed to resolve to this machine. */
export function isLoopbackHostname(hostname: string | undefined): boolean {
    if (!hostname) { return false; }
    const h = hostname.trim().toLowerCase();
    if (h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]') { return true; }
    return DOT_LOCALHOST_RE.test(h);
}

/** True when a `Host` header names a loopback host (with or without a port). */
export function isLoopbackHostHeader(host: string | undefined): boolean {
    return isLoopbackHostname(hostnameFromHostHeader(host) ?? undefined);
}

/** True when an `Origin` header's hostname is a loopback host. */
export function isLoopbackOrigin(origin: string): boolean {
    try {
        return isLoopbackHostname(new URL(origin).hostname);
    } catch {
        return false;
    }
}

/**
 * The hostname Switchboard hands the user when nothing else is specified.
 *
 * Not a bind address — the server binds 127.0.0.1 unconditionally. This is the
 * NAME in the printed/opened URL. `.localhost` is reserved by RFC 6761 §6.3 and
 * is unspoofable, which is why the Host guard accepts it.
 */
export const DEFAULT_DISPLAY_HOSTNAME = 'switchboard.localhost';

/**
 * Can a client actually reach the server under `hostname`?
 *
 * A DNS lookup is not enough: the Windows resolver does not implement the
 * `.localhost` TLD (browsers do it internally, the OS does not), and a resolver
 * that answers `::1` first would hand back an address an IPv4-only listener
 * refuses. So probe the real thing — GET /health over that name.
 *
 * /health is unauthenticated and idempotent; the one-time launch token must NOT
 * be used here (consumeOneTimeToken succeeds exactly once).
 */
export async function isHostnameReachable(
    hostname: string,
    port: number,
    timeoutMs = 500
): Promise<boolean> {
    return new Promise(resolve => {
        let settled = false;
        let req: http.ClientRequest | undefined;
        const finish = (result: boolean) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            try { req?.destroy(); } catch { /* already gone */ }
            resolve(result);
        };
        // A wall-clock guard, not only `req.setTimeout`. That one arms on socket
        // INACTIVITY once a socket exists, so a name lookup that neither resolves
        // nor NXDOMAINs (a captive resolver, a proxy swallowing the query) leaves
        // this promise pending forever — and both openInBrowser and the standalone
        // launch await it, so a hang there means no URL and no error at all.
        const timer = setTimeout(() => finish(false), timeoutMs);
        try {
            req = http.get(`http://${hostname}:${port}/health`, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(body);
                        finish(json.status === 'ok' && json.port === port);
                    } catch { finish(false); }
                });
            });
            req.on('error', () => finish(false));
            req.setTimeout(timeoutMs, () => finish(false));
        } catch {
            // http.get throws SYNCHRONOUSLY on a malformed hostname (an explicit
            // --hostname the caller validated as loopback can still be a shape the
            // URL parser rejects). Unreachable, not fatal.
            finish(false);
        }
    });
}

/**
 * Resolve the display hostname for a launch.
 *
 * - explicit input: honoured verbatim (already validated by the caller); probe
 *   only to warn, never to override — the user may manage a hosts entry.
 * - no input: prefer DEFAULT_DISPLAY_HOSTNAME, but fall back to 127.0.0.1 when
 *   the probe fails. A default that hands out an unreachable URL is worse than a
 *   plain one.
 */
export async function resolveDisplayHostname(
    explicit: string | undefined,
    port: number,
    warn: (msg: string) => void
): Promise<string> {
    if (explicit) {
        const reachable = await isHostnameReachable(explicit, port);
        if (!reachable) {
            warn(`hostname '${explicit}' did not respond to /health; browser may not be able to reach it`);
        }
        return explicit;
    }
    const reachable = await isHostnameReachable(DEFAULT_DISPLAY_HOSTNAME, port);
    if (reachable) {
        return DEFAULT_DISPLAY_HOSTNAME;
    }
    warn(`${DEFAULT_DISPLAY_HOSTNAME} is not reachable; falling back to 127.0.0.1`);
    return '127.0.0.1';
}
