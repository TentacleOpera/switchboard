import { URL } from 'url';

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

export function isLocalhostOrigin(origin: string): boolean {
    try {
        const u = new URL(origin);
        if (u.protocol === 'vscode-webview:') { return true; }
        const h = u.hostname;
        return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
    } catch {
        return false;
    }
}

export function isAllowedHost(host: string): boolean {
    const lower = host.toLowerCase();
    if (lower.startsWith('127.0.0.1:') || lower.startsWith('localhost:')) { return true; }
    if (lower === '127.0.0.1' || lower === 'localhost' || lower === '[::1]') { return true; }
    if (lower.startsWith('[::1]:')) { return true; }
    return false;
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
