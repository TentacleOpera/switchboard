'use strict';

/**
 * Heap ceiling contract.
 *
 * Plan: the-heap-ceiling-is-set-by-the-launcher-so-the-npx-install-never-gets-it
 *
 * The plan's failure mode is a ceiling that is SILENTLY ABSENT on one launch
 * path — indistinguishable from one that is set, which is why it survived a
 * year. Four entry paths now carry the value and they can only stay honest if
 * something fails when they drift:
 *
 *   src/standalone/cli.ts          — the re-exec (npx / `node cli.js`)
 *   bin/switchboard                — the npm `bin` shim
 *   cmd/switchboard/main.go        — the .deb front controller
 *   internal/launcher/discovery.go — the icon/systemd launcher
 *
 * Asserted here:
 *  1. all four sites name the SAME default (the plan's "same formula,
 *     duplicated" option — duplicated is allowed, drifted is not),
 *  2. every site honours SWITCHBOARD_MAX_OLD_SPACE_MB,
 *  3. no path sets NODE_OPTIONS (it leaks into the Go pty-host child — a
 *     measured dead end recorded in all four sites),
 *  4. the re-exec has exactly one loop guard and deletes it,
 *  5. the re-exec is NOT taken for short-lived client verbs (`done`, `next`,
 *     `probe`, `verb`), which would double the process count of the most
 *     frequent command on the box for a ceiling they never approach.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');

let failures = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${err && err.message}`);
    }
}

console.log('\n── Heap ceiling contract ──');

const cliSrc = read('src/standalone/cli.ts');
const binSrc = read('bin/switchboard');
const mainGo = read('cmd/switchboard/main.go');
const discoveryGo = read('internal/launcher/discovery.go');

test('all four entry paths declare the same --max-old-space-size default', () => {
    const cli = /DEFAULT_MAX_OLD_SPACE_MB\s*=\s*'(\d+)'/.exec(cliSrc);
    const bin = /SWITCHBOARD_MAX_OLD_SPACE_MB:-(\d+)\}/.exec(binSrc);
    const main = /mb\s*=\s*"(\d+)"/.exec(mainGo);
    const disc = /mb\s*=\s*"(\d+)"/.exec(discoveryGo);
    assert.ok(cli, 'cli.ts must declare DEFAULT_MAX_OLD_SPACE_MB');
    assert.ok(bin, 'bin/switchboard must declare the ${SWITCHBOARD_MAX_OLD_SPACE_MB:-N} default');
    assert.ok(main, 'cmd/switchboard/main.go must declare a default mb');
    assert.ok(disc, 'internal/launcher/discovery.go must declare a default mb');
    const values = { 'cli.ts': cli[1], 'bin/switchboard': bin[1], 'main.go': main[1], 'discovery.go': disc[1] };
    const distinct = new Set(Object.values(values));
    assert.strictEqual(distinct.size, 1,
        `the four heap-ceiling defaults have drifted: ${JSON.stringify(values)}`);
});

test('every entry path honours SWITCHBOARD_MAX_OLD_SPACE_MB', () => {
    for (const [label, src] of [['cli.ts', cliSrc], ['bin/switchboard', binSrc], ['main.go', mainGo], ['discovery.go', discoveryGo]]) {
        assert.ok(src.includes('SWITCHBOARD_MAX_OLD_SPACE_MB'),
            `${label} must read the SWITCHBOARD_MAX_OLD_SPACE_MB override`);
    }
});

// Comments in every one of these files EXPLAIN why NODE_OPTIONS is forbidden,
// so a bare substring match flags the explanation. Strip comment lines first and
// assert on code only.
function codeOnly(src, ...prefixes) {
    return src.split('\n')
        .filter(line => !prefixes.some(pre => line.trim().startsWith(pre)))
        .join('\n');
}

test('no entry path sets NODE_OPTIONS (it leaks into the Go pty-host child)', () => {
    const stripped = [
        ['cli.ts', codeOnly(cliSrc, '//', '*', '/*')],
        ['bin/switchboard', codeOnly(binSrc, '#')],
        ['main.go', codeOnly(mainGo, '//')],
        ['discovery.go', codeOnly(discoveryGo, '//')],
    ];
    for (const [label, src] of stripped) {
        const sets = /NODE_OPTIONS\s*=/.test(src)
            || /['"`]NODE_OPTIONS['"`]\s*:/.test(src)
            || /export\s+NODE_OPTIONS/.test(src)
            || /Setenv\(\s*"NODE_OPTIONS"/.test(src);
        assert.ok(!sets, `${label} must not SET NODE_OPTIONS`);
    }
});

test('the re-exec has exactly one loop guard, and consumes it', () => {
    assert.ok(cliSrc.includes('SWITCHBOARD_HEAP_FLAG_APPLIED'),
        'cli.ts must carry the SWITCHBOARD_HEAP_FLAG_APPLIED loop guard');
    assert.ok(cliSrc.includes('delete process.env.SWITCHBOARD_HEAP_FLAG_APPLIED'),
        'the loop-guard marker must be deleted after the check so it never leaks to a child');
});

test('the re-exec is skipped for short-lived client verbs', () => {
    const m = /const HEAP_REEXEC_EXEMPT_SUBCOMMANDS = new Set\(\[([\s\S]*?)\]\);/.exec(cliSrc);
    assert.ok(m, 'cli.ts must declare HEAP_REEXEC_EXEMPT_SUBCOMMANDS');
    const listed = m[1];
    // `done` is the one every agent completion directive runs; the others are the
    // rest of the hot client path. Re-execing these doubles the process count of
    // the most frequent command on the box.
    for (const verb of ['done', 'next', 'probe', 'verb', 'status', 'reports']) {
        assert.ok(new RegExp(`'${verb}'`).test(listed),
            `client verb '${verb}' must be exempt from the heap re-exec`);
    }
    // Board launches must NOT be exempt, or the ceiling is silently absent again.
    for (const mode of ['local', 'tailnet']) {
        assert.ok(!new RegExp(`'${mode}'`).test(listed),
            `serve mode '${mode}' must NOT be exempt — it is the launch the ceiling exists for`);
    }
});

test('the detached child is handed the flag directly, not left to re-exec itself', () => {
    // Otherwise the wrapper parent lingers for the life of the board holding the
    // whole bundle — the cost this ceiling exists to avoid on a 1 GB box.
    // Anchor on SWITCHBOARD_DETACHED, not on `detached: true` — the browser-open
    // spawn is also detached and comes first in the file.
    const detachIdx = cliSrc.indexOf("SWITCHBOARD_DETACHED: '1'");
    assert.ok(detachIdx !== -1, 'the --detach spawn must exist');
    // The spawn call opens just above `detached: true`; walk back to it rather
    // than guessing a byte window, so an added comment cannot move it out of range.
    const spawnIdx = cliSrc.lastIndexOf('spawn(process.execPath', detachIdx);
    assert.ok(spawnIdx !== -1 && spawnIdx < detachIdx, 'the --detach spawn must call spawn(process.execPath, ...)');
    const spawnCall = cliSrc.slice(spawnIdx, detachIdx);
    assert.ok(spawnCall.includes('--max-old-space-size='),
        'the detached child spawn must carry --max-old-space-size in its argv');
});

if (failures > 0) {
    console.error(`\n❌ ${failures} test(s) failed.`);
    process.exit(1);
}
console.log('\n✅ All heap-ceiling contract tests passed.');
process.exit(0);
