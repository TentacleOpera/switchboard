import { URL } from 'url';
import {
    isAllowedHostFor,
    isAllowedOriginFor,
    LOOPBACK_ONLY_POLICY,
    type BindPolicy,
} from '../utils/loopbackHostname';

export function parseCookies(req: any): Record<string, string> {
    const raw = req.headers?.cookie || '';
    const result: Record<string, string> = {};
    for (const part of raw.split(';')) {
        const [k, ...rest] = part.trim().split('=');
        if (k && rest.length > 0) {
            result[k] = decodeURIComponent(rest.join('='));
        }
    }
    return result;
}

/**
 * Both guards below delegate to `utils/loopbackHostname` — the SAME predicate
 * `LocalApiServer._isAllowedHost` / `_isLocalhostOrigin` and the standalone CLI's
 * `--hostname` validation use. They used to carry their own copies, and the copies
 * did not learn about the reserved `.localhost` TLD when `--hostname
 * switchboard.localhost` shipped. The result: a board served at
 * `switchboard.localhost` passed the HTTP guard and then had every WebSocket
 * upgrade 403'd here — `Forbidden Host` in standalone (the socket is on
 * `location.host`) and `Forbidden Origin` under the extension host (the socket is
 * on the pty host's 127.0.0.1 port but the page's Origin is the `.localhost` name).
 * Terminals rendered and never streamed; the board rendered and never took a push.
 *
 * The `loopback-hostname-contract` test asserts "no second predicate", but only
 * over LocalApiServer.ts — this file was the second predicate it did not look at.
 * It now covers both. Do not re-inline either check.
 */
/**
 * Origin allowlist under a bind policy. Delegates the hostname decision to the
 * shared `isAllowedOriginFor` (which itself delegates to `isAllowedHostFor`),
 * so the WebSocket upgrade Host/Origin set can never drift from the HTTP guard
 * set — and so tailnet mode widens both in step. The `vscode-webview:` origin
 * allowance lives in the shared module now (it is a non-network name the
 * loopback predicate cannot speak to, and the editor webview is never served
 * over a tailnet listener).
 */
export function isLocalhostOrigin(origin: string, policy: BindPolicy = LOOPBACK_ONLY_POLICY): boolean {
    return isAllowedOriginFor(policy, origin);
}

export function isAllowedHost(host: string, policy: BindPolicy = LOOPBACK_ONLY_POLICY): boolean {
    return isAllowedHostFor(policy, host);
}

export function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < b.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

export interface WsUpgradeAuthOptions {
    rejectWhenTokenEmpty?: boolean;
    /**
     * Bind policy for the Host/Origin allowlist. Defaults to loopback-only —
     * the historical posture every caller had before tailnet mode. A tailnet
     * policy widens the accepted Host/Origin set in step with the HTTP guard.
     */
    bindPolicy?: BindPolicy;
    /**
     * True when this upgrade arrived on the tailnet listener. When true the
     * token check is skipped (decision 4: tailnet membership is the control),
     * scoped to that listener and that peer set — a global skip would also
     * disable the token for the loopback listener and for `Authorization:
     * Bearer` machine callers. Identified by the socket's `localAddress`
     * matching the bound tailnet address, the same identification the HTTP
     * peer check uses.
     */
    isTailnetUpgrade?: (req: any) => boolean;
}

export async function authorizeWsUpgrade(
    req: any,
    getAuthToken: () => Promise<string | undefined>,
    opts?: WsUpgradeAuthOptions
): Promise<{ authorized: boolean; statusCode?: number; reason?: string }> {
    const policy = opts?.bindPolicy ?? LOOPBACK_ONLY_POLICY;
    const host = req.headers['host'];
    if (host && !isAllowedHost(host, policy)) {
        return { authorized: false, statusCode: 403, reason: 'Forbidden Host' };
    }

    const origin = req.headers['origin'];
    if (origin && !isLocalhostOrigin(origin, policy)) {
        return { authorized: false, statusCode: 403, reason: 'Forbidden Origin' };
    }

    // Decision 4: a request that arrived on the tailnet listener is trusted
    // exactly as loopback is trusted — no credential, no enrolment. Scoped to
    // that listener; the loopback listener still enforces the token.
    if (opts?.isTailnetUpgrade && opts.isTailnetUpgrade(req)) {
        return { authorized: true };
    }

    const reqUrl = new URL(req.url || '', `http://${req.headers['host'] || '127.0.0.1'}`);
    const cookies = parseCookies(req);
    const presented = reqUrl.searchParams.get('token') || cookies['sb_session'] || '';
    const expected = await getAuthToken();

    if (!expected) {
        if (opts?.rejectWhenTokenEmpty) {
            return { authorized: false, statusCode: 401, reason: 'Unauthorized - empty token' };
        }
        // Hub fallback: no expected token => accept loopback connection
        return { authorized: true };
    }

    if (!presented || !constantTimeEqual(presented, expected)) {
        return { authorized: false, statusCode: 401, reason: 'Unauthorized' };
    }

    return { authorized: true };
}
