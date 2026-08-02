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
