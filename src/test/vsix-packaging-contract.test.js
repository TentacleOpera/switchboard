'use strict';

/**
 * Contract: VSIX packaging for the native node-pty module.
 * (extension-host-pty-fleet-and-packaging.md, step 1.)
 *
 * WHY THIS FILE EXISTS — the trap it pins.
 * `.vscodeignore` is NOT evaluated top-to-bottom. vsce partitions the file into an
 * ignore list and a negate list and filters with:
 *
 *     files.filter(f => !ignore.some(i => minimatch(f, i)) || negate.some(i => minimatch(f, i)))
 *
 * A negation therefore wins UNCONDITIONALLY over every ignore pattern, regardless of
 * line order. So a blanket `!node_modules/node-pty` + glob silently re-includes the
 * 28 MB of `.pdb` debug symbols that a later dot-pdb rule appears to exclude — and the
 * mistake is invisible by inspection, because the file reads as if order mattered.
 * That is a ~3 MB vs ~30 MB Windows VSIX, against a documented Marketplace upload cap
 * of 25-50 MB.
 *
 * This test re-implements vsce's filter and runs it over the REAL node-pty tree, so
 * the assertion is about what would actually ship, not about how the file reads.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { minimatch } = require('minimatch');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NODE_PTY = path.join(REPO_ROOT, 'node_modules', 'node-pty');

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

/** vsce's .vscodeignore semantics, reproduced exactly. See package.ts `collectFiles`. */
function buildVsceFilter(ignoreFileText) {
    let patterns = ignoreFileText
        .split(/[\n\r]/)
        .map(s => s.trim())
        .filter(s => !!s)
        .filter(i => !/^\s*#/.test(i));

    // vsce appends '/**' to entries that look like bare directory names.
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

const hasNodePty = fs.existsSync(NODE_PTY);
if (!hasNodePty) {
    console.log('  ⚠️  node_modules/node-pty absent (optionalDependency) — file-level assertions skipped.');
}

check('no .pdb debug symbol would be packaged', () => {
    if (!hasNodePty) { return; }
    const shipped = walkRel(NODE_PTY, REPO_ROOT).filter(included);
    const pdbs = shipped.filter(f => /\.pdb$/i.test(f));
    assert.deepStrictEqual(
        pdbs, [],
        `${pdbs.length} .pdb file(s) would ship (e.g. ${pdbs.slice(0, 3).join(', ')}). `
        + 'A negation in .vscodeignore is re-including them — negations override ignores unconditionally, '
        + 'so the negation itself must not match .pdb. Enumerate the runtime file types instead of using a blanket !node_modules/node-pty/**.'
    );
});

check('the runtime files node-pty actually loads WOULD be packaged', () => {
    if (!hasNodePty) { return; }
    // lib/utils.js `loadNativeModule` resolves prebuilds/<platform>-<arch>/<name>.node,
    // and a bare module require resolves package.json -> main -> lib/index.js. Excluding
    // any of these produces an extension that cannot load the module it ships.
    //
    // (Phrased without the literal module-require form on purpose: the PTY host gating
    // contract greps src/ for runtime load sites and would flag this file as a second
    // one. Widening that gate's one-entry allowlist to accommodate a comment would
    // defeat it; rewording the comment costs nothing.)
    for (const required of [
        'node_modules/node-pty/package.json',
        'node_modules/node-pty/lib/index.js',
        'node_modules/node-pty/lib/utils.js',
    ]) {
        assert.ok(included(required), `${required} must be packaged — node-pty cannot load without it.`);
    }
    const prebuilds = walkRel(path.join(NODE_PTY, 'prebuilds'), REPO_ROOT);
    for (const f of prebuilds.filter(p => /\.(node|dll|exe)$/i.test(p) || /\/spawn-helper$/.test(p))) {
        assert.ok(included(f), `${f} is a runtime binary and must be packaged.`);
    }
});

check('build-from-source trees are NOT packaged', () => {
    if (!hasNodePty) { return; }
    // src/, deps/, third_party/ are ~3.8 MB of compile inputs the runtime never reads.
    const shipped = walkRel(NODE_PTY, REPO_ROOT).filter(included);
    for (const deadWeight of ['node_modules/node-pty/src/', 'node_modules/node-pty/deps/', 'node_modules/node-pty/third_party/']) {
        const hits = shipped.filter(f => f.startsWith(deadWeight));
        assert.deepStrictEqual(
            hits, [],
            `${hits.length} file(s) under ${deadWeight} would ship; node-pty loads prebuilt binaries, never compiles at install.`
        );
    }
});

check('no source map would be packaged', () => {
    // Same negation trap, second instance: `!dist/**` and a blanket
    // `!node_modules/node-pty/lib/**` each overrode `**/*.map`, re-including 20 MB of
    // extension.js.map. The bundle is built with --devtool hidden-source-map, so
    // nothing references these at runtime.
    const roots = ['dist', path.join('node_modules', 'node-pty', 'lib')];
    const shipped = roots.flatMap(r => walkRel(path.join(REPO_ROOT, r), REPO_ROOT)).filter(included);
    const maps = shipped.filter(f => /\.map$/.test(f));
    assert.deepStrictEqual(
        maps.slice(0, 5), [],
        `${maps.length} source map(s) would ship (e.g. ${maps.slice(0, 3).join(', ')}). `
        + 'Check for a negation that overrides `**/*.map` — negations win unconditionally regardless of line order.'
    );
});

check('the extension bundle itself would still be packaged', () => {
    // Guard the over-correction: tightening map/negation rules must not drop dist.
    assert.ok(included('dist/extension.js'), 'dist/extension.js must be packaged — it is the extension entry point.');
});

check('the packaging script builds the full target matrix plus a target-less fallback', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'package-targets.sh'), 'utf8');
    for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64']) {
        assert.ok(new RegExp(target.replace('-', '\\-')).test(script), `matrix is missing target ${target}`);
    }
    assert.ok(
        !/--target\s+universal/.test(script),
        "'universal' is not a valid --target value — the fallback artifact is produced by OMITTING the flag."
    );
    assert.ok(
        /package --out/.test(script),
        'the script must produce a target-less (universal) artifact as the Marketplace fallback for unlisted platforms.'
    );
});

check('publishing is sequential by packagePath and never uses --skip-duplicate', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'publish-marketplace.sh'), 'utf8');
    const active = script.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
    assert.ok(
        /publish --packagePath/.test(active),
        'each artifact must be published with `vsce publish --packagePath <file>` — re-packaging per target loses the prebuild staging.'
    );
    assert.ok(
        !/--skip-duplicate/.test(active),
        'vsce #868/#1014: --skip-duplicate wrongly skips the 2nd..Nth target of one version. Never pass it in a multi-target publish.'
    );
});

check('platform targeting is supported by the declared engines.vscode floor', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const engine = pkg.engines && pkg.engines.vscode;
    assert.ok(engine, 'package.json must declare engines.vscode');
    const minor = /\^?(\d+)\.(\d+)/.exec(engine);
    assert.ok(minor, `could not parse engines.vscode '${engine}'`);
    const [, major, min] = minor.map(Number);
    assert.ok(
        major > 1 || (major === 1 && min >= 61),
        `platform-specific extensions require engines.vscode >= 1.61.0; found ${engine}.`
    );
});

if (failures > 0) {
    console.error(`\n${failures} contract check(s) failed.\n`);
    process.exit(1);
}
console.log('\nAll VSIX packaging checks passed.\n');
