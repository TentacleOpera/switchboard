const fs = require('fs');
const path = require('path');
const assert = require('assert');

/**
 * Contract: PTY host gating.
 *
 * HISTORY — read this before "fixing" the test.
 * The original directive (2026-07-31) was that PTY terminals be standalone-only,
 * and this file enforced it with a hard, mechanical invariant: `dist/extension.js`
 * must contain zero node-pty module references. The user reversed that directive
 * the same day — the VS Code marketplace is the only distribution channel that
 * exists (nothing is published to npm), and an owned terminal surface enables
 * layouts / per-worktree tabs / completion messages that VS Code's terminal panel
 * structurally cannot. See `.switchboard/plans/reverse-pty-standalone-only-constraint.md`.
 *
 * THE TRADE, STATED PLAINLY.
 * "Never in the extension bundle" was verifiable by grep. Its replacement — "only
 * reached behind the availability probe" — is NOT verifiable by grep, because no
 * static check can prove a call is guarded at runtime. This file is therefore a
 * genuinely weaker gate than the one it replaces. What it CAN do is pin the two
 * structural facts that make the soft invariant auditable by a human in one sitting:
 *
 *   1. Exactly ONE module loads the native binding (`ptyBackend.ts`).
 *   2. That module exports the probe every capability flag derives from.
 *
 * If either fact stops holding, "audit the gate" stops being a bounded task, and
 * this test is the thing that notices.
 *
 * Do not "restore" the old bundle-purity assertion. node-pty in the extension
 * bundle is now EXPECTED once `extension-host-pty-fleet-and-packaging.md` lands.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO_ROOT, 'src');

/**
 * Modules permitted to perform a RUNTIME load of node-pty.
 *
 * Deliberately a one-entry list, not a directory prefix: the point of the gate is
 * that the load site is singular and auditable. Adding an entry here is a
 * deliberate act that should be justified in review — widening it to a directory
 * would quietly permit an unbounded number of load sites.
 */
const ALLOWED_LOAD_SITES = [
    'src/standalone/ptyBackend.ts',
];

/** Type-only references (`typeof import('node-pty')`, `import('node-pty').IPty`) are free. */
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

// This file necessarily contains the module-reference forms it searches for (as
// string literals and regexes), so it exempts itself.
const SELF = path.relative(REPO_ROOT, __filename).replace(/\\/g, '/');

check('the native binding is loaded in exactly one module, and it is the allowed one', () => {
    const loadSites = [];
    for (const file of walk(SRC)) {
        const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
        if (rel === SELF) { continue; }
        const text = fs.readFileSync(file, 'utf8');
        if (!/node-pty/.test(text)) { continue; }
        if (RUNTIME_LOAD_PATTERNS.some(re => re.test(text))) {
            loadSites.push(rel);
        }
    }
    assert.deepStrictEqual(
        loadSites.sort(), [...ALLOWED_LOAD_SITES].sort(),
        `node-pty runtime load sites must be exactly ${JSON.stringify(ALLOWED_LOAD_SITES)}; found ${JSON.stringify(loadSites)}. `
        + 'A second load site means the availability gate can be bypassed and the "one function to audit" property is lost.'
    );
});

check('the single load site exports the availability probe', () => {
    const backend = path.join(REPO_ROOT, ALLOWED_LOAD_SITES[0]);
    const text = fs.readFileSync(backend, 'utf8');
    assert.ok(
        /export function isPtyAvailable\s*\(/.test(text),
        `${ALLOWED_LOAD_SITES[0]} must export isPtyAvailable() — it is the single derivation point for `
        + 'terminalDispatch, terminalFleet and availability.terminals. Without it those flags cannot fail closed.'
    );
    assert.ok(
        /catch\s*\(/.test(text),
        'isPtyAvailable() must swallow the load failure and return false — node-pty is an optionalDependency '
        + '(no Linux prebuild), so an absent binding is a supported state, not a crash.'
    );
});

check('no native binary is ever webpack-bundled into dist', () => {
    const dist = path.join(REPO_ROOT, 'dist');
    if (!fs.existsSync(dist)) {
        assert.fail('dist/ is missing — run `npm run compile` first. This check must not be waived in the release path.');
    }
    const binaries = [];
    (function scan(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { scan(full); }
            else if (entry.name.endsWith('.node')) { binaries.push(path.relative(REPO_ROOT, full)); }
        }
    })(dist);
    assert.deepStrictEqual(
        binaries, [],
        `webpack bundled native binaries into dist: ${binaries.join(', ')}. node-pty must stay a commonjs external `
        + 'and load from node_modules at runtime — a bundled .node cannot work across platforms.'
    );
});

check('node-pty is externalized wherever it is referenced by a webpack config', () => {
    const cfg = fs.readFileSync(path.join(REPO_ROOT, 'webpack.config.js'), 'utf8');
    assert.ok(
        /'node-pty':\s*'commonjs node-pty'/.test(cfg),
        "standaloneConfig must declare externals { 'node-pty': 'commonjs node-pty' }"
    );
    // Once the extension host gains a PTY fleet, its config must externalize the
    // module too. Asserted as a conditional so this passes both before and after
    // that change: if the extension config grows a node-pty reference, it must be
    // an externals entry, never a bundled import.
    const externalsCount = (cfg.match(/'node-pty':\s*'commonjs node-pty'/g) || []).length;
    const importCount = (cfg.match(/require\(\s*['"]node-pty['"]\s*\)/g) || []).length;
    assert.strictEqual(
        importCount, 0,
        'webpack.config.js must not require node-pty directly; it belongs in externals only.'
    );
    assert.ok(externalsCount >= 1, 'at least one webpack config must externalize node-pty');
});

if (failures > 0) {
    console.error(`\n${failures} contract check(s) failed.\n`);
    process.exit(1);
}
console.log('\nAll PTY host gating checks passed.\n');
