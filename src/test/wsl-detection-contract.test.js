'use strict';

/**
 * WSL detection contract.
 *
 * `detectWsl()` is the discriminator the standalone CLI's `openBrowser()` uses
 * to decide between `cmd.exe /c start` (WSL), `open` (macOS), `cmd /c start`
 * (native Windows), and `xdg-open` (Linux). A wrong answer is SILENT:
 *   - Returning `{ wsl: true }` on real Linux makes `openBrowser` call
 *     `cmd.exe`, which does not exist — the URL never opens and the user has
 *     to find it in the log.
 *   - Returning `{ wsl: false }` inside WSL makes `openBrowser` call
 *     `xdg-open`, which does not exist in a minimal WSL install — same silent
 *     failure.
 *   - Misclassifying WSL1 as WSL2 (or vice versa) does not break browser
 *     opening, but it does break the diagnostic log line that tells the user
 *     why node-pty might not have prebuilt binaries.
 *   - Crashing on a missing `/proc/version` would block server startup on a
 *     broken minimal install — the read must be wrapped.
 *   - Re-reading `/proc/version` on every call is cheap but pointless, and
 *     `openBrowser` is called on every launch — the cache must hold.
 *
 * None of these are reachable by compile or lint, so this is the only gate on
 * the detection. The tests run the compiled module from `out/` after
 * `npm run compile-tests`; they mock `process.platform`, `fs.readFileSync`,
 * and `child_process.spawn` via a child Node process so the cache reset and
 * platform swap do not leak into other tests in the same process.
 */

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO_ROOT, 'src');

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  \u2705 ${name}`);
    } catch (err) {
        failures++;
        console.error(`  \u274c ${name}`);
        console.error(`     ${err.message}`);
    }
}

/**
 * Run a snippet of code in a fresh child Node process with `out/` on the
 * require path. The child prints a JSON result on its last stdout line; a
 * non-zero exit or a parse failure is a test failure.
 */
function runChild(body) {
    const script = `
        'use strict';
        const Module = require('module');
        const origLoad = Module._load;
        // Stub out the 'vscode' module — some transitive imports try to load it
        // even though wslDetect itself does not.
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') { return {}; }
            return origLoad.apply(this, arguments);
        };
        ${body}
        process.stdout.write('\\n__RESULT__' + JSON.stringify(result));
    `;
    const res = childProcess.spawnSync(process.execPath, ['-e', script], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    });
    if (res.status !== 0) {
        throw new Error(`child exited ${res.status}: ${res.stderr || res.stdout}`);
    }
    const out = res.stdout || '';
    const marker = out.lastIndexOf('__RESULT__');
    if (marker === -1) {
        throw new Error(`no __RESULT__ marker in child output: ${out}`);
    }
    return JSON.parse(out.slice(marker + '__RESULT__'.length));
}

console.log('\n-- WSL detection contract --');

// 1. Non-Linux platform -> { wsl: false, version: null }
check('detectWsl() returns { wsl: false, version: null } when platform is not linux', () => {
    const result = runChild(`
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const { detectWsl } = require('./out/utils/wslDetect');
        const result = detectWsl();
    `);
    assert.deepStrictEqual(result, { wsl: false, version: null });
});

// 2. WSL2 /proc/version -> { wsl: true, version: 2 }
check('detectWsl() returns { wsl: true, version: 2 } for microsoft-standard', () => {
    const result = runChild(`
        const fs = require('fs');
        const origRead = fs.readFileSync;
        fs.readFileSync = function (p, enc) {
            if (p === '/proc/version') {
                return 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@65c8f4c3) #1 SMP Fri Mar 29 23:14:22 UTC 2024 x86_64 GNU/Linux';
            }
            return origRead.apply(this, arguments);
        };
        const { detectWsl } = require('./out/utils/wslDetect');
        const result = detectWsl();
    `);
    assert.deepStrictEqual(result, { wsl: true, version: 2 });
});

// 3. WSL1 /proc/version -> { wsl: true, version: 1 }
check('detectWsl() returns { wsl: true, version: 1 } for Microsoft without standard', () => {
    const result = runChild(`
        const fs = require('fs');
        const origRead = fs.readFileSync;
        fs.readFileSync = function (p, enc) {
            if (p === '/proc/version') {
                return 'Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft) #2311-Microsoft Wed Nov 04 21:00:00 PST 2020 x86_64 GNU/Linux';
            }
            return origRead.apply(this, arguments);
        };
        const { detectWsl } = require('./out/utils/wslDetect');
        const result = detectWsl();
    `);
    assert.deepStrictEqual(result, { wsl: true, version: 1 });
});

// 4. /proc/version read throws -> { wsl: false, version: null }
//    The module is required BEFORE the fs stub is installed: Node's CJS
//    loader calls fs.readFileSync to read the .js source itself, so a stub
//    that throws for every path crashes the require before detectWsl runs.
//    The stub intercepts ONLY /proc/version and delegates every other read
//    to the real fs, so the loader and any unrelated internal read still work.
check('detectWsl() returns { wsl: false, version: null } when /proc/version read throws', () => {
    const result = runChild(`
        const { detectWsl } = require('./out/utils/wslDetect');
        const fs = require('fs');
        const origRead = fs.readFileSync;
        fs.readFileSync = function (p) {
            if (p === '/proc/version') { throw new Error('ENOENT'); }
            return origRead.apply(this, arguments);
        };
        const result = detectWsl();
    `);
    assert.deepStrictEqual(result, { wsl: false, version: null });
});

// 5. Cached — second call does not re-read /proc/version
//    Same require-before-stub ordering as check 4: the loader must read the
//    source with the real fs before the counting stub is installed.
check('detectWsl() is cached — second call does not re-read /proc/version', () => {
    const result = runChild(`
        const { detectWsl } = require('./out/utils/wslDetect');
        const fs = require('fs');
        const origRead = fs.readFileSync;
        let readCount = 0;
        fs.readFileSync = function (p) {
            if (p === '/proc/version') { readCount++; return 'Linux version 5.15-microsoft-standard-WSL2'; }
            return origRead.apply(this, arguments);
        };
        detectWsl();
        detectWsl();
        const result = { readCount };
    `);
    assert.strictEqual(result.readCount, 1);
});

// 6. openBrowser() dispatches to cmd.exe when detectWsl() returns WSL2.
//    The standalone cli module's main() runs on require and never resolves
//    (it awaits a never-resolving promise to keep the server alive), so a
//    behavioural test that imports the compiled module would hang. Instead
//    this is a source contract: the openBrowser function must contain a WSL
//    arm that spawns `cmd.exe` with argv `['/c', 'start', '', <url>]` ahead of
//    the darwin/win32/xdg-open arms, and a wslview + print-URL fallback after
//    the primary spawn. This pins the exact dispatch logic the plan specifies;
//    a behavioural test would require restructuring the CLI entry's startup,
//    which is out of scope for this additive change.
check('openBrowser() source dispatches to cmd.exe on WSL with wslview fallback', () => {
    const cliSrc = fs.readFileSync(path.join(SRC, 'standalone', 'cli.ts'), 'utf8');
    const openBrowserMatch = cliSrc.match(/async function openBrowser[\s\S]*?^}/m);
    assert.ok(openBrowserMatch, 'openBrowser function not found in cli.ts');
    const body = openBrowserMatch[0];
    // WSL arm precedes the platform arms and spawns cmd.exe with the expected argv.
    assert.ok(/detectWsl\(\)/.test(body), 'openBrowser does not call detectWsl()');
    assert.ok(/wsl\.wsl\)/.test(body), 'openBrowser has no wsl.wsl branch');
    assert.ok(/cmd\.exe/.test(body), 'openBrowser WSL arm does not use cmd.exe');
    assert.ok(/'\/c',\s*'start',\s*'',\s*url/.test(body), 'openBrowser WSL argv is not ["/c","start","",url]');
    // The WSL arm must come before the darwin/win32/xdg-open arms so it wins.
    const wslIdx = body.indexOf('wsl.wsl');
    const darwinIdx = body.indexOf("'darwin'");
    const win32Idx = body.indexOf("'win32'");
    const xdgIdx = body.indexOf('xdg-open');
    assert.ok(wslIdx > -1 && wslIdx < darwinIdx, 'WSL arm must precede the darwin arm');
    assert.ok(wslIdx < win32Idx, 'WSL arm must precede the win32 arm');
    assert.ok(wslIdx < xdgIdx, 'WSL arm must precede the xdg-open arm');
    // Fallback chain: wslview then print, inside the catch, only on WSL.
    assert.ok(/wslview/.test(body), 'openBrowser has no wslview fallback');
    assert.ok(/Open this URL in your Windows browser/.test(body), 'openBrowser has no print-URL fallback');
});

if (failures > 0) {
    console.error(`\n${failures} WSL detection contract check(s) failed.`);
    process.exit(1);
}
console.log('\nAll WSL detection contract checks passed.');
