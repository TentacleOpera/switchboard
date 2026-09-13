'use strict';

/**
 * WSL detection contract.
 *
 * `detectWsl()` was the discriminator the standalone CLI's `openBrowser()` used
 * to decide between `cmd.exe /c start` (WSL), `open` (macOS), `cmd /c start`
 * (native Windows), and `xdg-open` (Linux). `openBrowser` was removed (plan:
 * starting-the-board-prints-where-to-reach-it-and-opens-nothing) — starting
 * the board never opens a browser — so `detectWsl` has no live consumer in the
 * standalone CLI today. The utility itself stays tested here: the detection
 * logic is correct, and a future consumer (or phase 2 cleanup) can rely on it.
 *
 * A wrong answer is SILENT:
 *   - Returning `{ wsl: true }` on real Linux would mislabel the install.
 *   - Returning `{ wsl: false }` inside WSL would miss the diagnostic.
 *   - Misclassifying WSL1 as WSL2 (or vice versa) does not break the
 *     diagnostic, but it does break the log line's accuracy.
 *   - Crashing on a missing `/proc/version` would block server startup on a
 *     broken minimal install — the read must be wrapped.
 *   - Re-reading `/proc/version` on every call is cheap but pointless, and
 *     the cache must hold.
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

if (failures > 0) {
    console.error(`\n${failures} WSL detection contract check(s) failed.`);
    process.exit(1);
}
console.log('\nAll WSL detection contract checks passed.');
