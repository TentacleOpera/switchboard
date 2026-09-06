'use strict';

/**
 * Contract: VSIX packaging for the platform-selected Go PTY host.
 *
 * WHY THIS FILE EXISTS — the trap it pins.
 * `.vscodeignore` is NOT evaluated top-to-bottom. vsce partitions the file into an
 * ignore list and a negate list and filters with:
 *
 *     files.filter(f => !ignore.some(i => minimatch(f, i)) || negate.some(i => minimatch(f, i)))
 *
 * A negation therefore wins UNCONDITIONALLY over every ignore pattern, regardless of
 * line order. The previous node-pty allowlist tripped this and shipped debug symbols.
 * This file now asserts the Go artifacts WOULD ship and node-pty WOULD NOT.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { minimatch } = require('minimatch');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'pty-host-artifacts.json'), 'utf8'));

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

function buildVsceFilter(ignoreFileText) {
    let patterns = ignoreFileText
        .split(/[\n\r]/)
        .map(s => s.trim())
        .filter(s => !!s)
        .filter(i => !/^\s*#/.test(i));
    patterns = [
        ...patterns,
        ...patterns
            .filter(i => !/(^|\/)[^/]*\*[^/]*$/.test(i))
            .map(i => (/\/$/.test(i) ? `${i}**` : `${i}/**`)),
    ];
    const ignore = patterns.filter(e => !/^\s*!/.test(e));
    const negate = patterns.filter(e => /^\s*!/.test(e)).map(e => e.substr(1));
    const opts = { dot: true };
    return (relPath) =>
        !ignore.some(i => minimatch(relPath, i, opts)) || negate.some(i => minimatch(relPath, i, opts));
}

function walkRel(dir, base, out = []) {
    if (!fs.existsSync(dir)) { return out; }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walkRel(full, base, out); }
        else { out.push(path.relative(base, full).replace(/\\/g, '/')); }
    }
    return out;
}

console.log('\n── VSIX packaging contract ──');

const ignoreText = fs.readFileSync(path.join(REPO_ROOT, '.vscodeignore'), 'utf8');
const included = buildVsceFilter(ignoreText);

check('manifest declares the versioned Go host', () => {
    assert.strictEqual(MANIFEST.binary, 'switchboard-pty-host');
    assert.strictEqual(MANIFEST.version, 1);
});

check('manifest targets are explicit and platform-selected', () => {
    assert.deepStrictEqual(Object.keys(MANIFEST.targets).sort(), ['darwin-amd64', 'darwin-arm64', 'linux-amd64', 'linux-arm64']);
    for (const relative of Object.values(MANIFEST.targets)) {
        assert.ok(relative.startsWith('dist/'), `${relative} must live under dist/`);
    }
});

check('Go PTY artifacts WOULD be packaged by vsce filter', () => {
    assert.ok(included('pty-host-artifacts.json') || included('dist/pty-host-artifacts.json'),
        'manifest must not be ignored by .vscodeignore');
    for (const relative of Object.values(MANIFEST.targets)) {
        assert.ok(included(relative), `${relative} would be excluded from the VSIX`);
    }
});

check('node-pty would not be packaged', () => {
    assert.ok(!included('node_modules/node-pty/package.json'));
    assert.ok(!included('node_modules/node-pty/lib/index.js'));
    const nodePtyTree = path.join(REPO_ROOT, 'node_modules', 'node-pty');
    if (fs.existsSync(nodePtyTree)) {
        const shipped = walkRel(nodePtyTree, REPO_ROOT).filter(included);
        assert.deepStrictEqual(shipped, [], `${shipped.length} node-pty file(s) would ship`);
    }
});

check('no .pdb debug symbol would be packaged from node_modules', () => {
    const nodeModules = path.join(REPO_ROOT, 'node_modules');
    if (!fs.existsSync(nodeModules)) { return; }
    const pdbs = walkRel(nodeModules, REPO_ROOT).filter(f => /\.pdb$/i.test(f)).filter(included);
    assert.deepStrictEqual(pdbs, [], `${pdbs.length} .pdb file(s) would ship`);
});

check('packaging scripts build and probe the Go target matrix', () => {
    const targets = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'package-targets.sh'), 'utf8');
    const deb = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'package-deb.sh'), 'utf8');
    const build = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build-pty-host.sh'), 'utf8');
    for (const target of ['linux-arm64', 'linux-x64', 'darwin-arm64', 'darwin-x64']) {
        assert.ok(targets.includes(target), `package-targets missing ${target}`);
    }
    assert.ok(targets.includes('pty-host-artifacts.json'));
    assert.ok(!targets.includes('node-pty'));
    assert.ok(deb.includes('switchboard-pty-host'));
    assert.ok(deb.includes('handshake'));
    assert.ok(!deb.includes('node-pty'));
    assert.ok(build.includes('linux/amd64'));
    assert.ok(build.includes('darwin/arm64'));
});

check('release surfaces contain no retired native PTY dependency', () => {
    for (const file of ['package.json', 'package-lock.json', 'webpack.config.js', '.vscodeignore', 'scripts/package-deb.sh', 'scripts/package-targets.sh']) {
        assert.ok(!fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').includes('node-pty'), `${file} still names retired dependency`);
    }
});

if (failures > 0) { process.exit(1); }
console.log('VSIX packaging contract passed.');
