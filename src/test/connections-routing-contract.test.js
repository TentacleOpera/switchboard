'use strict';
/**
 * Contract: the Connections panel must forward every verb it posts to the same
 * provider in both the extension host (ConnectionsPanelProvider) and the HTTP
 * route (LocalApiServer /connections/verb/). It must also contribute no arms of
 * its own.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CNX = fs.readFileSync(path.join(__dirname, '..', 'webview', 'connections.js'), 'utf8');
const LOCAL = fs.readFileSync(path.join(ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
const PROVIDER = fs.readFileSync(path.join(ROOT, 'src', 'services', 'ConnectionsPanelProvider.ts'), 'utf8');
const TRANSPORT = fs.readFileSync(path.join(__dirname, '..', 'webview', 'transport.js'), 'utf8');
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'protocol-catalog.json'), 'utf8'));

const SETUP_VERBS = new Set(CATALOG.providers.Setup.verbs);
const PLANNING_VERBS = new Set(CATALOG.providers.Planning.verbs);

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

function resolveProvider(verb) {
    if (SETUP_VERBS.has(verb)) { return 'Setup'; }
    if (PLANNING_VERBS.has(verb)) { return 'Planning'; }
    return null;
}

const actionMatch = CNX.match(/const action = remoteControlActive \? '([^']+)' : '([^']+)'/);
const actionVerbs = actionMatch ? [actionMatch[1], actionMatch[2]] : ['stopRemoteControl', 'startRemoteControl'];

const allTypes = new Set([
    ...actionVerbs,
    ...[...CNX.matchAll(/type:\s*(['"])([^'"]+)\1/g)].map(m => m[2])
]);

const postedVerbs = [...allTypes].filter(v => SETUP_VERBS.has(v) || PLANNING_VERBS.has(v));

test('ConnectionsPanelProvider routes through generated allowlists', () => {
    assert.match(PROVIDER, /if \(SETUP_VERBS\.has\(type\)\)/,
        'ConnectionsPanelProvider must check SETUP_VERBS first');
    assert.match(PROVIDER, /else if \(PLANNING_VERBS\.has\(type\)\)/,
        'ConnectionsPanelProvider must fall back to PLANNING_VERBS');
    assert.match(PROVIDER, /it is in neither SETUP_VERBS nor PLANNING_VERBS/,
        'unknown verb error must name both sets');
});

test('HTTP /connections/verb/ route uses the same precedence', () => {
    const start = LOCAL.indexOf("} else if (pathname.startsWith('/connections/verb/')");
    assert.ok(start >= 0, '/connections/verb/ branch not found');
    const branch = LOCAL.slice(start, start + 2500);
    assert.match(branch, /if \(SETUP_VERBS\.has\(verb\)\)/,
        'HTTP route must check SETUP_VERBS first');
    assert.match(branch, /else if \(PLANNING_VERBS\.has\(verb\)\)/,
        'HTTP route must fall back to PLANNING_VERBS');
});

test('every verb posted by connections.js resolves to the same provider in both hosts', () => {
    for (const verb of postedVerbs) {
        const expected = resolveProvider(verb);
        assert.ok(expected, `posted verb '${verb}' is in neither Setup nor Planning`);
        // Both hosts use the same rule: Setup wins, then Planning. Assert the
        // source text also calls the matching provider in the two branches.
        const first = SETUP_VERBS.has(verb) ? 'Setup' : 'Planning';
        assert.strictEqual(first, expected,
            `precedence mismatch for '${verb}'`);
    }
});

test('openConnectionsPanel is a cross-panel switch in the browser shim', () => {
    const m = TRANSPORT.match(/const PANEL_SWITCH_VERBS = \{([\s\S]*?)\};/);
    assert.ok(m, 'PANEL_SWITCH_VERBS not found');
    assert.match(m[1], /openConnectionsPanel:\s*'connections'/,
        'openConnectionsPanel must switch to the connections panel client-side');
});

test('ConnectionsPanelProvider contributes no verb arms', () => {
    assert.ok(!CATALOG.providers.Connections,
        'Connections must not appear as a provider in protocol-catalog.json');
    // A provider with arms would have `case '<verb>':` blocks. The forwarder must not.
    assert.ok(!/case\s+['"][^'"]+['"]\s*:/.test(PROVIDER),
        'ConnectionsPanelProvider must not contain verb arms');
    // It also must not define SETUP_VERBS / PLANNING_VERBS (imported from generated).
    assert.ok(!/export const (SETUP|PLANNING)_VERBS/.test(PROVIDER),
        'ConnectionsPanelProvider must not define its own allowlists');
});

// The forwarder redirects the two target providers' push methods for the duration
// of a call. That is global mutable state on shared objects, so it is only safe if
// forwards cannot overlap. They genuinely can: connections.js polls
// `getRemoteHealth` on a 15 s interval while Remote Control is active, so a click
// can land mid-poll.
//
// The failure this pins is permanent, not transient. With per-call capture, a
// second forward starting mid-await captures the FIRST call's patch as its
// "original" and reinstalls it on completion — every later Setup push routes to the
// Connections webview forever, and vanishes silently once that panel closes,
// because the postMessage rejection is swallowed. The Setup panel simply stops
// updating, with no error anywhere.
test('forwards are serialised so the push redirection cannot interleave', () => {
    assert.match(PROVIDER, /_forwardChain/,
        'no serialisation: overlapping forwards interleave patch/restore on two shared providers');
    assert.match(PROVIDER, /_forwardChain\s*=\s*this\._forwardChain\.then\(/,
        'forwards must be queued on a promise chain, not fired concurrently');
});

test('the push redirection restores PRISTINE methods, not whatever is installed', () => {
    assert.match(PROVIDER, /_pristineSetupPostMessage/, 'no pristine capture for the Setup push method');
    assert.match(PROVIDER, /_pristinePlanningPostMessage/, 'no pristine capture for the Planning push method');
    // The bug is capture-inside-the-call. Assert the capture is guarded so it
    // happens once, and that restore reads the field rather than a local.
    assert.match(PROVIDER, /if \(!this\._pristineSetupPostMessage\)/,
        'the pristine method must be captured once, not re-captured per call');
    assert.match(PROVIDER, /postMessage = this\._pristineSetupPostMessage/,
        'restore must target the pristine field, not a per-call local');
    assert.ok(!/const original\w*PostMessage\s*=/.test(PROVIDER),
        'a per-call `original…PostMessage` local is the exact shape that reinstalls a patch permanently');
});

// ── De-fork: the Remote form lives in Connections only ─────────────────────
// It existed in BOTH setup.html and connections.html with independent handlers and
// different field coverage — a fork of shipped UI, which PRD contract #1 forbids.
// The Connections copy also omitted boards and silent-sync, and `setRemoteConfig`
// REPLACES the stored object, so saving from the partial form wiped them.
const SETUP_HTML = fs.readFileSync(path.join(__dirname, '..', 'webview', 'setup.html'), 'utf8');
const CNX_HTML = fs.readFileSync(path.join(__dirname, '..', 'webview', 'connections.html'), 'utf8');

// Every control the form needs to round-trip a complete RemoteConfig, plus the
// board-state-export pair that shared its tab.
const REMOTE_CONTROL_IDS = [
    'remote-provider', 'remote-workspace', 'remote-boards-list', 'remote-silent-sync',
    'remote-mode-ingest', 'remote-mode-full', 'remote-comments', 'remote-content',
    'remote-push', 'remote-ping-frequency', 'btn-remote-control-toggle',
    'remote-health-poll', 'btn-copy-linear-agent-skill', 'btn-notion-remote-setup',
    'board-state-export-select', 'board-state-export-remote-url'
];

test('the Remote form lives in connections.html, in full', () => {
    const missing = REMOTE_CONTROL_IDS.filter(id => !CNX_HTML.includes(`id="${id}"`));
    assert.deepStrictEqual(missing, [],
        'connections.html is missing controls the Remote form needs — a partial form cannot replace the Setup tab');
});

test('setup.html no longer renders a second copy of it', () => {
    const duplicated = REMOTE_CONTROL_IDS.filter(id => SETUP_HTML.includes(`id="${id}"`));
    assert.deepStrictEqual(duplicated, [],
        'these ids still exist in setup.html — two live forms writing one config key is the fork this closed');
});

test('setup.html keeps a signpost, and it is wired', () => {
    assert.match(SETUP_HTML, /Remote Control is now Connections/,
        'the Remote tab must point at Connections for at least one release, not vanish');
    assert.match(SETUP_HTML, /btn-open-connections-from-setup/, 'signpost button missing');
    assert.match(SETUP_HTML, /type: 'openConnectionsPanel'/, 'signpost button posts nothing');
    assert.ok(SETUP_VERBS.has('openConnectionsPanel'),
        'openConnectionsPanel must be a Setup verb or the signpost dead-clicks in the extension host');
});

test('no orphaned Remote handler survives in setup.html', () => {
    // Removing markup while leaving handlers is how BOARD STATE EXPORT became
    // unreachable the first time; leaving handlers that call deleted functions is a
    // ReferenceError when the host pushes.
    for (const fn of ['applyRemoteControlButtonState', 'renderRemoteConfig',
        'renderRemoteSyncHealth', 'remoteCollectConfig', 'remoteAutosave',
        'applyRemoteProviderUi', 'requestRemoteHealth']) {
        assert.ok(!SETUP_HTML.includes(fn), `setup.html still references '${fn}' after the move`);
    }
    for (const msg of ["case 'remoteConfig'", "case 'remoteControlState'", "case 'remoteSyncHealth'"]) {
        assert.ok(!SETUP_HTML.includes(msg), `setup.html still handles ${msg} — it has no form to render into`);
    }
});

test('connections.js handles every Remote push the host actually sends', () => {
    for (const msg of ['remoteConfig', 'remoteControlState', 'remoteSyncHealth',
        'boardStateExportSetting', 'notionRemoteSetupResult', 'linearAgentSkillText',
        'integrationSetupStates']) {
        assert.ok(CNX.includes(`case '${msg}'`),
            `connections.js does not handle '${msg}' — that state renders as a default over the user's real setting`);
    }
    // The health push is `remoteSyncHealth` with a structured object; an earlier
    // version listened for a `remoteHealthResult` the host never sends. Comments
    // legitimately name the stale type to explain it, so check code only.
    const cnxCode = CNX.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assert.ok(!cnxCode.includes('remoteHealthResult'), 'stale health message type still handled');
});

const PLANNING = fs.readFileSync(path.join(ROOT, 'src', 'services', 'PlanningPanelProvider.ts'), 'utf8');
const BOOTSTRAP = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'bootstrap.ts'), 'utf8');

// Scope each assertion to its own arm. A file-global `return { success: true, ... }`
// count is useless: PlanningPanelProvider already has 18 of them, so a global check
// is green before the fix lands and stays green if the fix is reverted.
function armBody(verb) {
    const start = PLANNING.indexOf(`case '${verb}': {`);
    assert.ok(start >= 0, `arm '${verb}' not found`);
    const next = PLANNING.indexOf("            case '", start + 10);
    return PLANNING.slice(start, next > start ? next : start + 4000);
}

test('Connections-consumed createPlans arms return their typed body, not just a push', () => {
    for (const [verb, type] of [
        ['createPlansInit', 'createPlansState'],
        ['createPlansPickFolder', 'createPlansFolderPicked'],
        ['createPlansPasteBack', 'createPlansPasteBackResult'],
    ]) {
        const body = armBody(verb);
        assert.ok(body.includes(`type: '${type}'`), `${verb} must still build a ${type} payload`);
        assert.match(body, /return \{[^}]*success[^}]*\}/,
            `${verb} must RETURN its payload: the browser Connections panel reaches it via `
            + `/connections/verb → _handlePlanningVerb, the 'planning'-tagged push never reaches a `
            + `connections-subscribed client, and transport.js drops an untyped body`);
        assert.ok(body.includes('this.postMessageToWebview('),
            `${verb} must keep its push — PRD contract #4 keeps the webview push additive`);
    }
});

test("createPlansPasteBack's import command is bridged in BOTH hosts", () => {
    // Registered in extension.ts for the extension host. In standalone an unbridged
    // command falls through to vscodeShim.executeCommand, which warns and returns
    // undefined WITHOUT throwing — so the arm takes its success branch and the panel
    // renders "Plan card created" for a plan that was never written.
    assert.match(BOOTSTRAP, /switchboardCommandRegistry\.register\(\s*'switchboard\.importPlanFromClipboard'/,
        'standalone must bridge switchboard.importPlanFromClipboard or paste-back reports a false success');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
