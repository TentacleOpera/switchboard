import { URL } from 'url';
import { isLoopbackHostHeader, isLoopbackHostname } from '../utils/loopbackHostname';

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
export function isLocalhostOrigin(origin: string): boolean {
    try {
        const u = new URL(origin);
        // The editor webview's origin is `vscode-webview://<uuid>`: not a network
        // name at all, so the loopback predicate cannot speak to it. Kept here
        // rather than pushed into the shared module, which guards HTTP hosts.
        if (u.protocol === 'vscode-webview:') { return true; }
        return isLoopbackHostname(u.hostname);
    } catch {
        return false;
    }
}

export function isAllowedHost(host: string): boolean {
    return isLoopbackHostHeader(host);
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
}

export async function authorizeWsUpgrade(
    req: any,
    getAuthToken: () => Promise<string | undefined>,
    opts?: WsUpgradeAuthOptions
): Promise<{ authorized: boolean; statusCode?: number; reason?: string }> {
    const host = req.headers['host'];
    if (host && !isAllowedHost(host)) {
        return { authorized: false, statusCode: 403, reason: 'Forbidden Host' };
    }

    const origin = req.headers['origin'];
    if (origin && !isLocalhostOrigin(origin)) {
        return { authorized: false, statusCode: 403, reason: 'Forbidden Origin' };
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
