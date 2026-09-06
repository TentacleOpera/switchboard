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

if (failures > 0) {
    process.exit(1);
}
console.log('PTY host gating contract passed.');
