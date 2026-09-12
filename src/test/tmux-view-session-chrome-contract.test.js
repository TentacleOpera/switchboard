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
let passes = 0;
function test(name, fn) {
    try {
        fn();
        passes++;
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${err && err.message}`);
    }
}

console.log('\n── tmux view session chrome contract ──');

const src = fs.readFileSync(PROJECTION_FILE, 'utf8');

test('tmux seating and control mode are separate decisions', () => {
    // These were one variable. Turning control mode off by setting it false also
    // turned tmux OFF — the same flag gated the whole chain — so no seat got a
    // tmux session, and with it went SSH attach and surviving a board restart,
    // which are the only reasons tmux is here. Control mode was only ever about
    // who DRAWS the pane.
    assert.ok(
        /const usesTmuxSeating = .*_tmuxSeatingEnabled\(\)/.test(src),
        'tmux seating must be decided by _tmuxSeatingEnabled(), not by the control-mode flag'
    );
    assert.ok(
        /if \(usesTmuxSeating\) \{/.test(src),
        'the tmux chain must be gated on usesTmuxSeating, never on usesControlMode'
    );
    assert.ok(
        !/if \(usesControlMode\) \{/.test(src),
        'usesControlMode must not gate the chain — it only tells the Go host how to read the stream'
    );
});

test('the view attaches WITHOUT control mode, UTF-8 forced', () => {
    // Control mode is OFF. `-CC` puts a protocol parser between the agent and the
    // screen, and twelve distinct defects came out of that parser in one day —
    // every one reporting success while delivering nothing (dropped
    // %extended-output, a double-pushed block FIFO, `send-keys -lt -t` exiting 0
    // and delivering nothing, `capture-pane -t %` before the pane id was known,
    // the seating chain echoed into the pane, and more). A plain attach has no
    // interpretation in the path, so a bug there cannot put protocol text on the
    // operator's screen or silently eat their keystrokes.
    //
    // `-u` stays: it forces UTF-8 so non-ASCII is not replaced with `_`.
    //
    // This assertion is the gate against control mode being switched back on
    // without a plan carrying a LIVE-SEAT acceptance test — which is precisely
    // what was missing the first time.
    assert.ok(
        /exec tmux -u attach -t \$\{view\}/.test(src),
        'the chain must end with `exec tmux -u attach -t ${view}` — plain attach, not -CC'
    );
    // Strip `//` comments before this check: the source explains WHY control mode
    // is off, and that prose names `-CC`. Asserting over raw text makes the
    // explanation trip its own guard.
    const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(
        !/-CC attach/.test(code),
        'control mode (-CC) must not be reintroduced without a live-seat acceptance gate'
    );
    assert.ok(
        /const usesControlMode = false/.test(src),
        'the controlMode flag handed to the Go host must be false'
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

test('a restart reuses the seat window instead of stacking a duplicate', () => {
    // `has-session` only answers "does the TEAM session exist?". On a restart it
    // is true, so a bare `new-window` added a SECOND window with the same name —
    // tmux permits duplicate window names, so every team start added four more.
    // Observed before the fix: 15 windows for 4 seats, three generations deep.
    // The `-A` on the view line deduped the view SESSION, which is why the
    // session count looked stable while windows multiplied unwatched. Nothing in
    // this suite covered the window half of the chain, which is how it shipped.
    assert.ok(
        /list-windows -t \$\{session\} -F '#\{window_name\}'[^|]*\| grep -Fxq -- "\$\{win\}"/.test(src),
        'the chain must check for an existing window by name before creating one'
    );
    assert.ok(
        !/&& tmux new-window -d -t \$\{session\}/.test(src),
        'new-window must be guarded by the existing-window check, not run unconditionally on has-session'
    );
    // -F (fixed string) and -x (exact line) together: without -x, `Coding` would
    // match `Coding-coder-1` and the head would never get its own window.
    assert.ok(
        /grep -Fxq/.test(src),
        'the window-name check must be a fixed-string whole-line match (grep -Fxq)'
    );
});

test('the chain captures the window id at creation and targets by id', () => {
    // A window NAME is not unique across generations — `select-window -t
    // ${view}:${win}` resolved to the lowest-index window carrying the name,
    // i.e. a previous generation's duplicate, so every prompt was forwarded to
    // the old agent. The id is captured at creation with `-P -F '#{window_id}'`
    // and used for `select-window` and `set-window-option` thereafter. See
    // a-tmux-seat-gets-a-blind-two-second-clear-and-loses-the-first-dispatch.md
    // (Change 2).
    assert.ok(
        /new-session -d -P -F '#\{window_id\}'/.test(src),
        'new-session must capture the window id at creation (-P -F \'#{window_id}\')'
    );
    assert.ok(
        /new-window -d -P -F '#\{window_id\}'/.test(src),
        'new-window must capture the window id at creation (-P -F \'#{window_id}\')'
    );
    assert.ok(
        // `$wid` is a SHELL variable holding the id captured by `-P -F '#{window_id}'`,
        // NOT a JS interpolation — `${wid}` would interpolate a JS binding that does
        // not exist. f093f446 fixed the code; this assertion was left pinning the
        // broken form and had been red since.
        /tmux select-window -t \$\{view\}:\$wid/.test(src),
        'select-window must target the view and the captured window id (${view}:${wid}), not the name'
    );
    assert.ok(
        !/tmux select-window -t \$\{view\}:\$\{win\}/.test(src),
        'select-window must not target the window by name (${view}:${win}) — a name is not unique across generations'
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
    // The window is targeted by its stable id ($wid), not by name. A name is
    // not unique across generations — `select-window -t ${view}:${win}` picked
    // the lowest-index window carrying the name, i.e. a previous generation's
    // duplicate. The id is captured at creation (`new-window -P -F '#{window_id}'`)
    // and used for every later target. See
    // a-tmux-seat-gets-a-blind-two-second-clear-and-loses-the-first-dispatch.md
    // (Change 2).
    assert.ok(
        /tmux set-window-option -t \$wid automatic-rename off/.test(src),
        'goPtyFleetProjection.ts must set `automatic-rename off` on the seat window by id ($wid) — '
        + 'without it `%window-renamed` fires on every command the agent runs and thrashes '
        + 'any board re-render on rename',
    );
    assert.ok(
        !/tmux set-window-option -t \$\{view\}:\$\{win\} automatic-rename off/.test(src),
        'automatic-rename must target the window id ($wid), not the name (${view}:${win}) — '
        + 'a name is not unique across generations and resolves to the wrong window',
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
// Counted, not hardcoded. This line read `Results: 8 passed, 0 failed.` as a
// literal — it printed "8 passed" whatever happened, so adding a test showed 9
// ticks above an unchanged summary, and a reviewer could quote the summary as
// evidence. The exit code was always honest; only this line was not.
console.log(`\nResults: ${passes} passed, ${failures} failed.`);
