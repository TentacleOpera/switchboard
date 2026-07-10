// Bootstrap helpers for the Switchboard MCP stdio bridge.
// Pure, side-effect-free units: workspace resolution, per-call port read,
// health check, and the HTTP call() that maps LocalApiServer responses to
// MCP tool results. No state is cached for the process lifetime — the port
// is chosen by listen(0) and changes on every VS Code restart.

import * as fs from 'fs';
import * as path from 'path';

/** Structured error returned as an MCP tool error result (process stays alive). */
export interface SwitchboardError {
    error: string;
    code: string;
    detail?: string;
}

export const NOT_RUNNING_ERROR: SwitchboardError = {
    error: 'Switchboard is not running. Open this workspace in VS Code with the Switchboard extension active, then retry.',
    code: 'SWITCHBOARD_NOT_RUNNING'
};

/**
 * Resolve the workspace root from (1) an explicit arg, (2) the
 * SWITCHBOARD_WORKSPACE_ROOT env var, or (3) a config value. Desktop has no
 * cwd/repo, so this is the only way the MCP knows which workspace to drive.
 */
export function resolveWorkspaceRoot(argRoot?: string, env = process.env): string | null {
    const fromArg = typeof argRoot === 'string' ? argRoot.trim() : '';
    if (fromArg) return path.resolve(fromArg);
    const fromEnv = typeof env.SWITCHBOARD_WORKSPACE_ROOT === 'string' ? env.SWITCHBOARD_WORKSPACE_ROOT.trim() : '';
    if (fromEnv) return path.resolve(fromEnv);
    return null;
}

/**
 * Read the LocalApiServer port file UNDER the workspace root. Re-read on every
 * call — never cache — because the port is OS-assigned (listen(0)) and changes
 * on each VS Code restart. Missing/unreadable file → structured not-running error.
 */
export function readPort(workspaceRoot: string): { port: number } | SwitchboardError {
    const portFile = path.join(workspaceRoot, '.switchboard', 'api-server-port.txt');
    let raw: string;
    try {
        raw = fs.readFileSync(portFile, 'utf8').trim();
    } catch {
        return NOT_RUNNING_ERROR;
    }
    const port = parseInt(raw, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        return { error: `Port file present but unparseable: "${raw}".`, code: 'SWITCHBOARD_NOT_RUNNING' };
    }
    return { port };
}

/** Resolve an optional bearer token from env/config. Token-less is the working default. */
export function resolveToken(env = process.env): string | null {
    const t = typeof env.SWITCHBOARD_API_TOKEN === 'string' ? env.SWITCHBOARD_API_TOKEN.trim() : '';
    // An unsubstituted template (e.g. ".mcpb" left the optional api_token blank
    // and injected the literal "${user_config.api_token}") means token-less.
    // Forwarding it as a bearer value would 401 every call against a token-less
    // server — the exact trap the plan flags. Treat any "${…}" value as no token.
    if (!t || t.startsWith('${')) return null;
    return t;
}

function baseUrl(port: number): string {
    return `http://127.0.0.1:${port}`;
}

/**
 * GET /health — no auth. Returns {status, port, roots} on success.
 * Used as a liveness probe; never throws — returns a SwitchboardError on failure.
 */
export async function healthCheck(workspaceRoot: string, token: string | null): Promise<{ ok: true; data: any } | SwitchboardError> {
    const portRes = readPort(workspaceRoot);
    if ('error' in portRes) return portRes;
    try {
        const res = await fetch(`${baseUrl(portRes.port)}/health`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        if (!res.ok) {
            return { error: `Health check failed: HTTP ${res.status}`, code: 'SWITCHBOARD_NOT_RUNNING' };
        }
        const data = await res.json().catch(() => ({}));
        return { ok: true, data };
    } catch (e) {
        return { error: `Health check failed: ${(e as Error).message}`, code: 'SWITCHBOARD_NOT_RUNNING' };
    }
}

export interface CallOptions {
    method: string;
    path: string;
    body?: unknown;
    workspaceRoot?: string;
    token?: string | null;
}

export interface CallSuccess {
    ok: true;
    status: number;
    data: any;
}

/**
 * The core HTTP delegate. Every curated tool and the passthrough funnel through
 * here. Success = any 2xx (200/201/204). Errors map to a structured shape the
 * tool layer turns into an MCP error result. Never throws — never process.exit.
 *
 * Auth posture: forward a bearer header ONLY when a token is configured. The
 * default (token-less) path sends no Authorization header, which LocalApiServer
 * accepts for localhost. Sending a bearer header against a token-less server
 * would 401, so the default must remain header-less.
 */
export async function call(opts: CallOptions, defaultRoot: string, defaultToken: string | null): Promise<CallSuccess | SwitchboardError> {
    const root = opts.workspaceRoot?.trim() ? path.resolve(opts.workspaceRoot) : defaultRoot;
    const portRes = readPort(root);
    if ('error' in portRes) return portRes;
    const token = opts.token !== undefined ? opts.token : defaultToken;
    const url = `${baseUrl(portRes.port)}${opts.path}`;
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let bodyInit: BodyInit | undefined;
    if (opts.body !== undefined && opts.body !== null && opts.method !== 'GET' && opts.method !== 'DELETE') {
        headers['Content-Type'] = 'application/json';
        bodyInit = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
        res = await fetch(url, { method: opts.method, headers, body: bodyInit });
    } catch (e) {
        return { error: `Request to LocalApiServer failed: ${(e as Error).message}`, code: 'SWITCHBOARD_NOT_RUNNING' };
    }
    const status = res.status;
    if (status >= 200 && status < 300) {
        if (status === 204) return { ok: true, status, data: null };
        const text = await res.text();
        let data: any = null;
        if (text) {
            try { data = JSON.parse(text); } catch { data = text; }
        }
        return { ok: true, status, data };
    }
    // Error mapping: 400/401/403/404/405/409/413/500/502/503 + generic.
    const text = await res.text().catch(() => '');
    let detail: any = text;
    if (text) {
        try { detail = JSON.parse(text); } catch { /* keep text */ }
    }
    const code = statusToCode(status);
    const message = statusToMessage(status, detail);
    return { error: message, code, detail };
}

function statusToCode(status: number): string {
    switch (status) {
        case 400: return 'BAD_REQUEST';
        case 401: return 'UNAUTHORIZED';
        case 403: return 'FORBIDDEN';
        case 404: return 'NOT_FOUND';
        case 405: return 'METHOD_NOT_ALLOWED';
        case 409: return 'CONFLICT';
        case 413: return 'PAYLOAD_TOO_LARGE';
        case 500: return 'INTERNAL_ERROR';
        case 502: return 'UPSTREAM_ERROR';
        case 503: return 'SERVICE_UNAVAILABLE';
        default: return `HTTP_${status}`;
    }
}

function statusToMessage(status: number, detail: any): string {
    const base = `LocalApiServer returned HTTP ${status}`;
    if (detail && typeof detail === 'object' && typeof detail.error === 'string') {
        return `${base}: ${detail.error}`;
    }
    if (typeof detail === 'string' && detail) {
        return `${base}: ${detail}`;
    }
    return base;
}

/** Log to stderr only — stdout is reserved for JSON-RPC. */
export function logErr(msg: string): void {
    process.stderr.write(`[switchboard-mcp] ${msg}\n`);
}
