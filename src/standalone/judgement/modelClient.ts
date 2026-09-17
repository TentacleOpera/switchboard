import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/**
 * The controller's model client (plan:
 * judgement-tiers-the-supervisor-seat-and-reroute, change 7).
 *
 * ONE request shape for every backend: an OpenAI-compatible
 * `/v1/chat/completions` POST. The controller holds a URL; it never inspects
 * which runtime answers, and there is deliberately NO runtime-specific branch —
 * no native generation endpoint, no per-server parameter spelling, no literal
 * runtime name anywhere in this file.
 *
 * Three contract points that are load-bearing:
 *
 *  - `reasoning_effort: "none"` is sent on every call. A thinking model that
 *    suppresses its reasoning tokens can spend the whole budget and return an
 *    EMPTY body; a backend that does not recognise the field ignores it.
 *  - NO `response_format`, `format`, `grammar`, `guided_json` or
 *    `structured_outputs` field is ever sent. A grammar is an optimization the
 *    controller does not need; validation carries the safety.
 *  - The deadline covers CONNECT, not just read. A closed laptop lid black-holes
 *    a connection (no RST), and a bare connect would otherwise wait on the OS
 *    default — far longer than a wake interval.
 */

export interface ModelCallRequest {
    /** Full OpenAI-compatible chat-completions URL, used verbatim. */
    endpoint: string;
    model: string;
    apiKey: string | null;
    system: string;
    user: string;
    /** Total budget for connect + response, in ms. */
    deadlineMs: number;
    maxTokens: number;
}

export interface ModelCallResult {
    ok: boolean;
    content: string;
    /** OpenAI `finish_reason` or a native `done_reason`, whichever answered. */
    doneReason: string | null;
    latencyMs: number;
    /** Which model URL answered — recorded in every report entry. */
    url: string;
    status: number | null;
    error?: string;
}

export async function callModel(req: ModelCallRequest): Promise<ModelCallResult> {
    const started = Date.now();
    const url = req.endpoint;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, content: '', doneReason: null, latencyMs: 0, url, status: null, error: `endpoint is not a URL: ${url}` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, content: '', doneReason: null, latencyMs: 0, url, status: null, error: `endpoint scheme '${parsed.protocol}' is not http(s)` };
    }

    const body = JSON.stringify({
        ...(req.model ? { model: req.model } : {}),
        messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
        ],
        temperature: 0,
        max_tokens: req.maxTokens,
        // Undocumented on some backends, ignored by them; load-bearing on the
        // ones that would otherwise return an empty thinking-only body.
        reasoning_effort: 'none',
    });

    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) };
    if (req.apiKey) { headers['Authorization'] = `Bearer ${req.apiKey}`; }

    // Both modules expose an identical `request` shape; the cast keeps the call
    // site single-typed rather than a union of two module namespaces.
    const lib = (parsed.protocol === 'https:' ? https : http) as typeof http;

    return new Promise<ModelCallResult>((resolve) => {
        let settled = false;
        const finish = (result: ModelCallResult) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(deadlineTimer);
            resolve(result);
        };
        const deadlineTimer = setTimeout(() => {
            try { request.destroy(); } catch { /* ignore */ }
            finish({ ok: false, content: '', doneReason: null, latencyMs: Date.now() - started, url, status: null, error: `model call exceeded its ${req.deadlineMs}ms deadline (host unreachable or black-holed)` });
        }, req.deadlineMs);

        const request = lib.request(url, { method: 'POST', headers }, (res) => {
            let raw = '';
            res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
            res.on('end', () => {
                const status = res.statusCode ?? 0;
                if (status < 200 || status >= 300) {
                    finish({ ok: false, content: '', doneReason: null, latencyMs: Date.now() - started, url, status, error: `model endpoint returned ${status}` });
                    return;
                }
                let data: any;
                try {
                    data = JSON.parse(raw);
                } catch (e) {
                    finish({ ok: false, content: '', doneReason: null, latencyMs: Date.now() - started, url, status, error: `model reply is not JSON: ${e instanceof Error ? e.message : String(e)}` });
                    return;
                }
                const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
                const content = String(choice?.message?.content ?? data?.content ?? '');
                const doneReason = choice?.finish_reason ?? data?.done_reason ?? null;
                finish({
                    ok: true,
                    content,
                    doneReason: doneReason === undefined || doneReason === null ? null : String(doneReason),
                    latencyMs: Date.now() - started,
                    url,
                    status,
                });
            });
        });
        // A second, socket-level guard: a stalled connect or a server that
        // accepts and then never writes is caught by the same deadline timer
        // above, but this also bounds the idle read.
        request.setTimeout(req.deadlineMs, () => {
            try { request.destroy(); } catch { /* ignore */ }
            finish({ ok: false, content: '', doneReason: null, latencyMs: Date.now() - started, url, status: null, error: `model call timed out after ${req.deadlineMs}ms` });
        });
        request.on('error', (err) => {
            finish({ ok: false, content: '', doneReason: null, latencyMs: Date.now() - started, url, status: null, error: `model call failed: ${err.message}` });
        });
        request.write(body);
        request.end();
    });
}

/**
 * An empty body that ran to the token ceiling is a FAILED VALIDATION, not an
 * answer: a thinking model that never emits a visible token is
 * indistinguishable from a broken one, and both take the `unknown` path.
 */
export function isEmptyLengthStop(result: ModelCallResult): boolean {
    return result.ok && result.content.trim().length === 0 && result.doneReason === 'length';
}
