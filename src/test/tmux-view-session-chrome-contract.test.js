'use strict';

/**
 * Contract test: a tmux VIEW session carries no status line, and the BASE
 * session keeps its own.
 *
 * Style mirrors `tmux-backend-contract.test.js` — a source-level assertion on
 * the composed seating command, which is a shell string built in
 * `goPtyFleetProjection.ts` and never executed in-process, so there is nothing
 * to mock and nothing that needs a live tmux server.
 *
 * Why this is a contract and not a preference:
 *   A view session is rendered inside a board pane that already has the
 *   panel's own seat navigation. tmux's status line there is duplicate
 *   navigation — it lists the same seats the sidebar does, overlaps it, and
 *   costs a row of every pane. The base session is the opposite case: it is
 *   what an operator attaches to over SSH, where the window list is the only
 *   way to see the team, so its strip must survive.
 *
 * The three assertions:
 *   1. `status off` is set, and targeted at the view session.
 *   2. It is never set with `-g` — that would rewrite the operator's own tmux.
 *   3. The base session's status is never touched.
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

test('the view session is created with its status line off', () => {
    assert.ok(
        /tmux set-option -t \$\{view\} status off/.test(src),
        'goPtyFleetProjection.ts must set `status off` on ${view} — without it every '
        + 'board pane renders a tmux strip duplicating the panel sidebar',
    );
});

test('status off is never applied globally', () => {
    const globalStatus = /tmux set-option[^`]*-g[^`]*status/.test(src);
    assert.ok(
        !globalStatus,
        'status must be set per-session; `-g` rewrites the operator\'s own tmux config',
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
console.log('\nResults: 3 passed, 0 failed.');
