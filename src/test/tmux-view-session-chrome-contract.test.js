'use strict';

/**
 * Contract test: a tmux VIEW session runs in control mode (`tmux -u -CC
 * attach`), so the per-view chrome suppressions the chain used to carry are
 * gone and the geometry options control mode needs are present.
 *
 * Style mirrors `tmux-backend-contract.test.js` — a source-level assertion on
 * the composed seating command, which is a shell string built in
 * `goPtyFleetProjection.ts` and never executed in-process, so there is nothing
 * to mock and nothing that needs a live tmux server.
 *
 * Why this is a contract and not a preference:
 *   Control mode makes tmux stop drawing the pane and emit line-oriented
 *   notifications instead; the board renders the agent as a plain terminal.
 *   That removes the need for the three per-view suppressions the chain used to
 *   carry — `status off` (tmux draws no status line), `prefix None` (tmux
 *   interprets no prefix key) and `aggressive-resize on` (tmux no longer
 *   arbitrates window size between competing clients). If any of them creeps
 *   back, they are dead options under control mode at best and a sign the
 *   cutover was reverted at worst. `window-size manual` and
 *   `automatic-rename off` are the options control mode DOES need: manual
 *   sizing gives the browser panel deterministic authority over geometry
 *   (under the default `latest` a second attached client ping-pongs the size),
 *   and `automatic-rename off` stops `%window-renamed` thrashing on every
 *   command. The base session an operator attaches to over SSH keeps its own
 *   options — these are per-view, never `-g`.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTION_FILE = path.join(REPO_ROOT, 'src', 'services', 'goPtyFleetProjection.ts');

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

console.log('\n── tmux view session chrome contract ──');

const src = fs.readFileSync(PROJECTION_FILE, 'utf8');

test('the view attaches in control mode with UTF-8 forced', () => {
    assert.ok(
        /exec tmux -u -CC attach -t \$\{view\}/.test(src),
        'goPtyFleetProjection.ts must end the seat chain with `exec tmux -u -CC attach -t ${view}` '
        + '— a bare `tmux attach` makes the board pane a tmux client again (the state this '
        + 'feature reverts), and `-u` prevents utf8_sanitize replacing non-ASCII with `_`',
    );
});

test('the chain no longer suppresses the view status line', () => {
    assert.ok(
        !/tmux set-option -t \$\{view\} status off/.test(src),
        'control mode draws no status line, so `status off` is dead weight — its presence '
        + 'signals the cutover was reverted',
    );
});

test('the chain no longer neutralises the view prefix key', () => {
    assert.ok(
        !/tmux set-option -t \$\{view\} prefix None/.test(src),
        'control mode interprets no prefix key, so `prefix None` is dead weight — its '
        + 'presence signals the cutover was reverted',
    );
});

test('the chain no longer sets aggressive-resize on the view window', () => {
    assert.ok(
        !/tmux set-window-option -t \$\{view\}:\$\{win\} aggressive-resize on/.test(src),
        'control mode no longer arbitrates window size between clients, so '
        + '`aggressive-resize on` is dead weight (and inert under window-size manual) — '
        + 'its presence signals the cutover was reverted',
    );
});

test('the view session uses manual window sizing', () => {
    assert.ok(
        /tmux set-option -t \$\{view\} window-size manual/.test(src),
        'goPtyFleetProjection.ts must set `window-size manual` on ${view} — under the '
        + 'default `latest` a second attached client (SSH) ping-pongs the window size, '
        + 'which is the arbitration failure aggressive-resize used to paper over',
    );
});

test('the view window disables automatic rename', () => {
    assert.ok(
        /tmux set-window-option -t \$\{view\}:\$\{win\} automatic-rename off/.test(src),
        'goPtyFleetProjection.ts must set `automatic-rename off` on the view window — '
        + 'without it `%window-renamed` fires on every command the agent runs and thrashes '
        + 'any board re-render on rename',
    );
});

test('view options are never applied globally', () => {
    const globalViewOption = /tmux set(?:-option|-window-option)[^`]*-g[^`]*(?:window-size|automatic-rename|status|prefix)/.test(src);
    assert.ok(
        !globalViewOption,
        'view options must be set per-session/per-window; `-g` rewrites the operator\'s '
        + 'own tmux config',
    );
});

test('the base session keeps its status line', () => {
    // `${session}` is the base an operator attaches to over SSH. Nothing may
    // turn its strip off — that is the only window list a human gets.
    const baseStatus = /tmux set-option -t \$\{session\} status/.test(src);
    assert.ok(
        !baseStatus,
        'the base session\'s status line must be left alone — it is the operator\'s '
        + 'only view of the team over SSH',
    );
});

if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log('\nResults: 8 passed, 0 failed.');
