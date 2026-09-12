/**
 * Tailnet origin resolver — pick the best available origin, not merely a
 * reachable one.
 *
 * `switchboard tailnet` historically emitted `http://<tailnet-ip>:<port>/`
 * unconditionally. A plain-`http` remote origin cannot install to an iOS Home
 * Screen as a standalone app (Safari treats the manifest as a bookmark and does
 * not apply `display: standalone`), so the CLI was handing out a URL that
 * independently blocked shipped work. This resolver applies the same
 * probe-and-fall-back pattern the loopback path already uses
 * (`resolveDisplayHostname` in `loopbackHostname.ts`) to the tailnet path:
 * prefer a secure context when the tailnet offers one, and say in a single line
 * what that costs when it does not.
 *
 * Candidate list, highest trust first:
 *
 *   1. `https://<magicdns-fqdn>[:port]/` — only when a `tailscale serve` config
 *      maps the FQDN to THIS board port AND `Self.CertDomains` is non-empty (cert
 *      generation enabled). Probed with a TLS handshake against `/health`,
 *      which simultaneously verifies cert liveness and reachability — a
 *      not-yet-issued cert fails the handshake and the candidate is dropped
 *      without blocking startup (Edge Case 2).
 *   2. `http://<magicdns-fqdn>:<port>/` — already accepted by the Host guard;
 *      better to type than an IP. Probed with the existing HTTP probe.
 *   3. `http://<tailnet-ip>:<port>/` — today's behaviour; the terminal fallback.
 *      Needs no probe (it is the bound address — reachability is structural).
 *
 * First success wins. Exactly one URL is emitted (Edge Case 5: `sb_session` is
 * host-scoped, so a mid-session hostname switch reads as a random logout).
 *
 * Detection only. This resolver never configures `tailscale serve` (see the
 * plan's *Non-goals*): privileges, the half that is not automatable, and a
 * lifecycle Switchboard does not own.
 */
import * as http from 'http';
import * as https from 'https';

import { isHostnameReachable } from './loopbackHostname';
import type { ServeConfigMapping } from './tailnetDetect';

/** Result of `resolveTailnetOrigin`: the single URL to emit and its trust. */
export interface TailnetOriginResult {
    /** The chosen origin URL, with a trailing slash. */
    url: string;
    /** True when the scheme is `https://` (a secure context). */
    secure: boolean;
    /** True when the chosen origin is internet-public (Tailscale Funnel). */
    isFunnel: boolean;
}

/** Options for `resolveTailnetOrigin`. */
export interface TailnetOriginOptions {
    /** Per-probe wall-clock cap. Default 2000ms; a slow tailnet must not delay launch. */
    probeTimeoutMs?: number;
}

/**
 * Probe an HTTPS origin with a TLS handshake against `/health`.
 *
 * Doubles as the cert-liveness check (Edge Case 2): a cert that has not been
 * issued fails the TLS handshake and the candidate is dropped without blocking
 * startup. The probe connects to `connectPort` (the serve-config public port,
 * typically 443) but verifies the `/health` body reports `expectedPort` (the
 * board's listening port) — a serve config fronting a different backend would
 * answer with the wrong port and the candidate is rejected.
 *
 * `/health` is unauthenticated and idempotent; the one-time launch token must NOT
 * be used here (`consumeOneTimeToken` succeeds exactly once).
 */
export async function isHttpsOriginReachable(
    hostname: string,
    connectPort: number,
    expectedPort: number,
    timeoutMs = 2000
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
        // A wall-clock guard, not only `req.setTimeout` — the latter arms on
        // socket INACTIVITY once a socket exists, so a DNS lookup that neither
        // resolves nor NXDOMAINs leaves this promise pending forever. The
        // resolver awaits it, so a hang means no URL and no error at all.
        const timer = setTimeout(() => finish(false), timeoutMs);
        try {
            req = https.get(
                `https://${hostname}:${connectPort}/health`,
                { timeout: timeoutMs },
                (res) => {
                    let body = '';
                    res.on('data', c => body += c);
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(body);
                            finish(json.status === 'ok' && json.port === expectedPort);
                        } catch { finish(false); }
                    });
                }
            );
            req.on('error', () => finish(false));
            req.setTimeout(timeoutMs, () => finish(false));
        } catch {
            // https.get throws SYNCHRONOUSLY on a malformed hostname. The
            // serve-config FQDN is parser-extracted and could be a shape the
            // URL parser rejects. Unreachable, not fatal.
            finish(false);
        }
    });
}

/**
 * Resolve the single best tailnet origin URL.
 *
 * `tailnetAddress` is the bound Tailscale IPv4 (or bracketed IPv6) address —
 * the terminal fallback. `magicDnsNames` is the list from `resolveMagicDnsNames`
 * (FQDN first, bracketed v6 last). `serveConfig` is the result of
 * `detectServeConfigMapping(port)` — null when no serve config maps this port.
 * `certDomains` is the result of `readCertDomains()` — null when the probe was
 * refused, `[]` when cert generation is disabled (the HTTPS candidate is
 * skipped in both cases).
 *
 * Returns `{ url, secure, isFunnel }`. The IP fallback is always last and needs
 * no probe — it is today's exact behaviour, so the worst regression is a slow
 * startup if the higher candidates time out (capped at `probeTimeoutMs` each,
 * at most two probes).
 */
export async function resolveTailnetOrigin(
    tailnetAddress: string,
    magicDnsNames: string[],
    port: number,
    serveConfig: ServeConfigMapping | null,
    certDomains: string[] | null,
    opts: TailnetOriginOptions = {}
): Promise<TailnetOriginResult> {
    const probeTimeoutMs = opts.probeTimeoutMs ?? 2000;

    // Candidate 1: HTTPS FQDN. Requires a serve config mapping this port AND a
    // non-empty CertDomains (cert generation enabled — the pre-flight check
    // that prevents a TLS probe hang on a cert that will never issue).
    if (serveConfig && certDomains && certDomains.length > 0) {
        const fqdn = serveConfig.fqdn;
        const connectPort = serveConfig.port;
        const url = connectPort === 443
            ? `https://${fqdn}/`
            : `https://${fqdn}:${connectPort}/`;
        const reachable = await isHttpsOriginReachable(fqdn, connectPort, port, probeTimeoutMs);
        if (reachable) {
            return { url, secure: true, isFunnel: serveConfig.isFunnel };
        }
    }

    // Candidate 2: HTTP FQDN. The first non-bracketed MagicDNS name (the FQDN,
    // not the v6 address). Already accepted by the Host guard.
    const dnsNames = magicDnsNames.filter(n => !n.startsWith('['));
    if (dnsNames.length > 0) {
        const fqdn = dnsNames[0];
        const url = `http://${fqdn}:${port}/`;
        const reachable = await isHostnameReachable(fqdn, port, probeTimeoutMs);
        if (reachable) {
            return { url, secure: false, isFunnel: false };
        }
    }

    // Candidate 3: HTTP IP. Today's behaviour; the bound address, so
    // reachability is structural and no probe is needed.
    const ipUrl = `http://${tailnetAddress}:${port}/`;
    return { url: ipUrl, secure: false, isFunnel: false };
}
