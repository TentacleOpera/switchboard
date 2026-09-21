'use strict';

/**
 * Contract: `switchboard done`. No arguments.
 *
 * A finished seat signals that it is finished; it assembles nothing and states
 * no fact the host already holds. The host injects the seat's identity into the
 * seat's OWN environment when it creates the pty — `SWITCHBOARD_TERMINAL`, set
 * by the Go pty host (cmd/switchboard-pty-host/main.go) and by the Node fleet
 * (src/standalone/ptyFleetService.ts), so the variable is present under BOTH
 * composition roots. The CLI never read it, so every completion instruction
 * made the agent type the name back.
 *
 * Measured cost, 2026-09-13 (`Coding-intern`): the seat finished its work
 * correctly, then spent its remaining turns working out what to send — reading
 * LocalApiServer.ts, grepping ./src/standalone, assembling a 3389-byte body
 * into a temp file, and asking the operator which call was correct. None of it
 * was about the work. It was about the shape of the report.
 *
 * Every field an agent must supply is a field it can get wrong and a decision
 * it has to stop and make. This is the no-summaries rule applied to the fields
 * instead of the prose.
 *
 * The runtime checks below stop short of a live board deliberately: they run
 * the real built CLI in a scratch cwd with no port file, so resolution order is
 * observable (the identity check runs BEFORE findRunningInstance) without a
 * board, a seat or a TTY. "No running Switchboard instance" is the PASS signal
 * for the resolved cases — it means `from` resolved and the CLI got past the
 * identity gate.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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

const CLI = path.join(process.cwd(), 'out', 'standalone', 'cli.js');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-completion-'));

/** Run the built CLI in a scratch cwd that holds no .switchboard port file. */
function runCli(args, env) {
    const childEnv = { ...process.env };
    delete childEnv.SWITCHBOARD_TERMINAL;
    Object.assign(childEnv, env || {});
    const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: SCRATCH,
        env: childEnv,
        encoding: 'utf8',
        timeout: 30000,
    });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

console.log('\n── a seat reports done and nothing else ──\n');

check('the built CLI exists (guards the runtime checks below against a stale build)', () => {
    assert.ok(fs.existsSync(CLI), `${CLI} missing — run npm run compile-tests`);
});

// ── 1. Bare `done` resolves the seat from the host-injected env ──────────

check('`done` with no arguments and SWITCHBOARD_TERMINAL set resolves the seat', () => {
    const { code, out } = runCli(['done', '--json'], { SWITCHBOARD_TERMINAL: 'Coding-intern' });
    const body = JSON.parse(out);
    // It got PAST the identity gate: the only thing left is that this scratch
    // cwd has no board behind it.
    assert.ok(!/SWITCHBOARD_TERMINAL is not set/.test(body.error || ''),
        'bare `done` inside a seat must not ask for --from');
    assert.match(String(body.error || ''), /No running Switchboard instance/,
        'the only remaining failure is the absent board, not a missing field');
    assert.strictEqual(code, 1, 'the absent-board exit code, not the missing-argument one');
});

// ── 2. Absent identity fails LOUDLY and names the variable ───────────────

check('SWITCHBOARD_TERMINAL unset completes nothing and names the variable', () => {
    const { code, out } = runCli(['done', '--json'], {});
    const body = JSON.parse(out);
    assert.strictEqual(body.success, false);
    assert.match(String(body.error || ''), /SWITCHBOARD_TERMINAL/,
        'the error must NAME the variable — that text is the only thing that '
        + 'distinguishes "you are not in a seat" from "you typed the command wrong"');
    assert.match(String(body.error || ''), /--from/, 'and it must name the manual override');
    assert.notStrictEqual(code, 0, 'a completion that resolved no seat must never exit zero');
});

check('SWITCHBOARD_TERMINAL unset fails BEFORE reaching the board', () => {
    // Ordering matters: if the identity gate ran after findRunningInstance, the
    // absent-board message would mask the real cause, and an agent would go
    // looking for a dead server instead of a missing variable.
    const { out } = runCli(['done', '--json'], {});
    assert.ok(!/No running Switchboard instance/.test(out),
        'the identity check must run before the instance lookup');
});

check('an empty SWITCHBOARD_TERMINAL is treated as absent, never as a seat named ""', () => {
    const { out } = runCli(['done', '--json'], { SWITCHBOARD_TERMINAL: '   ' });
    const body = JSON.parse(out);
    assert.match(String(body.error || ''), /SWITCHBOARD_TERMINAL/,
        'whitespace is not an identity — a completion attributed to the wrong '
        + 'seat clears the wrong terminal');
});

// ── 3. `--from` still works and still wins ───────────────────────────────

check('an explicit --from still works with no env var (the human-CLI path)', () => {
    const { code, out } = runCli(['done', '--from', 'Coder 1', '--json'], {});
    const body = JSON.parse(out);
    assert.match(String(body.error || ''), /No running Switchboard instance/);
    assert.strictEqual(code, 1);
});

check('an explicit --from OVERRIDES the env default', () => {
    const { out } = runCli(['done', '--from', 'Coder 1', '--json'],
        { SWITCHBOARD_TERMINAL: 'Coding-intern' });
    const body = JSON.parse(out);
    assert.strictEqual(body.from, 'Coder 1', 'the flag wins over the env');
    assert.strictEqual(body.fromSource, 'flag');
});

check('the resolved identity is TAGGED with the source that answered', () => {
    // CLAUDE.md: on a read of identity, either tag it or fail loudly. `from`
    // now has two possible sources, and "which one answered?" must be
    // answerable after the fact — not inferred from the value.
    const { out } = runCli(['done', '--json'], { SWITCHBOARD_TERMINAL: 'Coding-intern' });
    const body = JSON.parse(out);
    assert.strictEqual(body.from, 'Coding-intern');
    assert.strictEqual(body.fromSource, 'env');
});

// ── 3b. `done` is a loud alias — performs the submit and prints the rename ──

check('`done` performs the submit AND prints the rename notice on stderr', () => {
    const { code, out, err } = runCli(['done', '--json'], { SWITCHBOARD_TERMINAL: 'Coding-intern' });
    assert.match(err, /'done' is now 'submit'/,
        'the alias must say the rename out loud — never a silent success');
    const body = JSON.parse(out); // stdout stays clean JSON
    assert.ok(!/SWITCHBOARD_TERMINAL is not set/.test(body.error || ''),
        'the alias must reach the same resolution path as submit');
    assert.strictEqual(code, 1, 'same absent-board exit code as submit');
});

check('`submit` performs identically without the notice', () => {
    const { code, out, err } = runCli(['submit', '--json'], { SWITCHBOARD_TERMINAL: 'Coding-intern' });
    assert.ok(!/'done' is now 'submit'/.test(err), 'submit itself prints no rename notice');
    const body = JSON.parse(out);
    assert.match(String(body.error || ''), /No running Switchboard instance/);
    assert.strictEqual(code, 1);
});

// ── 4. The seat supplies no planId and no workspaceRoot ──────────────────

check('the host resolves the held card from the seat identity — the agent supplies no planId', () => {
    const server = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
    const start = server.indexOf('private _runQueueDone(');
    assert.ok(start > 0, '_runQueueDone must exist');
    const window = server.slice(start, start + 3000);
    assert.ok(/ownerSeat === from/.test(window),
        'the card is resolved by ownerSeat === from, never by an agent-supplied planId');

    const cli = fs.readFileSync(path.join(process.cwd(), 'src', 'standalone', 'cli.ts'), 'utf8');
    const cmd = cli.indexOf('async function cmdSubmit(');
    assert.ok(cmd > 0);
    const cmdBody = cli.slice(cmd, cli.indexOf('\n/**', cmd));
    assert.ok(/workspaceRoot,/.test(cmdBody),
        'the CLI fills workspaceRoot from its own root — the agent never types it');
    assert.ok(/process\.env\.SWITCHBOARD_TERMINAL/.test(cmdBody),
        'the CLI reads the host-injected identity');
});

// ── 5. No placeholder identity, ever ─────────────────────────────────────

check('cmdSubmit substitutes no placeholder identity', () => {
    const cli = fs.readFileSync(path.join(process.cwd(), 'src', 'standalone', 'cli.ts'), 'utf8');
    const cmd = cli.indexOf('async function cmdSubmit(');
    const cmdBody = cli.slice(cmd, cli.indexOf('\n/**', cmd))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    for (const placeholder of ["'unknown'", '"unknown"', "|| 'seat'", "?? 'seat'"]) {
        assert.ok(!cmdBody.includes(placeholder),
            `cmdSubmit must not fall back to ${placeholder} — a completion attributed to the `
            + 'wrong seat clears the wrong terminal');
    }
});

// ── 6. No seat-facing instruction names --from ───────────────────────────
//
// This is the assertion that keeps the field from creeping back one
// instruction at a time — the way `outcome` survived five corrections and a
// contract test. Scoped to SEAT-facing strings: the lead's asserted-completion
// path (POST /kanban/task/complete) legitimately names from/planId/
// workspaceRoot, because naming which plan is complete is the lead's job.

const SEAT_FACING_SOURCES = [
    'src/services/standingOrderFragments.ts',
    'src/services/teamWiring.ts',
    'src/services/agentPromptBuilder.ts',
    'src/services/PlanIngestionEngine.ts',
];

function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

check('no seat-facing instruction tells a seat to supply --from to done', () => {
    for (const rel of SEAT_FACING_SOURCES) {
        const code = stripComments(fs.readFileSync(path.join(process.cwd(), rel), 'utf8'));
        const hit = /done\s+--from/.exec(code);
        assert.ok(!hit,
            `${rel} still instructs a seat to supply --from to done: ${hit && hit[0]}. `
            + 'The CLI resolves the seat from SWITCHBOARD_TERMINAL; an instruction that '
            + 'names the field puts the agent back to assembling the report.');
    }
});

check("the lead's completion instruction names the subtask it is accepting", () => {
    const frag = fs.readFileSync(
        path.join(process.cwd(), 'src', 'services', 'standingOrderFragments.ts'), 'utf8');
    // There is no longer a stateless variant to scope this to. The lead's
    // completion verb is `accept <n>` (subtask ordinal); the hand-assembled
    // task/complete POST it replaced is gone, along with the
    // `hasRegisteredRounds` branch that kept it alive for every team that had
    // not yet registered rounds — which was every team, always.
    assert.ok(/accept <n>/.test(frag),
        'the lead accepts by CLI verb — accept <n> is the completion instruction');
    assert.ok(/<that SUBTASK\\'s planId>/.test(frag),
        'the lead names WHICH subtask it is accepting — never the feature');
    assert.ok(!/task\/complete with \{"from"/.test(frag),
        'the lead is no longer told to hand-assemble a task/complete POST');
});

check("the lead's completion fragment names accept <n> and NOT round/complete or feature/complete", () => {
    // The lead's one verb is accept <n>. No lead-facing string names
    // round/complete or feature/complete — the system closes the round and
    // completes the feature as a consequence of the accepts (plan:
    // the-lead-accepts-a-subtask-and-the-system-advances).
    //
    // This used to be scoped to a `hasRegisteredRounds: true` variant, with a
    // companion assertion pinning that the `false` variant still named
    // round/complete and feature/complete. That companion assertion pinned the
    // bug: "no registered rounds" is the state every feature starts in, so the
    // stateless branch was the only branch any lead ever saw and no lead was
    // ever told to register a round. Both the branch and its assertion are
    // gone — there is one contract.
    const { buildHeadCompletionFragment } = require(
        path.join(process.cwd(), 'out', 'services', 'standingOrderFragments.js'));
    const frag = buildHeadCompletionFragment();
    assert.ok(/accept <n>/.test(frag),
        'the lead completion fragment must name accept <n>');
    assert.ok(/round\/register/.test(frag),
        'the lead is told to register its rounds — unconditionally, not only once it already has some');
    assert.ok(!/round\/complete/.test(frag),
        'the lead must NOT name round/complete — the system closes the round');
    assert.ok(!/feature\/complete/.test(frag),
        'the lead must NOT name feature/complete — the system completes the feature');
});

if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log('\nResults: all passed, 0 failed.');
