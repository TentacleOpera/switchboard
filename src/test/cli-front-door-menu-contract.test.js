'use strict';

/**
 * Contract: CLI front-door menu split into GUI and CLI branches.
 *
 * Asserts that:
 *  - cmdMainMenu renders a fixed top-level menu (same shape online/offline).
 *  - [1] GUI sub-menu is state-aware (online: show URL; offline: start local/tailnet).
 *  - [2] CLI Mode re-spawns __board-console as a child.
 *  - [s] Setup and [a] About re-spawn their subcommands.
 *  - __board-console is a known subcommand and routed to cmdBoardConsole.
 *  - cmdBoardConsole no longer has [5] Setup.
 *  - banner(version) is reused (no "Autonomous Agent Fleet Console" string).
 *
 * Run with:
 *   node src/test/cli-front-door-menu-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err && err.message ? err.message : err}`);
    }
}

function run() {
    console.log('\ncli-front-door-menu-contract\n');

    const cliSrc = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'cli.ts'), 'utf8');

    // ── 1. Fixed top-level menu (same shape online/offline) ──────────────

    check('cmdMainMenu renders MAIN MENU with [1] GUI Mode, [2] CLI Mode, [s] Setup, [a] About', () => {
        assert.ok(/MAIN MENU:/.test(cliSrc), 'must render MAIN MENU');
        assert.ok(/\[1\] GUI Mode/.test(cliSrc), 'must have [1] GUI Mode');
        assert.ok(/\[2\] CLI Mode/.test(cliSrc), 'must have [2] CLI Mode');
        assert.ok(/\[s\] Setup/.test(cliSrc), 'must have [s] Setup');
        assert.ok(/\[a\] About/.test(cliSrc), 'must have [a] About');
    });

    check('top-level menu does NOT branch on online/offline for shape', () => {
        // The old code had `if (online) { ... } else { ... }` for the menu render.
        // The new code has a single fixed menu render.
        assert.ok(!/if \(online\) \{[\s\S]*?OPTIONS:/.test(cliSrc), 'must not have online-branch OPTIONS render');
    });

    // ── 2. [1] GUI sub-menu is state-aware ───────────────────────────────

    check('GUI sub-menu shows server URL when online', () => {
        assert.ok(/Server already running at/.test(cliSrc), 'must show server URL when online');
    });

    check('GUI sub-menu does NOT offer Start Local when online', () => {
        // Find the online GUI branch and check it doesn't offer Start Local.
        const guiOnlineMatch = cliSrc.match(/if \(online\) \{[\s\S]*?GUI MODE/);
        // The online branch should not contain "Start Local Board"
        const onlineSection = cliSrc.substring(
            cliSrc.indexOf('if (online) {'),
            cliSrc.indexOf('if (online) {') + 800
        );
        assert.ok(!/Start Local Board/.test(onlineSection), 'online GUI must not offer Start Local');
    });

    check('GUI sub-menu offers Start Local / Start Remote when offline', () => {
        assert.ok(/Start Local Board \(127\.0\.0\.1 loopback/.test(cliSrc), 'must offer Start Local when offline');
        assert.ok(/Start Remote Server Board \(Tailscale mesh/.test(cliSrc), 'must offer Start Remote when offline');
    });

    // ── 3. [2] CLI Mode re-spawns __board-console ────────────────────────

    check('CLI Mode re-spawns __board-console as a child', () => {
        assert.ok(/__board-console/.test(cliSrc), 'must reference __board-console');
        assert.ok(/spawn\(process\.execPath, \[__filename, '__board-console'\]/.test(cliSrc),
            'must spawn __board-console child');
    });

    check('CLI Mode loops back to main menu after child exits (Back)', () => {
        // The [2] branch should have `continue` after the child exit, not exitFlushed.
        const cliModeSection = cliSrc.substring(
            cliSrc.indexOf("// ── [2] CLI Mode"),
            cliSrc.indexOf("// ── [s] Setup")
        );
        assert.ok(/continue/.test(cliModeSection), 'must continue (loop) after child exit');
        assert.ok(!/exitFlushed\(code\)/.test(cliModeSection), 'must NOT exitFlushed on CLI Mode child exit');
    });

    // ── 4. __board-console routing ───────────────────────────────────────

    check('__board-console is in KNOWN_SUBCOMMANDS', () => {
        assert.ok(/'__board-console'/.test(cliSrc), 'must be in KNOWN_SUBCOMMANDS');
    });

    check('__board-console is routed to cmdBoardConsole before bare-switchboard check', () => {
        const routingIdx = cliSrc.indexOf("firstArg === '__board-console'");
        const bareIdx = cliSrc.indexOf('Bare `switchboard`: interactive front-door menu');
        assert.ok(routingIdx > 0, 'must have __board-console routing');
        assert.ok(bareIdx > 0, 'must have bare switchboard routing');
        assert.ok(routingIdx < bareIdx, '__board-console routing must come before bare-switchboard check');
    });

    // ── 5. cmdBoardConsole no longer has [5] Setup ───────────────────────

    check('cmdBoardConsole does NOT render [5] Setup', () => {
        // Find the cmdBoardConsole function body and check it doesn't have [5] Setup.
        const boardConsoleIdx = cliSrc.indexOf('async function cmdBoardConsole');
        const boardConsoleBody = cliSrc.substring(boardConsoleIdx, boardConsoleIdx + 3000);
        assert.ok(!/\[5\] Setup/.test(boardConsoleBody), 'must not have [5] Setup in cmdBoardConsole');
    });

    check('cmdBoardConsole prompt says [1-4] not [1-5]', () => {
        const boardConsoleIdx = cliSrc.indexOf('async function cmdBoardConsole');
        const boardConsoleBody = cliSrc.substring(boardConsoleIdx, boardConsoleIdx + 5000);
        assert.ok(/\[1-4\]/.test(boardConsoleBody), 'prompt must say [1-4]');
        assert.ok(!/\[1-5\]/.test(boardConsoleBody), 'prompt must NOT say [1-5]');
    });

    // ── 6. banner(version) is reused (no second banner string) ───────────

    check('no "Autonomous Agent Fleet Console" string literal', () => {
        assert.ok(!/Autonomous Agent Fleet Console/.test(cliSrc),
            'must not introduce a second banner string');
    });

    check('banner(version) is called in cmdMainMenu', () => {
        const mainMenuIdx = cliSrc.indexOf('async function cmdMainMenu');
        const mainMenuBody = cliSrc.substring(mainMenuIdx, mainMenuIdx + 5000);
        assert.ok(/banner\(version\)/.test(mainMenuBody), 'must call banner(version)');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run();
