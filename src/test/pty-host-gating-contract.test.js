'use strict';

/**
 * Contract: PTY host gating after node-pty removal.
 *
 * HISTORY — read this before "fixing" the test.
 * The original directive (2026-07-31) was that PTY terminals be standalone-only,
 * and this file enforced it with a hard, mechanical invariant: `dist/extension.js`
 * must contain zero node-pty module references. The user reversed that, then this
 * feature retired node-pty entirely in favour of a packaged Go host.
 *
 * What this file now pins:
 *   1. No live TypeScript/JavaScript runtime import of node-pty.
 *   2. Both composition roots construct the same PtyHostSupervisor.
 *   3. Protocol fixtures freeze the versioned verb surface.
 *   4. Unsupported platforms fail loudly; there is no Node PTY fallback.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO_ROOT, 'src');

const RUNTIME_LOAD_PATTERNS = [
    /require\(\s*['"]node-pty['"]\s*\)/,
    /^\s*import\s+[^;]*\bfrom\s+['"]node-pty['"]/m,
];

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${err.message}`);
    }
}

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'vendor') { continue; }
            walk(full, out);
        } else if (/\.(ts|js)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

console.log('\n── PTY host gating contract ──');

check('no live source file runtime-loads node-pty', () => {
    const files = walk(SRC);
    const hits = [];
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        for (const pattern of RUNTIME_LOAD_PATTERNS) {
            if (pattern.test(text)) {
                hits.push(path.relative(REPO_ROOT, file));
                break;
            }
        }
    }
    assert.deepStrictEqual(hits, [], `runtime node-pty load sites remain: ${hits.join(', ')}`);
});

check('package.json / lockfile / webpack / vscodeignore do not keep node-pty', () => {
    for (const file of ['package.json', 'package-lock.json', 'webpack.config.js', '.vscodeignore']) {
        const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
        assert.ok(!text.includes('node-pty'), `${file} still names retired dependency`);
    }
});

check('webpack no longer ships ptyHost.ts as an entry', () => {
    const webpack = fs.readFileSync(path.join(REPO_ROOT, 'webpack.config.js'), 'utf8');
    assert.ok(!webpack.includes('ptyHost.ts'), 'retired TypeScript host remains a webpack entry');
});

check('both composition roots construct PtyHostSupervisor', () => {
    const extension = fs.readFileSync(path.join(SRC, 'extension.ts'), 'utf8');
    const bootstrap = fs.readFileSync(path.join(SRC, 'standalone', 'bootstrap.ts'), 'utf8');
    assert.ok(extension.includes('new PtyHostSupervisor'), 'extension root missing supervisor');
    assert.ok(bootstrap.includes('new PtyHostSupervisor'), 'standalone root missing supervisor');
    assert.ok(!bootstrap.includes('new PtyFleetService('), 'standalone still constructs Node fleet');
    assert.ok(!extension.includes('new PtyFleetService('), 'extension constructs Node fleet');
});

check('Node PTY fallback is retired with a fail-loud backend', () => {
    const backend = fs.readFileSync(path.join(SRC, 'standalone', 'ptyBackend.ts'), 'utf8');
    assert.ok(backend.includes('return false'), 'isPtyAvailable must not claim a Node backend');
    assert.ok(backend.includes('Node PTY fallback is removed'), 'backend must refuse Node fallback');
});

check('artifact manifest is versioned and platform-selected', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'pty-host-artifacts.json'), 'utf8'));
    assert.strictEqual(manifest.version, 1);
    assert.strictEqual(manifest.binary, 'switchboard-pty-host');
    assert.deepStrictEqual(Object.keys(manifest.targets).sort(), ['darwin-amd64', 'darwin-arm64', 'linux-amd64', 'linux-arm64']);
});

check('language-neutral fixtures freeze the ready handshake and verb inventory', () => {
    const fixtures = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'protocol-fixtures', 'pty-host-ready.json'), 'utf8'));
    assert.strictEqual(fixtures.protocolVersion, 1);
    assert.strictEqual(fixtures.ready.t, 'ready');
    const required = [
        'ptyCreateTerminal', 'ptyCreateBatch', 'ptyCloseTerminal', 'ptyListTerminals',
        'ptyRenameTerminal', 'ptyClearTerminal', 'ptySendModel', 'ptyClearAllTerminals',
        'ptyWrite', 'ptyPasteImage', 'ptySendPrompt', 'ptySetControllerSeat', 'ptyRollLogSession',
    ];
    assert.deepStrictEqual(fixtures.requiredVerbs, required);
    for (const verb of required) {
        assert.ok(fixtures.verbs[verb], `fixture missing verb ${verb}`);
    }
    assert.strictEqual(fixtures.bytes.chunkBoundary, 256);
    assert.ok(fixtures.lifecycle.includes('stdin-eof'));
    assert.ok(fixtures.lifecycle.includes('parent-disappearance'));
    assert.strictEqual(fixtures.websocket.emptyToken, 401);
    assert.strictEqual(fixtures.invalidJson.status, 400);
    assert.strictEqual(fixtures.unknownVerb.body.code, 'unknown_verb');
});

check('Go host implements the required verbs', () => {
    const main = fs.readFileSync(path.join(REPO_ROOT, 'cmd', 'switchboard-pty-host', 'main.go'), 'utf8');
    const prompt = fs.readFileSync(path.join(REPO_ROOT, 'cmd', 'switchboard-pty-host', 'prompt.go'), 'utf8');
    for (const verb of [
        'ptyCreateTerminal', 'ptyCreateBatch', 'ptyCloseTerminal', 'ptyListTerminals',
        'ptyRenameTerminal', 'ptyClearTerminal', 'ptySendModel', 'ptyClearAllTerminals',
        'ptyWrite', 'ptyPasteImage', 'ptySendPrompt', 'ptySetControllerSeat', 'ptyRollLogSession',
    ]) {
        assert.ok(main.includes(`"${verb}"`) || main.includes(`case "${verb}"`), `Go host missing ${verb}`);
    }
    assert.ok(prompt.includes('bracketedPasteOpen'), 'prompt delivery missing bracketed paste open');
    assert.ok(prompt.includes('confirmEnterDelay'), 'prompt delivery missing confirm CR delay');
    assert.ok(main.includes('payload["data"]') || main.includes('strField(payload, "data")'), 'ptySendPrompt must accept data payload');
});

check('Go host declares a clearStrategy for every recognised family and an argv template for every respawn family', () => {
    const prompt = fs.readFileSync(path.join(REPO_ROOT, 'cmd', 'switchboard-pty-host', 'prompt.go'), 'utf8');
    assert.ok(/func clearStrategy\(family string\) string/.test(prompt), 'Go host missing clearStrategy declaration');
    assert.ok(/func respawnArgvSuffix\(family, prompt string\) string/.test(prompt), 'Go host missing respawnArgvSuffix declaration');
    assert.ok(/func shellQuote\(s string\) string/.test(prompt), 'Go host missing shellQuote helper');
    // Every family the readiness table recognises must be covered by
    // clearStrategy. A family added to readiness but not to clearStrategy
    // would silently fall back to in-process on a guess.
    const recognisedFamilies = ['claude', 'antigravity', 'devin'];
    for (const fam of recognisedFamilies) {
        const re = new RegExp(`case "${fam}"`);
        assert.ok(re.test(prompt), `clearStrategy table missing family ${fam}`);
    }
    // Respawn families (devin) must have an argv template branch in
    // respawnArgvSuffix — a respawn family without a template would inject
    // the prompt in the wrong shape.
    assert.ok(/case "devin":\s*return " -- " \+ quoted/.test(prompt), 'devin respawn argv template missing or mis-shaped (must be ` -- ` + quoted)');
    // Unknown families default to in-process, never respawn — a guess.
    assert.ok(/default:\s*return "in-process"/.test(prompt), 'clearStrategy must default unknown families to in-process, not respawn');
});

check('Go host respawn path never calls writeSlashLocked and in-process path still does', () => {
    const prompt = fs.readFileSync(path.join(REPO_ROOT, 'cmd', 'switchboard-pty-host', 'prompt.go'), 'utf8');
    const main = fs.readFileSync(path.join(REPO_ROOT, 'cmd', 'switchboard-pty-host', 'main.go'), 'utf8');
    // The respawn branch in deliverPrompt must not type /clear.
    const respawnBranch = prompt.slice(prompt.indexOf('clearStrategy(family) == "respawn"'));
    assert.ok(!respawnBranch.includes('writeSlashLocked'), 'respawn branch must not call writeSlashLocked');
    // The in-process branch must still call writeSlashLocked(t, "/clear").
    const inProcessBranch = prompt.slice(prompt.indexOf('clearReadinessWindows(family)'));
    assert.ok(inProcessBranch.includes('writeSlashLocked'), 'in-process branch must still call writeSlashLocked');
    // ptyClearTerminal and ptyClearAllTerminals must consult clearStrategy.
    assert.ok(/ptyClearAllTerminals[\s\S]*?clearStrategy\(t\.cliFamily\) == "respawn"/.test(main), 'ptyClearAllTerminals must consult clearStrategy');
    assert.ok(/ptyClearTerminal[\s\S]*?clearStrategy\(t\.cliFamily\) == "respawn"/.test(main), 'ptyClearTerminal must consult clearStrategy');
});

check('Go host respawn requires a startup command and fails loudly without one', () => {
    const main = fs.readFileSync(path.join(REPO_ROOT, 'cmd', 'switchboard-pty-host', 'main.go'), 'utf8');
    assert.ok(/respawn requires a startup command for role/.test(main), 'respawnTerminal must fail loudly when startupCommand is empty, naming the role');
    // The startup command must be recorded at create so respawn can re-inject it.
    assert.ok(/startupCommand:\s*strField\(payload, "startupCommand"\)/.test(main), 'terminal create must record startupCommand from payload');
    // The env slice must be retained so a respawn starts under the same identity.
    assert.ok(/env:\s*env,/.test(main), 'terminal create must retain env slice for respawn identity');
});

check('Node mirror of clearStrategy agrees with the Go host', () => {
    const cliIdentity = fs.readFileSync(path.join(SRC, 'services', 'cliIdentity.ts'), 'utf8');
    assert.ok(/export type ClearStrategy = 'in-process' \| 'respawn'/.test(cliIdentity), 'cliIdentity.ts missing ClearStrategy type');
    assert.ok(/export function clearStrategyForFamily/.test(cliIdentity), 'cliIdentity.ts missing clearStrategyForFamily');
    // devin must be respawn in both trees; everything else in-process.
    assert.ok(/case 'devin':\s*return 'respawn'/.test(cliIdentity), 'Node clearStrategy must declare devin as respawn');
    assert.ok(/default:\s*return 'in-process'/.test(cliIdentity), 'Node clearStrategy must default to in-process');
});

check('ptyPromptDelivery skips the in-process readiness tracker for respawn families', () => {
    const delivery = fs.readFileSync(path.join(SRC, 'standalone', 'ptyPromptDelivery.ts'), 'utf8');
    assert.ok(/clearStrategyForFamily\(family\) === 'respawn'/.test(delivery), 'ptyPromptDelivery must skip readiness for respawn families');
    // The slash path must still be present for in-process families.
    assert.ok(/writeSlashCommandLocked\(handle, '\/clear'/.test(delivery), 'in-process slash path must remain for in-process families');
});

if (failures > 0) {
    process.exit(1);
}
console.log('PTY host gating contract passed.');
