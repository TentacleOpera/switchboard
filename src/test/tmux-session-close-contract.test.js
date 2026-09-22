'use strict';

/**
 * Contract test: closing a terminal closes its tmux session, and nothing
 * ever closes itself.
 *
 * The load-bearing invariant (plan §"The invariant that outranks every other
 * line"): NO code path may close a tmux session except an operator action in
 * the Terminals panel. Not a sweep, not a timer, not a startup reconciliation,
 * not a "no seat references this" check. This test pins that `kill-session`
 * is reachable only from (a) `fleet.close()` in the Go host (the per-seat
 * close path, triggered by the operator clicking close) and (b)
 * `killTmuxSession()` in tmuxBackend.ts (the `tmuxKillSession` verb, called by
 * the tmux tab close control and the team close fan-out — both operator
 * actions).
 *
 * The test scopes to EXECUTABLE call sites — `exec.Command("tmux",
 * "kill-session", ...)` in Go and `run(['kill-session', ...])` in
 * tmuxBackend.ts — NOT to the display string `tmux kill-session -t ${base}`
 * in `renderTmuxSessions` (terminals.js), which is a copy-only command shown
 * to the operator. A naive grep for `kill-session` false-positives on that
 * display string.
 *
 * Style mirrors `tmux-backend-contract.test.js` — mocked `run()` for the
 * verb behaviour, source-text assertions for the invariant and the UI.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('./bootstrap/tsResolveHook').installTsResolveHook();

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GO_HOST_FILE = path.join(REPO_ROOT, 'cmd', 'switchboard-pty-host', 'main.go');
const TMUX_BACKEND_FILE = path.join(REPO_ROOT, 'src', 'standalone', 'tmuxBackend.ts');
const TERMINALS_JS_FILE = path.join(REPO_ROOT, 'src', 'webview', 'terminals.js');
const GO_PROJECTION_FILE = path.join(REPO_ROOT, 'src', 'services', 'goPtyFleetProjection.ts');
const TASK_VIEWER_FILE = path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts');
const BOOTSTRAP_FILE = path.join(REPO_ROOT, 'src', 'standalone', 'bootstrap.ts');

let failures = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${err && err.message}`);
    }
}

function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

(async function main() {
    console.log('\n── tmux session close contract ──');

    const backend = await import(path.join('file://', TMUX_BACKEND_FILE));
    const {
        killTmuxSession,
        killTmuxSessionGroup,
        validateTmuxSessionName,
        _setTmuxRunImpl,
    } = backend;

    function mockRun(handler) {
        const calls = [];
        const impl = async (args, socket, input) => {
            const record = { args: [...args], socket, input };
            calls.push(record);
            return handler(args, socket, input);
        };
        _setTmuxRunImpl(impl);
        return calls;
    }

    function restoreRun() {
        _setTmuxRunImpl(null);
    }

    // ─── 1. fleet.close() issues kill-session for a tmux-backed terminal ───
    await test('fleet.close() issues kill-session for a tmux-backed terminal with tmuxViewSession', () => {
        const src = fs.readFileSync(GO_HOST_FILE, 'utf8');
        // The close function must issue exec.Command("tmux", "kill-session",
        // "-t", "="+t.tmuxViewSession) when killTmuxView && t.tmuxViewSession != "".
        assert.ok(
            /exec\.Command\(\s*"tmux"\s*,\s*"kill-session"\s*,\s*"-t"\s*,\s*"="\s*\+\s*t\.tmuxViewSession\s*\)/.test(src),
            'fleet.close() must issue exec.Command("tmux", "kill-session", "-t", "="+t.tmuxViewSession) for a tmux-backed terminal'
        );
        // Gated on killTmuxView AND a non-empty tmuxViewSession — NOT on
        // controlMode. controlMode says who DRAWS the pane; it says nothing
        // about whether tmux owns the session. Gating on it meant that turning
        // control mode off silently turned "closing a terminal closes its tmux
        // session" back off too, and sessions leaked on every close.
        // `tmuxViewSession != ""` is the honest test: it is set at create only
        // for a tmux-backed seat, and is empty for extension and raw ptys.
        assert.ok(
            /killTmuxView\s*&&\s*t\.tmuxViewSession\s*!=\s*""/.test(src),
            'fleet.close() must gate kill-session on killTmuxView && t.tmuxViewSession != ""'
        );
        assert.ok(
            !/killTmuxView\s*&&\s*t\.controlMode/.test(src),
            'the kill must NOT be gated on controlMode — that regression disabled close-on-close entirely'
        );
    });

    await test('a non-tmux terminal triggers no kill-session in fleet.close()', () => {
        const src = fs.readFileSync(GO_HOST_FILE, 'utf8');
        // Extract the close() function body and verify the kill-session is
        // inside the tmuxViewSession guard, not unconditional. A raw pty has
        // an empty tmuxViewSession, so the guard is what spares it.
        const closeMatch = src.match(/func \(f \*fleet\) close\(name string, killTmuxView bool\) bool \{([\s\S]*?)\n\}/);
        assert.ok(closeMatch, 'could not locate fleet.close() function');
        const closeBody = closeMatch[1];
        assert.ok(
            /killTmuxView\s*&&\s*t\.tmuxViewSession\s*!=\s*""/.test(closeBody),
            'the kill-session in close() must be gated on a non-empty tmuxViewSession — a raw terminal must not trigger it'
        );
    });

    await test('the terminal struct has a tmuxViewSession field set at create time', () => {
        const src = fs.readFileSync(GO_HOST_FILE, 'utf8');
        assert.ok(
            /tmuxViewSession\s+string/.test(src),
            'the terminal struct must have a tmuxViewSession string field'
        );
        // Set from the ptyCreateTerminal payload at create time.
        assert.ok(
            /tmuxViewSession:\s*strField\(payload,\s*"tmuxViewSession"\)/.test(src),
            'tmuxViewSession must be set from the ptyCreateTerminal payload at create time'
        );
    });

    // ─── 2. The standalone host passes tmuxViewSession in the create payload ──
    await test('goPtyFleetProjection passes tmuxViewSession in the ptyCreateTerminal payload', () => {
        const src = fs.readFileSync(GO_PROJECTION_FILE, 'utf8');
        assert.ok(
            /tmuxViewSession:\s*view/.test(src),
            'goPtyFleetProjection.ts must pass tmuxViewSession: view in the ptyCreateTerminal payload'
        );
    });

    // ─── 3. killTmuxSession validates the name and issues kill-session ──────
    await test('killTmuxSession issues kill-session with = exact-match for a name target', async () => {
        const calls = mockRun(async () => '');
        try {
            await killTmuxSession('lc-coding-team');
            const killCalls = calls.filter(c => c.args[0] === 'kill-session');
            assert.strictEqual(killCalls.length, 1, 'killTmuxSession must issue exactly one kill-session');
            assert.deepStrictEqual(killCalls[0].args, ['kill-session', '-t', '=lc-coding-team'],
                'a name target must use the = exact-match prefix');
        } finally {
            restoreRun();
        }
    });

    await test('killTmuxSession passes a $N session ID through without = prefix', async () => {
        const calls = mockRun(async () => '');
        try {
            await killTmuxSession('$5');
            const killCalls = calls.filter(c => c.args[0] === 'kill-session');
            assert.strictEqual(killCalls.length, 1, 'killTmuxSession must issue exactly one kill-session');
            assert.deepStrictEqual(killCalls[0].args, ['kill-session', '-t', '$5'],
                'a $N session ID must pass through without the = prefix');
        } finally {
            restoreRun();
        }
    });

    await test('killTmuxSession rejects an invalid session name', async () => {
        // An invalid name must be rejected by validateTmuxSessionName before
        // reaching tmux argv — a request body cannot inject flags or targets.
        await assert.rejects(
            () => killTmuxSession('lc-a; kill-server'),
            /invalid tmux session name/,
            'an invalid session name must be rejected before reaching tmux'
        );
        await assert.rejects(
            () => killTmuxSession('coding-team'),
            /invalid tmux session name/,
            'a name without the lc- prefix must be rejected'
        );
    });

    await test('killTmuxSession swallows "can\'t find session" (already gone)', async () => {
        mockRun(async () => { throw new Error("can't find session: lc-coding-team"); });
        try {
            const result = await killTmuxSession('lc-coding-team');
            assert.strictEqual(result, false, 'a missing session must resolve false, not throw');
        } finally {
            restoreRun();
        }
    });

    await test('killTmuxSession swallows "no such session" (already gone)', async () => {
        mockRun(async () => { throw new Error('no such session'); });
        try {
            const result = await killTmuxSession('$5');
            assert.strictEqual(result, false, 'a missing session must resolve false, not throw');
        } finally {
            restoreRun();
        }
    });

    await test('killTmuxSession rethrows a real tmux error', async () => {
        mockRun(async () => { throw new Error('tmux: out of file descriptors'); });
        try {
            await assert.rejects(
                () => killTmuxSession('lc-coding-team'),
                /out of file descriptors/,
                'a real tmux error must surface, not be swallowed'
            );
        } finally {
            restoreRun();
        }
    });

    // ─── 3b. killTmuxSessionGroup enumerates by session ID and kills each ──
    await test('killTmuxSessionGroup lists sessions, filters by group, and kills each by $N id', async () => {
        const calls = mockRun(async (args) => {
            if (args[0] === 'list-sessions') {
                // `#{session_group}\x1f#{session_id}` — the first field is the
                // GROUP name (e.g. lc-coding-team), not the session name. A
                // view session like lc-coding-team-coder-1 has group
                // lc-coding-team, not its own name.
                return [
                    'lc-coding-team\x1f$3',
                    'lc-coding-team\x1f$5',
                    'lc-coding-team\x1f$7',
                    'lc-other-team\x1f$9',
                ].join('\n');
            }
            return '';  // kill-session succeeds
        });
        try {
            const killed = await killTmuxSessionGroup('lc-coding-team');
            assert.strictEqual(killed, 3, 'must kill the 3 sessions in the lc-coding-team group');
            const killCalls = calls.filter(c => c.args[0] === 'kill-session');
            assert.strictEqual(killCalls.length, 3, 'must issue 3 kill-session calls');
            // Each kill must target a $N session ID, not a name.
            assert.deepStrictEqual(killCalls[0].args, ['kill-session', '-t', '$3']);
            assert.deepStrictEqual(killCalls[1].args, ['kill-session', '-t', '$5']);
            assert.deepStrictEqual(killCalls[2].args, ['kill-session', '-t', '$7']);
        } finally {
            restoreRun();
        }
    });

    await test('killTmuxSessionGroup tolerates already-gone sessions', async () => {
        mockRun(async (args) => {
            if (args[0] === 'list-sessions') {
                return 'lc-coding-team\x1f$3\nlc-coding-team\x1f$5';
            }
            throw new Error("can't find session: $5");
        });
        try {
            const killed = await killTmuxSessionGroup('lc-coding-team');
            // $3 succeeds, $5 is already gone — killed counts only successes.
            assert.ok(killed >= 0, 'must tolerate already-gone sessions without throwing');
        } finally {
            restoreRun();
        }
    });

    await test('killTmuxSessionGroup rethrows a real tmux error', async () => {
        mockRun(async (args) => {
            if (args[0] === 'list-sessions') {
                return 'lc-coding-team\x1f$3';
            }
            throw new Error('tmux: out of file descriptors');
        });
        try {
            await assert.rejects(
                () => killTmuxSessionGroup('lc-coding-team'),
                /out of file descriptors/,
                'a real tmux error must surface, not be swallowed'
            );
        } finally {
            restoreRun();
        }
    });

    await test('killTmuxSessionGroup rejects an invalid group name', async () => {
        await assert.rejects(
            () => killTmuxSessionGroup('lc-a; kill-server'),
            /invalid tmux session name/,
            'an invalid group name must be rejected before reaching tmux'
        );
    });

    // ─── 4. THE INVARIANT: no automatic close path exists ─────────────────
    await test('INVARIANT: kill-session in the Go host is reachable only from fleet.close()', () => {
        const src = fs.readFileSync(GO_HOST_FILE, 'utf8');
        const code = stripComments(src);
        // Every exec.Command("tmux", "kill-session", ...) call must be inside
        // fleet.close(). Count the executable kill-session call sites.
        const killSessionCalls = code.match(/exec\.Command\(\s*"tmux"\s*,\s*"kill-session"/g) || [];
        assert.ok(killSessionCalls.length >= 1, 'there must be at least one kill-session call in the Go host');
        // Verify the kill-session is inside the close() function body.
        const closeMatch = src.match(/func \(f \*fleet\) close\(name string, killTmuxView bool\) bool \{([\s\S]*?)\n\}/);
        assert.ok(closeMatch, 'could not locate fleet.close()');
        assert.ok(
            /exec\.Command\(\s*"tmux"\s*,\s*"kill-session"/.test(closeMatch[1]),
            'the kill-session must be inside fleet.close() — the per-seat operator close path'
        );
        // No timer, sweep, interval, or startup reconciliation may call it.
        // The close() function is the ONLY place kill-session appears.
        const outsideClose = code.replace(
            /func \(f \*fleet\) close\(name string, killTmuxView bool\) bool \{[\s\S]*?\n\}/,
            ''
        );
        assert.ok(
            !/exec\.Command\(\s*"tmux"\s*,\s*"kill-session"/.test(outsideClose),
            'kill-session must NOT appear outside fleet.close() — no automatic close path'
        );
    });

    await test('INVARIANT: dispose() passes killTmuxView=false (no auto kill on process exit)', () => {
        const src = fs.readFileSync(GO_HOST_FILE, 'utf8');
        // dispose() must call f.close(n, false) — the plan's invariant says
        // "process exit must not automatically kill tmux sessions."
        const disposeMatch = src.match(/func \(f \*fleet\) dispose\(\)\s*\{([\s\S]*?)\n\}/);
        assert.ok(disposeMatch, 'could not locate dispose()');
        assert.ok(
            /f\.close\(\s*n\s*,\s*false\s*\)/.test(disposeMatch[1]),
            'dispose() must pass killTmuxView=false so process exit does not kill tmux sessions'
        );
    });

    await test('INVARIANT: ptyCloseTerminal passes killTmuxView=true (explicit close kills)', () => {
        const src = fs.readFileSync(GO_HOST_FILE, 'utf8');
        // ptyCloseTerminal must call f.close(name, !teardown). An operator
        // close sends no `teardown`, so killTmuxView is true and the seat's
        // view session dies with it. The board's own shutdown (disposeAll in
        // bootstrap.ts stop(), which reaches this SAME verb through
        // handle.pty.kill()) sends `teardown: true`, so killTmuxView is false
        // and tmux is left alone. A bare `true` here made every board restart
        // destroy the whole fleet's tmux sessions, agents included — the
        // invariant is "a board restart closes nothing".
        const ptyCloseMatch = src.match(/case "ptyCloseTerminal":\s*([\s\S]*?)\n\s*case /);
        assert.ok(ptyCloseMatch, 'could not locate ptyCloseTerminal case');
        assert.ok(
            /teardown,\s*_\s*:?=\s*payload\["teardown"\]\.\(bool\)/.test(ptyCloseMatch[1]),
            'ptyCloseTerminal must read a `teardown` flag from the payload'
        );
        assert.ok(
            /f\.close\(\s*name\s*,\s*!teardown\s*\)/.test(ptyCloseMatch[1]),
            'ptyCloseTerminal must pass killTmuxView=!teardown — an operator close kills, a board shutdown does not'
        );
    });

    await test('INVARIANT: kill-session in tmuxBackend.ts is reachable only from killTmuxSession() and killTmuxSessionGroup()', () => {
        const src = fs.readFileSync(TMUX_BACKEND_FILE, 'utf8');
        const code = stripComments(src);
        // Every ['kill-session', ...] argv literal must be inside killTmuxSession()
        // or killTmuxSessionGroup(). The function builds the argv then calls
        // run(argv, socket) — the array literal is the executable call site.
        const killSessionCalls = code.match(/\[\s*['"]kill-session['"]/g) || [];
        assert.ok(killSessionCalls.length >= 1, 'there must be at least one kill-session argv literal in tmuxBackend.ts');
        // Verify the kill-session argv is inside the killTmuxSession function body.
        const killMatch = src.match(/export async function killTmuxSession\([\s\S]*?\n\}/);
        assert.ok(killMatch, 'could not locate killTmuxSession()');
        assert.ok(
            /\[\s*['"]kill-session['"]/.test(killMatch[0]),
            'the kill-session argv must be inside killTmuxSession() — the operator close path'
        );
        assert.ok(
            /run\(\s*argv/.test(killMatch[0]),
            'killTmuxSession must call run(argv, socket) to issue the kill-session'
        );
        // Verify the kill-session argv is also inside killTmuxSessionGroup().
        const killGroupMatch = src.match(/export async function killTmuxSessionGroup\([\s\S]*?\n\}/);
        assert.ok(killGroupMatch, 'could not locate killTmuxSessionGroup()');
        assert.ok(
            /\[\s*['"]kill-session['"]/.test(killGroupMatch[0]),
            'the kill-session argv must be inside killTmuxSessionGroup() — the team close path'
        );
        // No timer, sweep, interval, or startup reconciliation may call it.
        // Remove BOTH function bodies and verify no kill-session remains.
        const outsideKill = code
            .replace(/export async function killTmuxSession\([\s\S]*?\n\}/, '')
            .replace(/export async function killTmuxSessionGroup\([\s\S]*?\n\}/, '');
        assert.ok(
            !/\[\s*['"]kill-session['"]/.test(outsideKill),
            'kill-session must NOT appear outside killTmuxSession() and killTmuxSessionGroup() — no automatic close path in tmuxBackend.ts'
        );
    });

    // The invariant above scopes to tmuxBackend.ts — it pins where kill-session
    // is ISSUED, but says nothing about who CALLS killTmuxSession(). That is the
    // half that matters: an automatic reaper does not need to issue kill-session
    // itself, it just calls the operator's function. The plan's own words —
    // "this is the gate that stops an automatic reaper being added later by
    // someone who thinks it is an improvement" — were not met by a check that a
    // startup sweep passes unchanged. This test closes that hole by pinning the
    // caller set.
    await test('INVARIANT: killTmuxSession() callers are the operator verbs plus the ONE declared boot reaper', () => {
        const roots = {
            'bootstrap.ts': fs.readFileSync(BOOTSTRAP_FILE, 'utf8'),
            'TaskViewerProvider.ts': fs.readFileSync(TASK_VIEWER_FILE, 'utf8'),
        };
        for (const [label, raw] of Object.entries(roots)) {
            const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
            const calls = (code.match(/\bkillTmuxSession(?!Group)\s*\(/g) || []).length;
            // The extension root has exactly one caller (the tmuxKillSession
            // verb). The standalone root has two: that same verb, plus the boot
            // reaper — which is the SOLE sanctioned automatic caller and is
            // named here deliberately, so adding a second one fails this gate.
            const expected = label === 'bootstrap.ts' ? 2 : 1;
            assert.strictEqual(calls, expected,
                `${label}: expected exactly ${expected} killTmuxSession() call site(s) — a new automatic caller `
                + '(timer, sweep, idle check, age threshold) is forbidden by the plan invariant');
        }
        // The one automatic caller must refuse to kill an ATTACHED session.
        // The sibling plan's post-mortem is explicit: the hand-run sweep that
        // destroyed an operator's live session read `#{session_attached} == 1`
        // and went past it. The registry is a fallible ownership signal (a
        // pty-host crash empties it), so a connected client must veto the kill.
        const bootstrap = roots['bootstrap.ts'];
        const reaperIdx = bootstrap.indexOf('tmux-reaper');
        assert.ok(reaperIdx >= 0, 'bootstrap must contain a tmux-reaper block');
        const reaperBlock = bootstrap.slice(reaperIdx - 4000, reaperIdx + 2500);
        assert.ok(/attachedGroups/.test(reaperBlock) && /s\.attached/.test(reaperBlock),
            'the boot reaper must exclude sessions with an attached client — registry absence alone must never authorise a kill');
    });

    // ─── 5. Source-text: renderTmuxSessions renders attached + close button ─
    await test('renderTmuxSessions renders an attached indicator from team.attached', () => {
        const src = fs.readFileSync(TERMINALS_JS_FILE, 'utf8');
        assert.ok(
            /team\.attached/.test(src),
            'renderTmuxSessions must read team.attached to show the attached indicator'
        );
        assert.ok(
            /tmux-attached-badge/.test(src),
            'renderTmuxSessions must render an attached badge element'
        );
    });

    await test('renderTmuxSessions close button calls the tmuxKillSession verb (not copy-only)', () => {
        const src = fs.readFileSync(TERMINALS_JS_FILE, 'utf8');
        // The executable close control must POST to /terminals/verb/tmuxKillSession.
        assert.ok(
            /\/terminals\/verb\/tmuxKillSession/.test(src),
            'the close button must call the tmuxKillSession verb, not be copy-only'
        );
        // The close button must have a data-close-session attribute (the executable
        // control), distinct from the copy-only data-copy kill command.
        assert.ok(
            /data-close-session=/.test(src),
            'the close button must carry a data-close-session attribute'
        );
    });

    // ─── 6. Source-text: PANE_FORMAT + TmuxPane + TmuxTeamSession ───────────
    await test('PANE_FORMAT includes #{session_attached}', () => {
        const src = fs.readFileSync(TMUX_BACKEND_FILE, 'utf8');
        assert.ok(
            /#\{session_attached\}/.test(src),
            'PANE_FORMAT must include #{session_attached} as a field'
        );
    });

    await test('TmuxPane has sessionAttached and TmuxTeamSession has attached', () => {
        const src = fs.readFileSync(TMUX_BACKEND_FILE, 'utf8');
        assert.ok(
            /sessionAttached:\s*string/.test(src),
            'TmuxPane must have a sessionAttached: string field'
        );
        assert.ok(
            /attached:\s*boolean/.test(src),
            'TmuxTeamSession must have an attached: boolean field'
        );
    });

    await test('listTmuxPanes reads fields[10] and guards on length < 11', () => {
        const src = fs.readFileSync(TMUX_BACKEND_FILE, 'utf8');
        assert.ok(
            /fields\.length\s*<\s*11/.test(src),
            'listTmuxPanes must guard on fields.length < 11 (the new field count)'
        );
        assert.ok(
            /sessionAttached:\s*fields\[10\]/.test(src),
            'listTmuxPanes must read fields[10] into sessionAttached'
        );
    });

    // ─── 7. Source-text: closeTeam stops the team, then kills its tmux group ─
    await test('closeTeam() calls tmuxKillSessionGroup for the group after the seats are closed', () => {
        const src = fs.readFileSync(TERMINALS_JS_FILE, 'utf8');
        // Locate the closeTeam function body.
        const closeTeamMatch = src.match(/async function closeTeam\(\)\s*\{([\s\S]*?)\n    \}/);
        assert.ok(closeTeamMatch, 'could not locate closeTeam()');
        const body = closeTeamMatch[1];
        // The seats are closed by the BOARD now — one `POST /kanban/team/stop`
        // that pauses the missions, releases the held cards and closes the
        // seats. The client no longer fans out over ptyCloseTerminal itself.
        const stopIdx = body.indexOf('/kanban/team/stop');
        const killIdx = body.indexOf('tmuxKillSessionGroup');
        assert.ok(stopIdx >= 0, 'closeTeam must stop the team through the one board route');
        assert.ok(!body.includes('ptyCloseTerminal'),
            'the client-side fan-out must be gone — the board owns closing the seats');
        assert.ok(killIdx >= 0, 'closeTeam must call tmuxKillSessionGroup for the team group');
        assert.ok(
            killIdx > stopIdx,
            'tmuxKillSessionGroup must come AFTER the seats are closed, not before it'
        );
    });

    // ─── 8. Both composition roots wire the tmuxKillSession + tmuxKillSessionGroup verbs ─
    await test('the extension host wires the tmuxKillSession and tmuxKillSessionGroup verbs', () => {
        const src = fs.readFileSync(TASK_VIEWER_FILE, 'utf8');
        assert.ok(
            /verb === 'tmuxKillSession'/.test(src),
            'TaskViewerProvider._handleTmuxVerb must handle the tmuxKillSession verb'
        );
        assert.ok(
            /verb === 'tmuxKillSessionGroup'/.test(src),
            'TaskViewerProvider._handleTmuxVerb must handle the tmuxKillSessionGroup verb'
        );
        assert.ok(
            /killTmuxSession[^G]/.test(src),
            'TaskViewerProvider must call killTmuxSession() for the tmuxKillSession verb'
        );
        assert.ok(
            /killTmuxSessionGroup/.test(src),
            'TaskViewerProvider must call killTmuxSessionGroup() for the tmuxKillSessionGroup verb'
        );
    });

    await test('the standalone host wires the tmuxKillSession and tmuxKillSessionGroup verbs', () => {
        const src = fs.readFileSync(BOOTSTRAP_FILE, 'utf8');
        assert.ok(
            /case 'tmuxKillSession'/.test(src),
            'bootstrap.ts must handle the tmuxKillSession verb case'
        );
        assert.ok(
            /case 'tmuxKillSessionGroup'/.test(src),
            'bootstrap.ts must handle the tmuxKillSessionGroup verb case'
        );
        assert.ok(
            /killTmuxSession[^G]/.test(src),
            'bootstrap.ts must call killTmuxSession() for the tmuxKillSession verb'
        );
        assert.ok(
            /killTmuxSessionGroup/.test(src),
            'bootstrap.ts must call killTmuxSessionGroup() for the tmuxKillSessionGroup verb'
        );
    });

    await test('both roots include attached in the tmuxListSessions response', () => {
        const tvSrc = fs.readFileSync(TASK_VIEWER_FILE, 'utf8');
        const bsSrc = fs.readFileSync(BOOTSTRAP_FILE, 'utf8');
        assert.ok(
            /attached:\s*t\.attached/.test(tvSrc),
            'TaskViewerProvider must include attached in the tmuxListSessions response'
        );
        assert.ok(
            /attached:\s*t\.attached/.test(bsSrc),
            'bootstrap.ts must include attached in the tmuxListSessions response'
        );
    });

    // ─── 9. Sidebar shows seatless sessions ───────────────────────────────
    await test('renderSidebarList renders seatless tmux sessions with a close control', () => {
        const src = fs.readFileSync(TERMINALS_JS_FILE, 'utf8');
        assert.ok(
            /seatless/.test(src),
            'renderSidebarList must render seatless sessions'
        );
        assert.ok(
            /sidebar-seatless/.test(src),
            'seatless session rows must use the sidebar-seatless CSS classes'
        );
        // The seatless close button must call the tmuxKillSession verb.
        const seatlessSection = src.match(/Seatless tmux sessions[\s\S]*?listEl\.appendChild\(section\)/);
        assert.ok(seatlessSection, 'could not locate the seatless sessions section');
        assert.ok(
            /\/terminals\/verb\/tmuxKillSession/.test(seatlessSection[0]),
            'the seatless close button must call the tmuxKillSession verb'
        );
    });

    if (failures > 0) {
        console.error(`\n${failures} check(s) failed.\n`);
        process.exit(1);
    }
    console.log('\nAll tmux session close contract checks passed.\n');
})();
