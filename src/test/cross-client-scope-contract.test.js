'use strict';

/**
 * Contract tests for the Cross-Client Project Scope Independence feature
 * (kanban-project-filter-client-local.md + per-connection-scoped-push-rendering.md).
 *
 * Covers the load-bearing contracts from both plans:
 *  - precedence: `!== undefined`, never truthiness — an explicit null/'__unassigned__'
 *    initiator or scope resolves to NO project tier, never the singleton
 *  - per-connection factory rendering in WsHub.broadcast (memoised per distinct
 *    scope) and BroadcastHub.push (webview pseudo-connection, rendered-at-enqueue)
 *  - ?scope= at upgrade (including the declared-null empty form), the __scope
 *    inbound handler's strict allowlist, and scope-rendered __resync
 *  - undeclared connections receive the singleton-rendered payload (the
 *    ~4,000-install compatibility guard)
 *  - _buildOverrideState keeps projectSwitchEnabled independent of the
 *    project-override flag (the toggle-enablement chicken-and-egg guard)
 *  - _postOverrideState emits with a broadcaster and no panel (guard relaxation)
 *  - source contracts: every boardProjectFilter assignment routes through
 *    setBoardProjectFilter, postKanbanMessage stamps initiatorProject centrally,
 *    the two declaration paths are exclusive, _refreshBoardImpl and
 *    getFullStateMessages send repo-scoped-but-not-project-filtered card sets
 *
 * Requires `npm run compile-tests` (loads compiled output from out/).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const { installVscodeTrap } = require('./helpers/verbEngineTestSeams');
installVscodeTrap();

// Same pre-existing gap as verb-engine-kanban-headless.test.js: tsc does not
// emit hand-written .js sources, so copy the derivation impl into out/.
{
    const implSrc = path.join(__dirname, '..', 'services', 'kanbanColumnDerivationImpl.js');
    const implOut = path.join(__dirname, '..', '..', 'out', 'services', 'kanbanColumnDerivationImpl.js');
    if (fs.existsSync(implSrc) && !fs.existsSync(implOut)) {
        fs.copyFileSync(implSrc, implOut);
    }
}

const { WsHub } = require('../../out/services/wsHub');
const { BroadcastHub } = require('../../out/services/broadcastHub');
const { KanbanProvider } = require('../../out/services/KanbanProvider');
const { KanbanDatabase } = require('../../out/services/KanbanDatabase');
const WebSocket = require('ws');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(`     ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e}`);
        failed++;
    }
}

function makeProvider(fields) {
    const kp = Object.create(KanbanProvider.prototype);
    kp._projectOverrideEnabled = false;
    kp._workspaceOverrideEnabled = false;
    kp._projectFilter = KanbanDatabase.UNASSIGNED_PROJECT_FILTER;
    kp._routingMapConfig = null;
    kp._cliTriggersEnabled = true;
    kp._columnDragDropModes = {};
    kp._autobanState = null;
    kp._showingBacklog = false;
    kp._pendingWebviewMessages = [];
    return Object.assign(kp, fields || {});
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    console.log('\n── _projectTier / resolveAuthoringProject precedence ──');

    await test('_projectTier: initiator wins by !== undefined, never truthiness', () => {
        const kp = makeProvider({ _projectOverrideEnabled: true, _projectFilter: 'Shared' });
        assert.strictEqual(kp._projectTier(undefined), 'Shared', 'no initiator → singleton');
        assert.strictEqual(kp._projectTier('Y'), 'Y', 'named initiator wins');
        assert.strictEqual(kp._projectTier(null), undefined, 'explicit null must NOT inherit the singleton');
        assert.strictEqual(kp._projectTier('__unassigned__'), undefined, 'explicit unassigned must NOT inherit the singleton');
    });

    await test('_projectTier: override OFF → no project tier for any input', () => {
        const kp = makeProvider({ _projectOverrideEnabled: false, _projectFilter: 'Shared' });
        assert.strictEqual(kp._projectTier(undefined), undefined);
        assert.strictEqual(kp._projectTier('Y'), undefined);
    });

    await test('resolveAuthoringProject: initiator short-circuits ahead of the DB row', async () => {
        const kp = makeProvider({ _projectFilter: 'Shared' });
        kp._getKanbanDb = () => ({ getConfig: async () => 'RowProject' });
        assert.strictEqual(await kp.resolveAuthoringProject('/ws', 'Y'), 'Y');
        assert.strictEqual(await kp.resolveAuthoringProject('/ws', null), undefined, 'null files unassigned');
        assert.strictEqual(await kp.resolveAuthoringProject('/ws', '__unassigned__'), undefined, 'unassigned files unassigned');
        assert.strictEqual(await kp.resolveAuthoringProject('/ws'), 'RowProject', 'no initiator → DB row');
    });

    console.log('\n── scoped push renderers ──');

    await test('ForScope helpers: undefined scope returns the CACHED singleton values (byte-identical fallback)', () => {
        const routing = { lead: [9], coder: [5], intern: [1] };
        const modes = { CODED: 'prompt' };
        const kp = makeProvider({ _routingMapConfig: routing, _cliTriggersEnabled: false, _columnDragDropModes: modes });
        kp._getScopedSetting = () => { throw new Error('must not hit the scoped accessor for undefined scope'); };
        assert.strictEqual(kp._routingMapForScope(undefined), routing, 'identity, not a re-read');
        assert.strictEqual(kp._cliTriggersForScope(undefined), false);
        const eff = kp._columnDragDropModesForScope(undefined, [{ id: 'CODED', dragDropMode: 'cli' }]);
        assert.strictEqual(eff.CODED, 'prompt');
    });

    await test('ForScope helpers: declared scope reaches _getScopedSetting RAW with the canonical kanban.* keys', () => {
        const calls = [];
        const kp = makeProvider();
        kp._getScopedSetting = (key, def, initiator) => { calls.push([key, def, initiator]); return def; };
        kp._routingMapForScope('Y');
        kp._cliTriggersForScope(null);
        kp._columnDragDropModesForScope('__unassigned__', []);
        assert.deepStrictEqual(calls[0], ['kanban.routingMapConfig', null, 'Y']);
        assert.deepStrictEqual(calls[1], ['kanban.cliTriggersEnabled', true, null], 'null passes through raw — pre-resolving it would collapse into the singleton');
        assert.deepStrictEqual(calls[2], ['kanban.columnDragDropModes', {}, '__unassigned__']);
    });

    await test('resolveRoutedRole: no initiator → cached map; initiator → scoped map', () => {
        const kp = makeProvider({ _routingMapConfig: { lead: [], coder: [5], intern: [] } });
        kp._getScopedSetting = (key, def, initiator) =>
            initiator === 'Y' ? { lead: [5], coder: [], intern: [] } : def;
        assert.strictEqual(kp.resolveRoutedRole(5), 'coder', 'singleton map routes 5 → coder');
        assert.strictEqual(kp.resolveRoutedRole(5, 'Y'), 'lead', "Y's map routes 5 → lead");
    });

    await test('built-in disabled stays a hard constraint under a scoped modes map', () => {
        const kp = makeProvider();
        kp._getScopedSetting = () => ({ DONE: 'cli' });
        const eff = kp._columnDragDropModesForScope('Y', [{ id: 'DONE', dragDropMode: 'disabled' }]);
        assert.strictEqual(eff.DONE, 'disabled');
    });

    console.log('\n── overrideState ──');

    await test('_buildOverrideState: projectSwitchEnabled is NOT gated on the project-override flag', () => {
        const kp = makeProvider({ _projectOverrideEnabled: false, _projectFilter: 'X' });
        const state = kp._buildOverrideState();
        assert.strictEqual(state.projectSwitchEnabled, true, 'toggle must stay enabled or project override can never be turned on');
        assert.strictEqual(state.activeProjectName, 'X');
        assert.strictEqual(state.activeScope, 'Global (default)');
    });

    await test('_buildOverrideState: renders per scope; undefined scope ≡ singleton; explicit null ≠ singleton', () => {
        const kp = makeProvider({ _projectOverrideEnabled: true, _projectFilter: 'X' });
        assert.strictEqual(kp._buildOverrideState().activeScope, "Project 'X'");
        assert.strictEqual(kp._buildOverrideState('Y').activeScope, "Project 'Y'");
        const nullScope = kp._buildOverrideState(null);
        assert.strictEqual(nullScope.projectSwitchEnabled, false);
        assert.strictEqual(nullScope.activeScope, 'Global (default)');
    });

    await test('_postOverrideState: emits via a broadcaster with NO panel (guard relaxation); silent with neither', () => {
        const pushed = [];
        const kp = makeProvider({ _projectOverrideEnabled: true, _projectFilter: 'Q', _panel: null });
        kp._broadcaster = { push: (m) => pushed.push(m) };
        kp._postOverrideState();
        assert.strictEqual(pushed.length, 1, 'browser-only session must receive overrideState');
        assert.strictEqual(typeof pushed[0], 'function', 'emitted as a per-connection factory');
        assert.strictEqual(pushed[0]('Z').activeScope, "Project 'Z'");
        const kp2 = makeProvider({ _panel: null, _broadcaster: undefined });
        kp2.postMessage = () => { throw new Error('must not emit'); };
        kp2._postOverrideState();
    });

    await test('postMessage: panel-only path renders a factory before webview delivery/queueing', async () => {
        const delivered = [];
        const kp = makeProvider({
            _broadcaster: undefined,
            _webviewReady: true,
            _panel: { webview: { postMessage: (m) => { delivered.push(m); return Promise.resolve(true); } } },
        });
        kp.postMessage((scope) => ({ type: 'probe', scope: scope === undefined ? 'none' : scope }));
        assert.strictEqual(typeof delivered[0], 'object', 'a bare function would fail the structured clone');
        assert.strictEqual(delivered[0].scope, 'none', 'no broadcaster → singleton (undefined) scope');
        kp._webviewReady = false;
        kp.postMessage((s) => ({ type: 'probe2' }));
        assert.strictEqual(typeof kp._pendingWebviewMessages[0], 'object', 'queued message must be rendered, never the factory');
    });

    console.log('\n── BroadcastHub: webview pseudo-connection ──');

    await test('push(factory): webview copy rendered with _webviewScope; WS mirror keeps the factory + a real verb', () => {
        const wvMsgs = [];
        const wsCalls = [];
        const hub = new BroadcastHub({
            webview: { postMessage: (m) => { wvMsgs.push(m); return Promise.resolve(true); } },
            apiServer: { broadcastWs: (verb, msg, surface) => wsCalls.push({ verb, msg, surface }) },
        });
        hub.setWebviewScope('EditorProj');
        hub.push((scope) => ({ type: 'cliTriggersState', enabled: scope === 'EditorProj' }), 'kanban');
        assert.strictEqual(wvMsgs[0].enabled, true, 'webview rendered with its own scope');
        assert.strictEqual(typeof wsCalls[0].msg, 'function', 'factory passes through for per-connection WS rendering');
        assert.strictEqual(wsCalls[0].verb, 'cliTriggersState', 'verb must not degrade to __unknown for factories');
    });

    await test('push(factory) with no webview: the RENDERED message is queued and flushed, never the factory', () => {
        const hub = new BroadcastHub({ webview: null, apiServer: null });
        hub.setWebviewScope('A');
        hub.push((scope) => ({ type: 'probe', scope }));
        hub.setWebviewScope('B'); // scope changes between enqueue and flush
        const flushed = [];
        hub.setWebview({ postMessage: (m) => { flushed.push(m); return Promise.resolve(true); } });
        assert.strictEqual(flushed[0].scope, 'A', 'rendered at enqueue time, not against the later scope');
    });

    console.log('\n── WsHub: scope declaration, resync, per-connection broadcast ──');

    await test('live hub: ?scope= at upgrade, scope-rendered resync, per-scope broadcast with memoised factory', async () => {
        const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const port = server.address().port;
        const resyncScopes = [];
        const hub = new WsHub({
            server,
            getAuthToken: async () => '',
            getFullState: async (scope) => { resyncScopes.push(scope); return [{ type: 'seed', scope: scope === undefined ? '<undeclared>' : scope }]; },
        });
        hub.attach();

        function connect(query) {
            return new Promise((resolve, reject) => {
                const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
                const received = [];
                ws.on('message', (raw) => {
                    const msg = JSON.parse(raw.toString());
                    received.push(msg);
                    if (msg.type === '__resync') resolve({ ws, received });
                });
                ws.on('error', reject);
            });
        }

        try {
            const a = await connect('?scope=Y');
            const b = await connect('?scope=');       // declared null — "no project filter"
            const c = await connect('');              // never declared → singleton fallback

            assert.strictEqual(a.received[0].payload[0].scope, 'Y', 'resync rendered in the connection scope');
            assert.strictEqual(b.received[0].payload[0].scope, null, 'empty ?scope= is declared-null, not undeclared');
            assert.strictEqual(c.received[0].payload[0].scope, '<undeclared>');

            let factoryCalls = 0;
            hub.broadcast('probe', (scope) => { factoryCalls++; return { got: scope === undefined ? '<undeclared>' : scope }; });
            await wait(150);
            assert.strictEqual(factoryCalls, 3, 'memoised per distinct scope (Y, null, undefined)');
            assert.strictEqual(a.received[1].payload.got, 'Y');
            assert.strictEqual(b.received[1].payload.got, null);
            assert.strictEqual(c.received[1].payload.got, '<undeclared>');

            // __scope updates the connection; junk frames must not.
            c.ws.send(JSON.stringify({ type: '__scope', project: 'Z' }));
            await wait(100);
            c.ws.send('not json');
            c.ws.send(JSON.stringify({ type: '__scope', project: 42 }));
            c.ws.send(JSON.stringify({ type: 'moveCardForward', sessionIds: ['x'] })); // never a verb rail
            c.ws.send('x'.repeat(5000));
            await wait(100);
            hub.broadcast('probe2', (scope) => ({ got: scope === undefined ? '<undeclared>' : scope }));
            await wait(150);
            const last = c.received[c.received.length - 1];
            assert.strictEqual(last.payload.got, 'Z', '__scope applied; junk/oversized/non-__scope frames ignored');

            // Static payloads: single compose, shared by all — the ~100 untouched push sites.
            hub.broadcast('static', { fixed: true });
            await wait(150);
            assert.strictEqual(a.received[a.received.length - 1].payload.fixed, true);
        } finally {
            hub.close();
            await new Promise((r) => server.close(r));
        }
    });

    console.log('\n── source contracts ──');

    const kanbanHtml = fs.readFileSync(path.join(__dirname, '..', 'webview', 'kanban.html'), 'utf8');
    const providerSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'KanbanProvider.ts'), 'utf8');
    const transportSrc = fs.readFileSync(path.join(__dirname, '..', 'webview', 'transport.js'), 'utf8');

    await test('kanban.html: every boardProjectFilter assignment routes through setBoardProjectFilter', () => {
        const assignments = kanbanHtml.match(/boardProjectFilter\s*=(?!=)/g) || [];
        assert.strictEqual(assignments.length, 2, `expected only the declaration + the helper body, found ${assignments.length} — a new assignment site must call setBoardProjectFilter(...)`);
    });

    await test('kanban.html: postKanbanMessage stamps initiatorProject centrally; declaration paths are exclusive', () => {
        assert.ok(/initiatorProject:\s*message\.initiatorProject\s*!==\s*undefined\s*\?\s*message\.initiatorProject\s*:\s*boardProjectFilter/.test(kanbanHtml),
            'central initiatorProject stamp missing from postKanbanMessage');
        assert.ok(/window\.__switchboardSetPushScope\(next\);\s*\}\s*else\s*\{\s*postKanbanMessage\(\{\s*type:\s*'setPushScope'/.test(kanbanHtml),
            'browser (__switchboardSetPushScope) and editor (setPushScope verb) declaration paths must be EXCLUSIVE — both firing lets a browser switch clobber the editor webview scope');
    });

    await test('KanbanProvider: card-source paths stay project-unfiltered (repoScope only)', () => {
        assert.ok(providerSrc.includes('? await db.getBoardFilteredByProject(workspaceId, null, repoScope)'),
            '_refreshBoardImpl must pass null for the project argument (proven bug 3)');
        assert.ok(providerSrc.includes('_buildBoardCards(db, wsId, root, activeRows, completedRows'),
            'getFullStateMessages must build cards from the repoScope-filtered rows, not an unconditional getBoard');
    });

    await test('transport.js: reconnect re-declares the live scope, including declared-null', () => {
        assert.ok(transportSrc.includes('pushScopeDeclared'), 'declared flag missing');
        assert.ok(/pushScope\s*\?\?\s*''/.test(transportSrc), 'declared-null must serialize as an empty scope param');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
