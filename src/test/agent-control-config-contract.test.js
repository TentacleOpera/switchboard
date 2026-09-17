'use strict';

/**
 * Contract: the agent control surface configures and drives itself.
 *
 * Pins the decisions from
 * `the-agent-control-surface-cannot-be-configured-and-is-driven-by-typing`:
 *
 *   - POST /agent/control/config exists, is auth-gated, writes endpoint+model
 *     to their own config keys and the API key to the encrypted secrets store
 *   - the API key is NEVER in any response body — keySet is all a client learns
 *   - GET /agent/control/config reports endpoint/model/keySet + modelConfigured
 *   - _resolveAgentControlModel reads the ACTIVE PROVIDER ROW and nothing else.
 *     Two unreleased shapes took clean breaks here, neither with a migration:
 *     the startupCommands URL overload, and the flat
 *     agentControlEndpoint/agentControlModel keys (plus the unsuffixed shared
 *     API key slot) that existed for one day between a9497bd6 and 2da42df4
 *   - BOTH composition roots wire store/delete on the encryptedSecretsStore
 *     seam — a get-only root would leave the surface able to read a key it
 *     cannot set, and "never wired" looks identical to "working"
 *   - POST /agent/control's free-text arm is gone: a `text` body is a 400, the
 *     retained model call takes a dropdown-selected cardId
 *   - the mechanical quick actions (needsModel: false) are still served with
 *     no model configured — the surface does not go blank
 *
 * Behavioural half runs against a real LocalApiServer (out/) with a fake
 * secrets store; the composition-root parity half is a source pin, the same
 * technique the standalone-parity suites use.
 *
 * Run with: npm run compile-tests && node src/test/agent-control-config-contract.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

require(path.join(process.cwd(), 'src', 'test', 'bootstrap', 'sandboxStateHome.js'));

const REPO = process.cwd();
const { LocalApiServer } = require(path.join(REPO, 'out', 'services', 'LocalApiServer.js'));
const { GlobalIntegrationConfigService } = require(path.join(REPO, 'out', 'services', 'GlobalIntegrationConfigService.js'));

const localApiServerTs = fs.readFileSync(path.join(REPO, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
const bootstrapTs = fs.readFileSync(path.join(REPO, 'src', 'standalone', 'bootstrap.ts'), 'utf8');
const tvpTs = fs.readFileSync(path.join(REPO, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
const sharedUtilsJs = fs.readFileSync(path.join(REPO, 'src', 'webview', 'sharedUtils.js'), 'utf8');
const dockJs = fs.readFileSync(path.join(REPO, 'src', 'webview', 'dock.js'), 'utf8');
const commandJs = fs.readFileSync(path.join(REPO, 'src', 'webview', 'command.js'), 'utf8');

let failures = 0;
async function check(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err && err.message ? err.message : err}`);
    }
}

const WS = '/tmp/agent-control-config-ws';

/** In-memory HostSecrets double — records every write the endpoint makes. */
function makeSecrets(initial = {}) {
    const map = new Map(Object.entries(initial));
    const calls = [];
    return {
        calls,
        get: async (k) => map.get(k),
        store: async (k, v) => { calls.push(['store', k, v]); map.set(k, v); },
        delete: async (k) => { calls.push(['delete', k]); map.delete(k); },
        _map: map,
    };
}

function makeServer({ secrets, authToken } = {}) {
    const server = new LocalApiServer({
        clickupMetadataPath: '',
        linearMetadataPath: '',
        getClickUpService: () => null,
        getLinearService: () => null,
        getNotionService: () => null,
        getAuthToken: async () => authToken || '',
        allRoots: [WS],
        workspaceRoot: WS,
        getKanbanDatabase: async () => ({
            ensureReady: async () => {},
            getWorkspaceId: async () => 'ws-1',
            getDominantWorkspaceId: async () => 'ws-1',
            getPlans: async () => [],
        }),
        encryptedSecretsStore: secrets || null,
        armQueueWatch: async () => {},
    });
    return server;
}

async function request(server, method, url, body, authToken) {
    // `x-switchboard-client` is the CSRF-guard marker every supported
    // non-browser caller sends: Guard 3b rejects a state-changing request
    // that carries none of Sec-Fetch-Site / Origin / the marker.
    const headers = {
        'content-type': 'application/json',
        'host': '127.0.0.1:7777',
        'x-switchboard-client': 'agent-control-config-contract',
    };
    if (authToken !== undefined) { headers['authorization'] = `Bearer ${authToken}`; }
    const req = {
        method,
        url,
        headers,
        on: (event, cb) => {
            if (event === 'data') cb(Buffer.from(JSON.stringify(body || {})));
            else if (event === 'end') cb();
        },
        socket: { destroy: () => {}, remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
    };
    let status = 0;
    let responseBody = null;
    // The response has to be honest about Node's ServerResponse surface:
    // _handleRequest wraps `res` in the compression Proxy, which reads
    // getHeaders() at every writeHead (the CORS headers Guard 4 setHeader'd
    // must survive the merge) and getHeader('Vary') for the Vary append.
    // A writeHead/setHeader-only fake made every read endpoint 500.
    const headerMap = {};
    const res = {
        headersSent: false,
        writeHead: (code, hdrs) => {
            status = code;
            res.statusCode = code;
            res.headersSent = true;
            if (hdrs && typeof hdrs === 'object') {
                for (const [k, v] of Object.entries(hdrs)) { headerMap[k.toLowerCase()] = v; }
            }
            return res;
        },
        setHeader: (k, v) => { headerMap[String(k).toLowerCase()] = v; },
        getHeader: (k) => headerMap[String(k).toLowerCase()],
        getHeaders: () => ({ ...headerMap }),
        removeHeader: (k) => { delete headerMap[String(k).toLowerCase()]; },
        write: (chunk) => { if (chunk) { responseBody = (responseBody || '') + String(chunk); } return true; },
        once: () => res,
        on: () => res,
        destroy: () => {},
        end: (data) => {
            if (data) { responseBody = (responseBody || '') + String(data); }
            responseBody = responseBody ? JSON.parse(responseBody) : null;
        },
    };
    await server._handleRequest(req, res);
    return { status, body: responseBody };
}

/**
 * Configure the active provider ROW — the only shape the resolver reads.
 * There is deliberately no flat-key equivalent: those keys are gone.
 */
async function setRow(provider, endpoint, model) {
    await GlobalIntegrationConfigService.setAgentConfig('agentControlProvider', provider);
    await GlobalIntegrationConfigService.setAgentConfig('agentControlProviders',
        { [provider]: { endpoint, model } });
}

const getConfig = (s, tok) => request(s, 'GET', '/agent/control/config', undefined, tok);
const postConfig = (s, b, tok) => request(s, 'POST', '/agent/control/config', b, tok);
const postControl = (s, b, tok) => request(s, 'POST', '/agent/control', b, tok);

async function run() {
    console.log('\nAgent-control config contract\n');

    // ── The write path: the key has a setter reachable from the surface ────

    await check('POST /agent/control/config writes the key to the secrets store and reports keySet, never the value', async () => {
        const secrets = makeSecrets();
        const server = makeServer({ secrets });
        const r = await postConfig(server, {
            provider: 'custom',
            endpoint: 'https://models.example/v1/chat',
            model: 'claude-opus-4.6',
            apiKey: 'sk-secret-xyz',
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.success, true);
        assert.strictEqual(r.body.keySet, true);
        const raw = JSON.stringify(r.body);
        assert.ok(!raw.includes('sk-secret-xyz'), 'the response body must never contain the key value');
        assert.ok(!('apiKey' in r.body), 'the response body must not carry an apiKey field');
        // PROVIDER-SCOPED, always. The unsuffixed slot was the one-day
        // pre-normalisation shape and is neither written nor read any more.
        assert.strictEqual(secrets._map.get('switchboard.agentControl.apiKey.custom'), 'sk-secret-xyz',
            'the key must land in the encrypted secrets store under its provider');
        assert.strictEqual(secrets._map.get('switchboard.agentControl.apiKey'), undefined,
            'nothing may write the unsuffixed pre-normalisation key slot');
        assert.strictEqual(r.body.endpoint, 'https://models.example/v1/chat',
            'the write reads back from the row it just wrote');
        // Key written BEFORE endpoint/model — the key-first write order keeps
        // a mid-write reader from seeing "new endpoint, no key".
        const storeIdx = secrets.calls.findIndex(c => c[0] === 'store');
        assert.ok(storeIdx !== -1, 'the key write must reach the secrets store');
    });

    await check('GET /agent/control/config reports endpoint + model + keySet — and never the key', async () => {
        const secrets = makeSecrets({ 'switchboard.agentControl.apiKey.custom': 'sk-hidden' });
        const server = makeServer({ secrets });
        await setRow('custom', 'https://ep.example/v1', 'm-1');
        const r = await getConfig(server);
        assert.strictEqual(r.status, 200);
        const cfg = r.body.data || r.body;
        assert.strictEqual(cfg.endpoint, 'https://ep.example/v1');
        assert.strictEqual(cfg.model, 'm-1');
        assert.strictEqual(cfg.keySet, true);
        assert.ok(!JSON.stringify(r.body).includes('sk-hidden'), 'GET config must never echo the key');
        assert.strictEqual(cfg.modelConfigured, true, 'endpoint+model+key resolves to configured');
    });

    await check('modelConfigured is false when the key is unset — and the reason is reported', async () => {
        const secrets = makeSecrets();
        const server = makeServer({ secrets });
        await setRow('custom', 'https://ep.example/v1', 'm-1');
        const r = await getConfig(server);
        const cfg = r.body.data || r.body;
        assert.strictEqual(cfg.modelConfigured, false, 'endpoint without a key is not configured');
        assert.ok(cfg.modelError && /API key/i.test(cfg.modelError), 'the missing key is named in modelError');
        assert.strictEqual(cfg.keySet, false);
    });

    await check('endpoint set but model unset is half-configured, not silently defaulted', async () => {
        const secrets = makeSecrets({ 'switchboard.agentControl.apiKey.custom': 'sk-x' });
        const server = makeServer({ secrets });
        await setRow('custom', 'https://ep.example/v1', '');
        const r = await getConfig(server);
        const cfg = r.body.data || r.body;
        assert.strictEqual(cfg.modelConfigured, false);
        assert.ok(cfg.modelError && /model/i.test(cfg.modelError), 'the missing model is named in modelError');
    });

    await check('POST /agent/control/config is auth-gated when a token is configured', async () => {
        const secrets = makeSecrets();
        const server = makeServer({ secrets, authToken: 'expected-token' });
        const denied = await postConfig(server, { apiKey: 'x' }); // no Authorization header
        assert.strictEqual(denied.status, 401, 'an unauthenticated write must 401');
        const allowed = await postConfig(server, { apiKey: 'x' }, 'expected-token');
        assert.strictEqual(allowed.status, 200, 'a Bearer-matched write succeeds');
    });

    // ── The retired startup-command overload: clean break, no migration ────
    // The overload never shipped — unreleased dev work — so there is nothing
    // to import. The pin is the negative: the resolver must not read
    // startupCommands at all (see the source-pin check below), and a URL left
    // in project_manager must have no effect on the reported endpoint.

    await check('a URL in startupCommands.project_manager is NOT consulted — the overload is gone', async () => {
        const secrets = makeSecrets();
        const server = makeServer({ secrets });
        await GlobalIntegrationConfigService.setAgentConfig('agentControlProvider', '');
        await GlobalIntegrationConfigService.setAgentConfig('agentControlProviders', {});
        await GlobalIntegrationConfigService.setAgentStartupCommands({ project_manager: 'https://legacy.example/v1' });
        const r = await getConfig(server);
        const cfg = r.body.data || r.body;
        assert.strictEqual(r.status, 200);
        assert.strictEqual(cfg.endpoint, null,
            'a startup-command URL must not become the endpoint — the overload took a clean break');
        assert.deepStrictEqual(
            await GlobalIntegrationConfigService.getAgentConfig('agentControlProviders') || {},
            {}, 'no migration write may resurrect the legacy URL into a provider row');
    });

    // ── The text arm is gone; the card-driven Resolve is what remains ──────

    await check('POST /agent/control rejects a free-text body — the keyword parser is removed', async () => {
        const server = makeServer({ secrets: makeSecrets() });
        const r = await postControl(server, { text: 'dispatch my starred cards', history: [] });
        assert.strictEqual(r.status, 400, 'a {text} body must 400 — there is no intent box to send it');
    });

    // ── Source pins: the seams and reads this suite cannot observe ─────────

    await check('_resolveAgentControlModel reads its own keys and never touches startupCommands', async () => {
        const resolver = localApiServerTs.slice(
            localApiServerTs.indexOf('private async _resolveAgentControlEndpoint'),
            localApiServerTs.indexOf('private async _resolveAgentControlApiKey'));
        assert.ok(!resolver.includes('getAgentStartupCommands'),
            'the endpoint resolver must not read startupCommands — the unreleased overload took a clean break');
        assert.ok(!resolver.includes('project_manager') && !resolver.includes('mission-control'),
            'no project_manager/mission-control fallback may remain in the endpoint resolver');
        const model = localApiServerTs.slice(
            localApiServerTs.indexOf('private async _resolveAgentControlModel'),
            localApiServerTs.indexOf('private static _usableAgentModel'));
        assert.ok(!model.includes('getAgentStartupCommands'),
            'the model resolver must not read startupCommands');
        const row = localApiServerTs.slice(
            localApiServerTs.indexOf('private async _resolveAgentControlRow'),
            localApiServerTs.indexOf('private async _resolveAgentControlEndpoint'));
        assert.ok(row.includes("'agentControlProviders'") && row.includes("'agentControlProvider'"),
            'the row resolver must read the provider pointer and the rows');
    });

    // ── The flat config shape: clean break, no migration ───────────────────
    // agentControlEndpoint/agentControlModel and the unsuffixed shared API key
    // existed for ONE DAY in unreleased dev work (a9497bd6 -> 2da42df4) and were
    // never in a release tag. Per CLAUDE.md, unreleased state takes a clean
    // break — there was no install to migrate, only this working tree. These
    // pins are the negative: nothing may read or resurrect that shape.

    await check('the flat keys are gone — no read, no migration, no provider guess', async () => {
        assert.ok(!localApiServerTs.includes("'agentControlEndpoint'"),
            'nothing may read the flat agentControlEndpoint key');
        assert.ok(!localApiServerTs.includes("'agentControlModel'"),
            'nothing may read the flat agentControlModel key');
        assert.ok(!localApiServerTs.includes('migrated-flat'),
            'the migrated-flat source variant must be gone — a row is the only shape');
        assert.ok(!localApiServerTs.includes('_providerIdForEndpoint'),
            'the endpoint-to-provider guess existed only for the migration and must be gone');
        assert.ok(!/get\('switchboard\.agentControl\.apiKey'\)/.test(localApiServerTs),
            'the unsuffixed shared API key slot must not be read — a key must not answer '
            + 'for a provider that never issued it');
    });

    await check('a stale flat key cannot resurrect itself into a row', async () => {
        const secrets = makeSecrets();
        const server = makeServer({ secrets });
        await GlobalIntegrationConfigService.setAgentConfig('agentControlProvider', '');
        await GlobalIntegrationConfigService.setAgentConfig('agentControlProviders', {});
        // Write the retired shape directly, as an old working tree would have it.
        await GlobalIntegrationConfigService.setAgentConfig('agentControlEndpoint', 'https://stale.example/v1');
        await GlobalIntegrationConfigService.setAgentConfig('agentControlModel', 'stale-m');
        const r = await getConfig(server);
        const cfg = r.body.data || r.body;
        assert.strictEqual(cfg.endpoint, null, 'a flat endpoint must not be read back');
        assert.deepStrictEqual(
            await GlobalIntegrationConfigService.getAgentConfig('agentControlProviders') || {},
            {}, 'no row may be written from a flat key');
    });

    await check('the config row renders an unset provider AS unset — no guess, no default', async () => {
        // The client twin of _providerIdForEndpoint. Guessing a provider from a
        // stored URL only ever made sense for a flat endpoint with no row; an
        // endpoint now lives inside a row and cannot exist without one.
        // Code, not prose — the comment above the deletion names it deliberately.
        assert.ok(!/function\s+inferFromEndpoint/.test(sharedUtilsJs),
            'the endpoint-to-provider guess must not be defined');
        assert.ok(!/\binferFromEndpoint\s*[,(]/.test(sharedUtilsJs),
            'the endpoint-to-provider guess must be neither exported nor called');
        assert.ok(!/providerId\s*=\s*[^;]*\|\|\s*'google'/.test(sharedUtilsJs),
            'an unchosen provider must not default to Google — unset and chosen must not render alike');
        assert.ok(/none\.value\s*=\s*''/.test(sharedUtilsJs),
            'the provider select must carry an explicit unset option');
    });

    await check('BOTH surfaces refuse a save with no provider — the pane must not drift', async () => {
        // dock.js and command.js each carry their own copy of this pane. A guard
        // in one and not the other is the divergence no gate catches.
        for (const [label, src] of [['dock.js', dockJs], ['command.js', commandJs]]) {
            assert.ok(/selectedProviderId\(\)/.test(src),
                `${label} must ask the shared row whether a provider is chosen`);
            assert.ok(/Choose a provider before saving/.test(src),
                `${label} must refuse a providerless save instead of reporting "Saved." for a no-op`);
        }
    });

    await check('both composition roots wire store AND delete on encryptedSecretsStore', async () => {
        // Grep-level pin on the options object — the "never wired and working
        // are the same value" trap, pinned for both hosts.
        for (const [label, src] of [['bootstrap.ts', bootstrapTs], ['TaskViewerProvider.ts', tvpTs]]) {
            const seam = src.slice(src.indexOf('encryptedSecretsStore'), src.indexOf('encryptedSecretsStore') + 600);
            assert.ok(/store\s*:/.test(seam), `${label} must wire store() on encryptedSecretsStore`);
            assert.ok(/delete\s*:/.test(seam), `${label} must wire delete() on encryptedSecretsStore`);
            assert.ok(/get\s*:/.test(seam), `${label} must keep wiring get() on encryptedSecretsStore`);
        }
    });

    await check('the seam type declares store and delete — a get-only literal no longer compiles', async () => {
        const decl = localApiServerTs.slice(
            localApiServerTs.indexOf('encryptedSecretsStore?:'),
            localApiServerTs.indexOf('encryptedSecretsStore?:') + 400);
        assert.ok(/store\(key:\s*string,\s*value:\s*string\)/.test(decl), 'the option type must declare store');
        assert.ok(/delete\(key:\s*string\)/.test(decl), 'the option type must declare delete');
    });

    await check('the mechanical quick actions still ship needsModel: false — the surface does not go blank', async () => {
        const server = makeServer({ secrets: makeSecrets() });
        const r = await getConfig(server);
        const cfg = r.body.data || r.body;
        const mechanical = (cfg.quickActions || []).filter(a => a.needsModel === false);
        assert.ok(mechanical.length >= 6,
            'the six mechanical actions must be served even with no model configured');
        // The model-backed Resolve is GONE (plan: the-agent-panel-becomes-a-
        // standing-controller, change 2) — judgement belongs to the controller,
        // not to a verb the panel asks a model to pick for a card the operator
        // already resolved.
        const resolve = (cfg.quickActions || []).find(a => a.id === 'resolve-card');
        assert.ok(!resolve, 'the model-backed resolve-card action must be retired');
        assert.ok(mechanical.every(a => a.needsModel === false),
            'no mechanical action may be gated on a model');
    });
}

run().then(() => {
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
