'use strict';

/**
 * Contract: named remotes and the source line, in both clients.
 *
 * Plan: `named-remotes-and-the-source-line-in-both-clients`.
 *
 * Two halves pinned here:
 *
 *   1. `switchboard remote add|list|remove|default` — the write side of
 *      ~/.switchboard/remotes.json (0600), shared by both clients against one
 *      schema. The refusals are the load-bearing part: a 401 board, an
 *      existing name, a remove of the configured default, a corrupt file —
 *      every one must name the cause AND the recovery (invariant 4).
 *
 *   2. The source line — `[switchboard] labcom · <url> · <root> · via
 *      <source>` on stderr for every remote command, `target` in every
 *      --json envelope, nothing for local invocations. This is the tagging
 *      half of the fallback rule: a sticky configured defaultRemote
 *      retargets every bare command, so which board answered must be
 *      visible, not silent.
 *
 * Behavioural assertions run against `out/` (run `npm run compile-tests`
 * first) and against transpile-and-eval extraction of the cli.ts functions
 * (cli.ts is not importable as a module). Parity assertions are source-level
 * against both clients — the divergence rule for this subtask is that the
 * two binaries produce the same outcome and the same message shape.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

const REPO = path.resolve(__dirname, '..', '..');
const api = require(path.join(REPO, 'out', 'standalone', 'apiTarget.js'));
const { loadRemotesConfig, saveRemotesConfig, parseServerUrl } = api;

let failures = 0;
function check(name, fn) {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures++; console.error(`  FAIL  ${name}\n        ${err && err.message}`); }
}

function read(rel) { return fs.readFileSync(path.join(REPO, rel), 'utf8'); }

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'remote-config-')); }

/** Extract a top-level `function name(` (Node) or `func name(` (Go) … matching column-0 `}` block. */
function extractFn(src, name) {
    let start = src.indexOf(`function ${name}(`);
    if (start < 0) { start = src.indexOf(`func ${name}(`); }
    assert.ok(start > -1, `${name} not found`);
    const end = src.indexOf('\n}\n', start);
    assert.ok(end > -1, `${name} body not closed`);
    return src.slice(start, end + 3);
}

/**
 * Transpile-extract cli.ts helpers and evaluate them against injected
 * `process`/`console` fakes — the same technique the api-target suite uses
 * for probeHealth. cli.ts cannot be require()'d, but its pure functions
 * can be lifted, transpiled, and exercised.
 */
function evalCli(tsSource, names, sandboxArgs) {
    const js = ts.transpileModule(tsSource, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
        fileName: 'cli.ts',
    }).outputText;
    const factory = new Function('process', 'console', `${js}\nreturn { ${names.join(', ')} };`);
    return factory.apply(null, sandboxArgs);
}

async function run() {
    console.log('\ncli-remote-config-contract\n');
    const cli = read('src/standalone/cli.ts');
    const apiTarget = read('src/standalone/apiTarget.ts');
    const goRemotes = read('internal/client/remotes.go');
    const goResolve = read('internal/client/resolve.go');
    const goMain = read('cmd/switchboard/main.go');
    const goTransport = read('internal/client/transport.go');
    const goOutput = read('internal/client/output.go');

    // ── 1. The remote verb joins the Node whitelist surface ─────────────

    check("'remote' joins the three whitelists a client subcommand must join", () => {
        const heap = cli.slice(cli.indexOf('HEAP_REEXEC_EXEMPT_SUBCOMMANDS = new Set('), cli.indexOf('heapFirstArg'));
        assert.ok(heap.includes("'remote'"), 'remote missing from HEAP_REEXEC_EXEMPT_SUBCOMMANDS — it can never start a board');
        const known = cli.slice(cli.indexOf('KNOWN_SUBCOMMANDS = new Set('), cli.indexOf('const firstArg'));
        assert.ok(known.includes("'remote'"), 'remote missing from KNOWN_SUBCOMMANDS — the unknown-subcommand guard would reject it');
        const cwdBlock = cli.slice(cli.indexOf('const subcommandTargetsCwd'), cli.indexOf('const switchboardDir'));
        assert.ok(cwdBlock.includes("subcommand !== 'remote'"), 'remote missing from the subcommandTargetsCwd exclusion — `remote add` from a non-workspace dir would mint a stray .switchboard/');
    });

    check("'remote' dispatches to cmdRemote and never resolves a board target", () => {
        assert.ok(cli.includes("process.argv[2] === 'remote'"), 'no remote dispatch block');
        const block = cli.slice(cli.indexOf('// ─── remote: named boards'), cli.indexOf('* `switchboard done'));
        // Comments in this section NAME the seam they deliberately avoid, so
        // strip them before the search — a prose mention is not a call.
        const code = block
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
        assert.ok(!/\b(resolveApiTarget|tryResolveBoardTarget|resolveBoardTarget)\s*\(/.test(code), 'remote subcommands must not resolve a board target — only `add` dials, and it resolves its own URL');
    });

    // ── 2. remotes.json — write path, mode, corruption ──────────────────

    check('remotes.json is written 0600 and round-trips through the shared loader', () => {
        const p = path.join(tmpdir(), 'sub', 'remotes.json');
        saveRemotesConfig(p, {
            defaultRemote: 'labcom',
            remotes: { labcom: { url: 'http://labcom:7777', workspaceRoot: '/srv/board', roots: ['/srv/board'], lastContact: '2026-09-18T00:00:00Z' } },
        });
        const mode = fs.statSync(p).mode & 0o777;
        assert.strictEqual(mode, 0o600, `remotes.json mode ${mode.toString(8)} — must be 0600`);
        const cfg = loadRemotesConfig(p);
        assert.strictEqual(cfg.defaultRemote, 'labcom');
        assert.strictEqual(cfg.remotes.labcom.url, 'http://labcom:7777');
        assert.strictEqual(cfg.remotes.labcom.workspaceRoot, '/srv/board');
        assert.deepStrictEqual(cfg.remotes.labcom.roots, ['/srv/board']);
        assert.strictEqual(cfg.remotes.labcom.lastContact, '2026-09-18T00:00:00Z');
    });

    check('both clients write remotes.json at 0600 (write-then-chmod, not umask-masked mode)', () => {
        assert.ok(/chmodSync\(remotesPath, 0o600\)/.test(apiTarget), 'Node saveRemotesConfig does not chmod 0600');
        assert.ok(/Chmod\(path, 0o600\)/.test(goRemotes), 'Go writeRemotesConfig does not chmod 0600');
    });

    check('a corrupt remotes.json surfaces as corrupt, never as unconfigured', () => {
        const p = path.join(tmpdir(), 'remotes.json');
        fs.writeFileSync(p, '{not json');
        assert.throws(() => loadRemotesConfig(p), /corrupt/, 'corrupt file must throw naming corruption — reading it as {} is the forbidden fallback shape');
    });

    // ── 3. remote add — refusal cases (invariant 4: cause AND recovery) ──

    check('remote add refuses a 401 board WITHOUT storing, naming the remedy', () => {
        const body = extractFn(cli, 'cmdRemoteAdd');
        const idx401 = body.indexOf('res.status === 401');
        const idxSave = body.indexOf('saveRemotesConfig');
        assert.ok(idx401 > -1, 'no 401 arm in cmdRemoteAdd');
        assert.ok(idxSave > -1 && idx401 < idxSave, 'the 401 refusal must precede the store — a token-locked board must never be persisted');
        assert.ok(/SWITCHBOARD_API_TOKEN=<token> or --token-file <path>/.test(body), '401 refusal does not name the credential remedy');
        assert.ok(/switchboard token clear/.test(body), '401 refusal does not name the remote-side remedy');
        const goBody = extractFn(read('internal/client/remotes.go'), 'remoteAdd');
        assert.ok(goBody.indexOf('res.Status == 401') > -1 && goBody.indexOf('res.Status == 401') < goBody.indexOf('writeRemotesConfig'), 'Go must refuse the 401 before storing');
        assert.ok(/SWITCHBOARD_API_TOKEN=<token> or --token-file <path>/.test(goBody) && /switchboard token clear/.test(goBody), 'Go 401 refusal does not name the remedy');
    });

    check('remote add makes one real read after /health — reachability is not usability', () => {
        const body = extractFn(cli, 'cmdRemoteAdd');
        const idxHealth = body.indexOf('fetchHealthJson');
        const idxRead = body.indexOf("apiGet(probe, '/kanban/plans')");
        assert.ok(idxHealth > -1 && idxRead > -1 && idxHealth < idxRead, 'the real read must follow the health probe');
        const goBody = extractFn(read('internal/client/remotes.go'), 'remoteAdd');
        assert.ok(goBody.indexOf('GetHealth') > -1 && goBody.indexOf('GetHealth') < goBody.indexOf('apiGet("/kanban/plans"'), 'Go must health-then-read');
    });

    check('remote add of an existing name refuses naming the stored target (explicit --force to overwrite)', () => {
        const body = extractFn(cli, 'cmdRemoteAdd');
        const idxExisting = body.indexOf('is already configured');
        const idxProbe = body.indexOf('fetchHealthJson');
        assert.ok(idxExisting > -1 && idxProbe > -1 && idxExisting < idxProbe, 'the existing-name check must precede the probe — silently rebinding a name retargets every command that uses it');
        assert.ok(/--force/.test(body), 'the refusal must name the explicit overwrite path');
        const goBody = extractFn(read('internal/client/remotes.go'), 'remoteAdd');
        assert.ok(/is already configured \(%s\)/.test(goBody), 'Go refusal does not name the existing target');
        assert.ok(/--force/.test(goBody), 'Go refusal does not name the overwrite path');
    });

    check('remote add with multiple advertised roots refuses listing them, never picks', () => {
        const body = extractFn(cli, 'cmdRemoteAdd');
        assert.ok(/workspace roots and none was chosen/.test(body), 'no multi-root refusal');
        assert.ok(/--workspace-root <path>/.test(body), 'multi-root refusal does not name the recovery flag');
        const idxRefuse = body.indexOf('workspace roots and none was chosen');
        assert.ok(idxRefuse > -1 && idxRefuse < body.indexOf('saveRemotesConfig'), 'the refusal must precede the store');
        const goBody = extractFn(read('internal/client/remotes.go'), 'remoteAdd');
        assert.ok(/workspace roots and none was chosen/.test(goBody), 'Go multi-root refusal missing');
    });

    // ── 4. remote remove/default — sticky-state bookkeeping ──────────────

    check('remote remove of the configured default clears the default and says so', () => {
        const nodeBody = extractFn(cli, 'cmdRemoteRemove');
        assert.ok(/delete cfg\.defaultRemote/.test(nodeBody), 'Node does not clear defaultRemote');
        assert.ok(/default is cleared/.test(nodeBody), 'Node does not report the cleared default');
        const goBody = extractFn(read('internal/client/remotes.go'), 'remoteRemove');
        assert.ok(/DefaultRemote = ""/.test(goBody), 'Go does not clear DefaultRemote');
        assert.ok(/default is cleared/.test(goBody), 'Go does not report the cleared default');
    });

    check('remote remove of an unknown name errors naming the configured remotes', () => {
        const nodeBody = extractFn(cli, 'cmdRemoteRemove');
        assert.ok(/is not configured — configured remotes:/.test(nodeBody), 'Node unknown-name error does not list configured remotes');
        const goBody = extractFn(read('internal/client/remotes.go'), 'remoteRemove');
        assert.ok(/is not configured — configured remotes:/.test(goBody), 'Go unknown-name error does not list configured remotes');
    });

    check('remote default --clear reports the cleared stickiness', () => {
        const nodeBody = extractFn(cli, 'cmdRemoteDefault');
        assert.ok(/default remote cleared — bare commands resolve this machine's board again/.test(nodeBody));
        const goBody = extractFn(read('internal/client/remotes.go'), 'remoteDefault');
        assert.ok(/default remote cleared — bare commands resolve this machine's board again/.test(goBody));
    });

    // ── 5. The source line — remote-only, stderr, suppressed under --json ─

    check('the source line is emitted for a remote invocation and never a local one (behavioural)', () => {
        const decls = cli.slice(cli.indexOf('let activeBoardTarget'), cli.indexOf('/** Write a JSON payload'));
        const fns = decls + '\n' + extractFn(cli, 'recordActiveTarget') + '\n' + extractFn(cli, 'emitJson');
        const errs = [];
        const out = [];
        const fakeProcess = { argv: ['node', 'cli.js', 'plans'], stdout: { write: s => out.push(s) } };
        const fakeConsole = { error: m => errs.push(m) };
        const { recordActiveTarget, emitJson } = evalCli(fns, ['recordActiveTarget', 'emitJson'], [fakeProcess, fakeConsole]);

        const remote = { baseUrl: 'https://labcom.ts.net', workspaceRoot: '/home/patrick/labcom', rootSource: 'config:remotes.labcom.workspaceRoot', auth: { token: null, source: 'tailnet-listener-trusted' }, source: 'config:remotes.labcom', isRemote: true, remoteName: 'labcom' };
        recordActiveTarget(remote);
        assert.strictEqual(errs.length, 1, 'a remote target must emit exactly one source line');
        assert.strictEqual(errs[0], '[switchboard] labcom · https://labcom.ts.net · /home/patrick/labcom · via config:remotes.labcom', `source line mismatch: ${errs[0]}`);

        recordActiveTarget(remote);
        assert.strictEqual(errs.length, 1, 're-resolving the same target must not reprint the line (board-console loop)');

        emitJson({ success: true, plans: [] });
        const emitted = JSON.parse(out.join(''));
        assert.deepStrictEqual(emitted.target, { baseUrl: 'https://labcom.ts.net', workspaceRoot: '/home/patrick/labcom', source: 'config:remotes.labcom' }, 'a remote emitJson envelope must carry the target facts');
        assert.strictEqual(Object.keys(emitted).pop(), 'target', 'target must be the last key — mirrors the Go splice');

        errs.length = 0;
        out.length = 0;
        recordActiveTarget({ baseUrl: 'http://127.0.0.1:7777', workspaceRoot: '/x', rootSource: 'local:cwd', auth: { token: null, source: 'none' }, source: 'local:probe', isRemote: false });
        assert.strictEqual(errs.length, 0, 'a local invocation must gain no new output');
        emitJson({ success: true });
        assert.ok(!('target' in JSON.parse(out.join(''))), 'a local emitJson envelope must carry no target');
    });

    check('--json suppresses the source line (the facts ride the envelope instead)', () => {
        const decls = cli.slice(cli.indexOf('let activeBoardTarget'), cli.indexOf('/** Write a JSON payload'));
        const fns = decls + '\n' + extractFn(cli, 'recordActiveTarget');
        const errs = [];
        const fakeProcess = { argv: ['node', 'cli.js', 'plans', '--json'], stdout: { write: () => {} } };
        const { recordActiveTarget } = evalCli(fns, ['recordActiveTarget'], [fakeProcess, { error: m => errs.push(m) }]);
        recordActiveTarget({ baseUrl: 'https://labcom.ts.net', workspaceRoot: '/r', rootSource: 'config', auth: { token: null, source: 'none' }, source: 'config:remotes.labcom', isRemote: true, remoteName: 'labcom' });
        assert.strictEqual(errs.length, 0, '--json must not emit the stderr source line');
    });

    check('the resolution seam records the target so the line and the envelope see it', () => {
        const body = extractFn(cli, 'tryResolveBoardTarget');
        assert.ok(/recordActiveTarget\(target\)/.test(body), 'tryResolveBoardTarget does not record the resolved target — no remote command would print the line');
    });

    check('the via tags are identical between clients', () => {
        // The Node endpoint tags are minted by the resolver (apiTarget.ts) and
        // printed by cli.ts — one client, two files, so search both.
        const node = cli + apiTarget;
        for (const via of ['flag:--remote ', 'env:SWITCHBOARD_REMOTE', 'flag:--server', 'env:SWITCHBOARD_SERVER_URL', 'config:remotes.']) {
            assert.ok(node.includes(via), `Node missing via tag '${via}'`);
            assert.ok(goRemotes.includes(via), `Go missing via tag '${via}'`);
        }
        assert.ok(/ · /.test(cli) && / · /.test(goRemotes), 'the name·url·root·via separator differs between clients');
    });

    // ── 6. Go-side wiring — dispatch order, Diag, emitJSON injection ─────

    check("'remote' is handled before the owned-verb dispatch in the Go front controller", () => {
        const remoteIdx = goMain.indexOf('verb == "remote"');
        const ownedIdx = goMain.indexOf('!ownedVerbs[verb]');
        assert.ok(remoteIdx > -1 && ownedIdx > -1 && remoteIdx < ownedIdx, 'remote must be handled before the owned-verb gate — it is config-only and needs no endpoint resolution');
    });

    check('the Go client emits the source line before dispatch and suppresses it under --json', () => {
        const lineIdx = goMain.indexOf('TargetSourceLine');
        const dispatchIdx = goMain.indexOf('dispatchOwned(c, verb, args)');
        assert.ok(lineIdx > -1 && dispatchIdx > -1 && lineIdx < dispatchIdx, 'the source line must print before verb output');
        assert.ok(/!c\.JSONFlag/.test(goMain), 'the line is not suppressed under --json');
        assert.ok(/!localBoard/.test(goMain), 'the line is not gated on a remote endpoint — a local invocation would gain output');
        assert.ok(/SetActiveTarget/.test(goMain), 'the JSON target is never activated — --json envelopes would carry no target');
    });

    check('Transport.Diag is wired — the declared-but-never-assigned hook now exists', () => {
        const nt = goTransport.slice(goTransport.indexOf('func newTransport'), goTransport.indexOf('func defaultTimeoutTimeoutMs'));
        assert.ok(/Diag:/.test(nt), 'Transport.Diag is still never assigned');
        assert.ok(/os\.Stderr/.test(nt), 'Diag must write to stderr — stdout stays the command payload');
    });

    check('emitJSON appends target as the last envelope key, mirroring emitJson', () => {
        assert.ok(/withTargetJSON/.test(goOutput), 'no target injection in the Go emit path');
        const body = goOutput.slice(goOutput.indexOf('func withTargetJSON'), goOutput.indexOf('func emitHuman'));
        assert.ok(/"target"/.test(body), 'withTargetJSON does not inject the target key');
        assert.ok(/activeJSONTarget/.test(goOutput), 'no active-target state drives the injection');
        const goRemotesSrc = read('internal/client/remotes.go');
        for (const k of ['baseUrl', 'workspaceRoot', 'source']) {
            assert.ok(goRemotesSrc.includes(`json:"${k}"`), `TargetInfo missing json key '${k}' — envelope shape would diverge from Node`);
        }
    });

    // ── 7. Schema and message parity ─────────────────────────────────────

    check('the stored-remote schema is identical in both clients', () => {
        for (const f of ['url', 'workspaceRoot', 'roots', 'lastContact']) {
            assert.ok(apiTarget.includes(f), `Node StoredRemote missing '${f}'`);
            assert.ok(goResolve.includes(`json:"${f},omitempty"`) || goResolve.includes(`json:"${f}"`), `Go StoredRemote missing '${f}'`);
        }
        for (const f of ['defaultRemote', 'remotes']) {
            assert.ok(apiTarget.includes(f) && goResolve.includes(`json:"${f},omitempty"`), `RemotesConfig key '${f}' diverges`);
        }
    });

    check('remote add/list/remove/default produce the same messages in both clients', () => {
        for (const frag of [
            "'remote' needs a subcommand: add | list | remove | default",
            'is not a usable remote name',
            'is already configured',
            'pass --force to overwrite, or pick another name',
            'answered /health but rejected a real read with 401',
            'SWITCHBOARD_API_TOKEN=<token> or --token-file <path>',
            "switchboard token clear' on the remote host",
            'advertises no workspace roots',
            'workspace roots and none was chosen',
            "No remotes configured — add one with 'switchboard remote add <name> <url>'.",
            'is not configured — configured remotes:',
            'it was the configured default remote; the default is cleared',
            "default remote cleared — bare commands resolve this machine's board again.",
            'bare commands now target',
            'last contact ',
        ]) {
            assert.ok(cli.includes(frag), `Node missing message fragment: ${frag}`);
            assert.ok(goRemotes.includes(frag), `Go missing message fragment: ${frag}`);
        }
    });

    console.log(failures === 0 ? '\nALL PASSED\n' : `\n${failures} FAILED\n`);
    process.exit(failures === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
