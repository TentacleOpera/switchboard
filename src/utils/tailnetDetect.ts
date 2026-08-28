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
                { socketPath, path: '/localapi/v0/status', timeout: 4000 },
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
 * list when the LocalAPI socket is unreachable — the tailnet IP itself is
 * always accepted by `isAllowedHostFor` regardless, so a board reached by raw
 * IP still loads. The FQDN/bare-label acceptance is a quality-of-life widening
 * that depends on the LocalAPI status payload.
 */
export async function resolveMagicDnsNames(): Promise<string[]> {
    const socketPaths = candidateLocalApiSockets();
    for (const sock of socketPaths) {
        const names = await new Promise<string[] | null>((resolve) => {
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
                    { socketPath: sock, path: '/localapi/v0/status', timeout: 4000 },
                    (res) => {
                        let body = '';
                        res.on('data', (c: Buffer) => body += c.toString());
                        res.on('end', () => {
                            try {
                                const json = JSON.parse(body);
                                const dnsName: string | undefined = json?.Self?.DNSName;
                                // Tailscale reports the FQDN with a trailing dot,
                                // e.g. "patrickremotedev.taile9aab9.ts.net."
                                const fqdn = (dnsName || '').replace(/\.$/, '').toLowerCase();
                                // `finish`, not a bare `resolve`: `resolve` leaves
                                // `settled` false and the 4s timer armed, so the
                                // probe keeps the event loop alive for four seconds
                                // after it has already answered.
                                if (fqdn && fqdn.includes('.')) {
                                    finish([fqdn]);
                                } else {
                                    finish(null);
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
        if (names) { return names; }
    }
    return [];
}

// Keep `net` referenced for the named-pipe Windows path — a unix-domain-socket
// helper is not used there, but the import documents the platform surface and
// keeps a future Windows LocalAPI probe from re-deriving the transport.
void net;
