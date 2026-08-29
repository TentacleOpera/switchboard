'use strict';

/**
 * Contract: the PTY verb surface lives on `/terminals/verb/`, and ONLY there.
 * (extension-host-pty-fleet-and-packaging.md, steps 2a and 3.)
 *
 * The guarantee this pins is structural rather than disciplinary. The VS Code sidebar
 * board posts to `/kanban/verb/`. If the four `pty*` verbs exist only on
 * `/terminals/verb/`, the sidebar CANNOT spawn a terminal it has no way to display —
 * enforced by routing, not by a convention a future edit can quietly break.
 *
 * It also pins the second half of that guarantee: `pty*` must stay out of the
 * GENERATED surface entirely (no catalog entries, no KANBAN_VERBS members), so
 * catalog:check / parity:check / verb-returns:check remain untouched by this feature.
 * A `pty` member appearing in the allowlist means an arm leaked into a Provider switch.
 *
 * Requires `npm run compile-tests` (loads compiled output from out/).
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PTY_VERBS = [
    'ptyCreateTerminal', 'ptyCreateBatch', 'ptyCloseTerminal', 'ptyListTerminals', 'ptyRenameTerminal',
    'ptyClearTerminal', 'ptySendModel', 'ptyClearAllTerminals', 'ptyPasteImage',
];

// The subset the terminals webview actually calls. `ptyCreateBatch` is
// deliberately agent-only: batch creation is an agent-only API (no webview button
// for it), called by agent automation over HTTP. Demanding a webview call site for
// it would force an unnecessary UI control. The NEGATIVE assertion — never on
// /kanban/verb/ — still covers every verb, batch included.
const WEBVIEW_PTY_VERBS = PTY_VERBS.filter(v => v !== 'ptyCreateBatch');

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

function post(port, pathname, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body || {});
        const req = http.request(
            { host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
            res => {
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(data); } catch { /* non-JSON body */ }
                    resolve({ status: res.statusCode, body: json, raw: data });
                });
            }
        );
        req.on('error', reject);
        req.end(payload);
    });
}

(async function main() {
    console.log('\n── PTY route surface contract ──');

    const { LocalApiServer } = require(path.join(REPO_ROOT, 'out', 'services', 'LocalApiServer.js'));

    // --- generated-surface isolation ---------------------------------------
    await test('KANBAN_VERBS contains no pty member (nothing leaked into a Provider switch)', () => {
        const allowlist = require(path.join(REPO_ROOT, 'out', 'generated', 'verbAllowlist.js'));
        const kanbanVerbs = allowlist.KANBAN_VERBS;
        assert.ok(kanbanVerbs, 'verbAllowlist must export KANBAN_VERBS');
        const leaked = [...kanbanVerbs].filter(v => /^pty/i.test(v));
        assert.deepStrictEqual(
            leaked, [],
            `pty verb(s) leaked into the generated kanban allowlist: ${leaked.join(', ')}. `
            + 'They must be served by the dedicated /terminals/verb/ route, not a Provider switch — '
            + 'verb-returns:check reconciles case-label counts against allowlist size and will trip.'
        );
    });

    await test('the protocol catalog lists no pty verb', () => {
        const catalog = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'protocol-catalog.json'), 'utf8'));
        const text = JSON.stringify(catalog.verbs || catalog);
        const hits = PTY_VERBS.filter(v => new RegExp(`"${v}"`).test(text));
        assert.deepStrictEqual(hits, [], `pty verb(s) present in the generated catalog: ${hits.join(', ')}`);
    });

    // --- live routing -------------------------------------------------------
    await test('pty verbs are reachable on /terminals/verb/ and reach the terminalVerb hook', async () => {
        const seen = [];
        const server = new LocalApiServer({
            port: 0,
            workspaceRoot: REPO_ROOT,
            // Empty token keeps _checkAuth's historical loopback trust — the proven
            // in-repo pattern, not a hand-rolled bypass.
            getAuthToken: async () => '',
            terminalVerb: async (verb) => { seen.push(verb); return { success: true, verb }; },
        });
        await server.start();
        try {
            const port = server.getPort();
            for (const verb of PTY_VERBS) {
                const res = await post(port, `/terminals/verb/${verb}`, {});
                assert.strictEqual(res.status, 200, `${verb} should reach terminalVerb (got ${res.status})`);
                assert.strictEqual(res.body && res.body.verb, verb, `${verb} response must carry the dispatched verb in-body`);
            }
            assert.deepStrictEqual(seen, PTY_VERBS, 'terminalVerb must receive all four verbs');
        } finally {
            await server.stop();
        }
    });

    await test('/terminals/verb/ returns 503 when the host does not wire terminalVerb', async () => {
        // Matches how every other panel verb route behaves in a host that has not
        // constructed that panel — capability-gating honesty, not a silent 404.
        const server = new LocalApiServer({ port: 0, workspaceRoot: REPO_ROOT, getAuthToken: async () => '' });
        await server.start();
        try {
            const res = await post(server.getPort(), '/terminals/verb/ptyListTerminals', {});
            assert.strictEqual(res.status, 503, `expected 503 with no terminalVerb wired, got ${res.status}`);
        } finally {
            await server.stop();
        }
    });

    await test('pty verbs on /kanban/verb/ do NOT reach the terminal fleet', async () => {
        // The load-bearing half: even with BOTH hooks wired, a pty verb posted to the
        // kanban route must never be served by the terminal fleet. The sidebar posts
        // there, and it cannot display a PTY.
        const terminalSeen = [];
        const kanbanSeen = [];
        const server = new LocalApiServer({
            port: 0,
            workspaceRoot: REPO_ROOT,
            getAuthToken: async () => '',
            terminalVerb: async (verb) => { terminalSeen.push(verb); return { success: true }; },
            kanbanVerb: async (verb) => { kanbanSeen.push(verb); return { success: false, error: `Verb '${verb}' not implemented` }; },
        });
        await server.start();
        try {
            for (const verb of PTY_VERBS) {
                await post(server.getPort(), `/kanban/verb/${verb}`, {});
            }
            assert.deepStrictEqual(
                terminalSeen, [],
                `terminalVerb was reached via /kanban/verb/: ${terminalSeen.join(', ')} — the routing guarantee is broken.`
            );
            assert.deepStrictEqual(kanbanSeen, PTY_VERBS, 'the kanban route should still receive and reject them');
        } finally {
            await server.stop();
        }
    });

    await test('/ws/terminal is destroyed when no gateway is injected', async () => {
        const server = new LocalApiServer({ port: 0, workspaceRoot: REPO_ROOT, getAuthToken: async () => '' });
        await server.start();
        try {
            const port = server.getPort();
            const outcome = await new Promise((resolve) => {
                const req = http.request({
                    host: '127.0.0.1', port, path: '/ws/terminal?name=x', method: 'GET',
                    headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
                });
                req.on('upgrade', () => resolve('upgraded'));
                req.on('response', res => resolve(`response:${res.statusCode}`));
                req.on('error', () => resolve('destroyed'));
                req.end();
            });
            assert.notStrictEqual(outcome, 'upgraded', 'an upgrade must not succeed with no terminalWsGateway wired');
        } finally {
            await server.stop();
        }
    });

    // --- both hosts wire it the same way ------------------------------------
    await test('the standalone host serves pty verbs on terminalVerb, not kanbanVerb', () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'bootstrap.ts'), 'utf8');
        const kanbanVerbBlock = src.slice(src.indexOf('const kanbanVerb'), src.indexOf('const handlePtyVerb'));
        for (const verb of PTY_VERBS) {
            assert.ok(
                !new RegExp(`case '${verb}'`).test(kanbanVerbBlock),
                `bootstrap.ts still serves '${verb}' from kanbanVerb — it belongs on /terminals/verb/ only.`
            );
        }
        assert.ok(/terminalVerb:/.test(src), 'bootstrap.ts must wire terminalVerb into LocalApiServerOptions');
        assert.ok(
            /terminalVerb:[\s\S]{0,400}?ptyReady/.test(src),
            'the terminalVerb entry point must keep the ptyReady guard — an unguarded call surfaces as an unhandled spawn exception.'
        );
    });

    await test('the extension host wires terminalVerb and gates capabilities on the constructed fleet', () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        assert.ok(/terminalVerb:/.test(src), 'TaskViewerProvider must wire terminalVerb');
        assert.ok(!/terminalWsGateway:\s*this\._terminalWsGateway/.test(src), 'TaskViewerProvider must not inject in-process terminalWsGateway into LocalApiServer');
        // Capability-gating honesty (PRD contract #6): the probe passing is not enough.
        // With no kanban db the fleet is never constructed, and advertising the panel
        // on the probe alone ships a Terminals icon whose every verb fails.
        assert.ok(
            /terminalFleet:\s*ptyHostReady\(\)/.test(src),
            'terminalFleet must derive from the CONSTRUCTED fleet (ptyHostReady()), not the bare probe.'
        );
        assert.ok(
            /terminals:\s*ptyHostReady\(\)/.test(src),
            'the /panels manifest must gate the terminals entry on the constructed fleet, not the bare probe.'
        );
    });

    await test('the extension host forwards pty verbs to the child process, never to an in-process fleet', () => {
        // The whole point of the out-of-process host: terminal work leaves the
        // extension's event loop (35.21 ms p50 in-process vs 0.24 ms out). A
        // "convenience" re-introduction of an in-process PtyFleetService or a
        // TerminalWsGateway here puts every frame straight back on the contended loop.
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        assert.ok(
            // Arity-tolerant: the contract is "forwards through _ptyHostVerb", not
            // an exact parameter count — the assertions below still pin the real
            // invariants.
            /_ptyHostVerb\s*\(\s*verb\s*,\s*payload\s*[,)]/.test(src),
            'the extension-host terminalVerb arm must forward through _ptyHostVerb (HTTP to the child), not serve verbs locally.'
        );
        assert.ok(
            /\/api\/pty\/\$\{encodeURIComponent\(verb\)\}/.test(src),
            '_ptyHostVerb must POST to the child on /api/pty/<verb>.'
        );
        assert.ok(
            !/new\s+PtyFleetService\s*\(/.test(src),
            'TaskViewerProvider must not construct a PtyFleetService — the fleet lives in the pty host child.'
        );
        assert.ok(
            !/new\s+TerminalWsGateway\s*\(/.test(src),
            'TaskViewerProvider must not construct a TerminalWsGateway — the gateway lives in the pty host child.'
        );
        // Dispatch delivery must keep its bracketed-paste/chunking/lock machinery. A
        // raw ptyWrite submits a multi-line prompt line by line and the agent runs
        // fragments; the lock can only serialise concurrent dispatches on the child.
        assert.ok(
            /_ptyHostVerb\('ptySendPrompt'/.test(src),
            'dispatch delivery to a PTY must use the ptySendPrompt verb, not a raw ptyWrite.'
        );
        const child = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'ptyHost.ts'), 'utf8');
        assert.ok(
            /case 'ptySendPrompt'/.test(child) && /sendPromptToPty\(/.test(child),
            'the pty host must serve ptySendPrompt via sendPromptToPty.'
        );
        // process.execPath in the extension host is the ELECTRON binary. Without this
        // the spawn opens a second IDE window instead of running the script.
        assert.ok(
            /ELECTRON_RUN_AS_NODE:\s*'1'/.test(src),
            'the pty host spawn must set ELECTRON_RUN_AS_NODE=1 — process.execPath is Electron under the extension host.'
        );
    });

    // --- one rule, both hosts: reset the input line before a slash command ---
    // An agent CLI's input box is a persistent buffer. Anything the user left in
    // it concatenates with the next write, so `/clear` arrives as `…text/clear` —
    // a prompt, not a command — and the context is never reset. Every leg that
    // writes a slash command must emit Ctrl+U (\x15) first, OUTSIDE any paste
    // framing. pty-prompt-delivery-framing.test.js pins the byte sequence on the
    // in-process helper; these assertions pin the legs that helper cannot see:
    // the child process, the standalone host, and the two VS Code paths.
    await test('every slash-command write leg resets the input line first (both hosts)', () => {
        const delivery = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'ptyPromptDelivery.ts'), 'utf8');
        assert.ok(
            /export async function writeSlashCommand\b/.test(delivery)
            && /export async function writeSlashCommandLocked\b/.test(delivery),
            'ptyPromptDelivery must export BOTH writeSlashCommand (takes the terminal lock) and writeSlashCommandLocked (for callers already inside it) — withTerminalLock is a promise chain, not a reentrant mutex, so one variant cannot serve both.'
        );
        assert.ok(
            !/handle\.write\('\/(clear|model)/.test(delivery),
            'no bare handle.write of a slash command may remain in ptyPromptDelivery — every one must route through writeSlashCommand(Locked).'
        );

        // Child process (leg: ptyWrite, the only path implementation.html's four
        // clear buttons take to a PTY seat under the extension host).
        const child = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'ptyHost.ts'), 'utf8');
        const ptyWriteArm = child.slice(child.indexOf("case 'ptyWrite'"), child.indexOf("case 'ptyPasteImage'"));
        assert.ok(ptyWriteArm.length > 0, "ptyHost.ts must still serve a 'ptyWrite' arm");
        assert.ok(
            /writeSlashCommand\(/.test(ptyWriteArm) && /startsWith\('\/'\)/.test(ptyWriteArm),
            "the ptyWrite arm must route a single-line leading-slash write through writeSlashCommand — the rule lives at the write, not in the caller, or a future ptyWrite caller silently opts out."
        );

        // Standalone host (same four buttons, in-process fleet).
        // Anchor inside handlePtyVerb: the kanbanVerb router also carries a
        // `case 'sendToTerminal'`, but it only forwards here behind the ptyReady
        // guard — the real write leg is this one.
        const boot = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'bootstrap.ts'), 'utf8');
        const ptyRouter = boot.slice(boot.indexOf('const handlePtyVerb'));
        const sendToTerminalArm = ptyRouter.slice(ptyRouter.indexOf("case 'sendToTerminal'"));
        assert.ok(
            /writeSlashCommand\(/.test(sendToTerminalArm.slice(0, 3000)),
            "bootstrap's sendToTerminal control-string branch must use writeSlashCommand, not a raw handle.write(text + '\\r')."
        );

        // VS Code clipboard leg: POSITION is the whole bug. The byte must be
        // emitted after focus has settled and BEFORE the paste command — inside
        // the pasted text it is literal, and before the clipboard lock it can
        // precede its own /clear by seconds under batch dispatch.
        const utils = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'terminalUtils.ts'), 'utf8');
        assert.ok(
            /clearInputLine\?:\s*boolean/.test(utils),
            'pasteTextViaClipboard must expose a clearInputLine option (default OFF, so sendRobustText large-prompt pastes stay byte-identical).'
        );
        const clearIdx = utils.indexOf('options?.clearInputLine');
        const pasteIdx = utils.indexOf("executeCommand('workbench.action.terminal.paste')");
        const settleIdx = utils.indexOf('PRE_PASTE_SETTLE_MS));');
        assert.ok(clearIdx !== -1 && pasteIdx !== -1 && settleIdx !== -1, 'terminalUtils must keep the focus-settle → clear → paste sequence recognisable');
        assert.ok(
            settleIdx < clearIdx && clearIdx < pasteIdx,
            'the Ctrl+U must be emitted AFTER focus acquisition/settle and BEFORE workbench.action.terminal.paste — both misplacements fail silently.'
        );

        // VS Code sendText legs.
        assert.ok(
            /export async function clearTerminalInputLine\(/.test(utils),
            'terminalUtils must export clearTerminalInputLine for the sendText-based legs.'
        );
        const ext = fs.readFileSync(path.join(REPO_ROOT, 'src', 'extension.ts'), 'utf8');
        assert.ok(
            /clearTerminalInputLine\(terminal\)[\s\S]{0,120}?sendRobustText\(terminal,\s*'\/clear'/.test(ext),
            "switchboard.clearAllTerminals must reset the input line before sendRobustText('/clear') — /clear is under the clipboard threshold, so it takes the sendText branch and concatenates."
        );
        const tvp = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        assert.ok(
            !/pasteTextViaClipboard\(terminal,\s*'\/clear',\s*\{\s*acquireFocus:\s*true\s*\}/.test(tvp),
            "every pasteTextViaClipboard(terminal, '/clear', …) call must pass clearInputLine: true."
        );
        assert.ok(
            /if \(isControlString\) \{ await clearTerminalInputLine\(terminal\); \}/.test(tvp),
            "sendToTerminal's registered-vscode.Terminal fallback must reset the input line for control strings — a PTY-only fix leaves VS Code terminal agents broken while every other leg reports done."
        );
        assert.ok(
            /isControlString[\s\S]{0,200}?sendText\(CLEAR_INPUT_LINE, false\)/.test(tvp),
            "sendToTerminal's HostTerminal seam fallback must write CLEAR_INPUT_LINE with addNewLine=false — true would submit the reset as its own line."
        );
        assert.ok(
            !/terminal\.sendText\(input, true\)/.test(tvp),
            "sendToTerminal's HostTerminal seam leg must not call sendText(input, true) — that resolves to write(text + '\\r') on the pty seam (ptyBackend.ts), and devin 3000.5.20 inserts a CR arriving in the same read as printable text as a literal newline instead of submitting. Split it: sendText(input, false), settle SUBMIT_SETTLE_MS, sendText('', true)."
        );
        assert.ok(
            /sendText\(input, false\)[\s\S]{0,200}?SUBMIT_SETTLE_MS[\s\S]{0,120}?sendText\('', true\)/.test(tvp),
            "sendToTerminal's HostTerminal seam leg must send the payload, settle SUBMIT_SETTLE_MS, then submit with a bare newline — the settle is load-bearing: two writes with no delay coalesce into one read."
        );
    });

    await test('terminals.js dials the pty host origin, not the page origin', () => {
        // Plan 3's regression: the panel and the gateway are no longer the same server
        // under the extension host. Rebuilding the socket URL from location.host
        // silently re-couples the panel to the extension port, which serves nothing.
        const js = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'terminals.js'), 'utf8');
        assert.ok(
            /PTY_HOST_ORIGIN\}\/ws\/terminal/.test(js),
            'terminals.js must build the /ws/terminal URL from PTY_HOST_ORIGIN.'
        );
        assert.ok(
            !/\$\{location\.host\}\/ws\/terminal/.test(js),
            'terminals.js must not construct the terminal socket URL from location.host directly — that is the re-coupling regression.'
        );
        assert.ok(
            /dataset\.ptyHostOrigin/.test(js),
            'PTY_HOST_ORIGIN must read the serve-time data-pty-host-origin body attribute.'
        );
        // The standalone host injects nothing and must stay byte-identical, so the
        // location fallback has to survive.
        assert.ok(
            /__SB_PTY_HOST_ORIGIN__[\s\S]{0,160}location\.host/.test(js),
            'the location.host fallback must remain so the standalone host is unchanged.'
        );
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        assert.ok(
            /data-pty-host-origin="ws:\/\/127\.0\.0\.1:\$\{this\._ptyHostPort\}"/.test(src),
            'the extension host must inject data-pty-host-origin alongside data-terminal-token at serve time.'
        );
    });

    await test('the webview posts pty verbs to /terminals/verb/ and keeps getSetting on /kanban/verb/', () => {
        const js = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'terminals.js'), 'utf8');
        for (const verb of WEBVIEW_PTY_VERBS) {
            assert.ok(new RegExp(`/terminals/verb/${verb}`).test(js), `terminals.js must post ${verb} to /terminals/verb/`);
        }
        for (const verb of PTY_VERBS) {
            assert.ok(!new RegExp(`/kanban/verb/${verb}`).test(js), `terminals.js still posts ${verb} to /kanban/verb/`);
        }
        // getSetting is a KANBAN verb (the agents.visibleAgents role-picker read). A
        // blanket "everything to /terminals/verb/" edit breaks the role picker.
        assert.ok(
            /\/kanban\/verb\/getSetting/.test(js),
            'getSetting is a kanban verb and must stay on /kanban/verb/ — moving it breaks the role picker.'
        );
    });

    await test('all three ptySendPrompt delivery paths honour an EXPLICIT clearBeforePrompt', () => {
        // The link-up relay's single most destructive failure mode. sendPromptToPty
        // writes `/clear` before the prompt when clearBeforePrompt is truthy, and the
        // config default is true — so a caller that hands its own context over must be
        // able to turn it off, on BOTH hosts. bootstrap.ts used to pass
        // getPromptDeliveryOptions() straight through, which DISCARDED the caller's
        // flag: the request visibly carried `clearBeforePrompt: false`, the call
        // returned {"success":true}, and the parent agent was /clear-ed anyway.
        // Green-while-wrong, on the one host with no other symptom.
        //
        // Pinned as a source assertion because the defect is an omission, not a
        // behaviour: a "simplify to the shared options helper" refactor re-arms it
        // and nothing else in the suite notices.
        const bootstrap = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'bootstrap.ts'), 'utf8');
        const armStart = bootstrap.indexOf(`case 'ptySendPrompt'`);
        assert.ok(armStart !== -1, "bootstrap.ts must serve a 'ptySendPrompt' arm");
        // Slice to the NEXT case label, not a fixed byte count. A magic window
        // silently starts testing the wrong text the moment the arm grows — which
        // is exactly what happened when the omitted-field default was documented:
        // the explanatory comment pushed the assertion's target past 2000 chars
        // and the gate went red on unchanged, correct behaviour.
        const nextCase = bootstrap.indexOf(`\n                case '`, armStart + 1);
        const arm = bootstrap.slice(armStart, nextCase === -1 ? armStart + 4000 : nextCase);
        assert.ok(
            /payload\.clearBeforePrompt/.test(arm),
            'the standalone ptySendPrompt arm must READ payload.clearBeforePrompt — passing '
            + 'getPromptDeliveryOptions() straight through discards the caller\'s explicit false '
            + 'and /clear-s the very terminal being asked to hand its context over.'
        );
        assert.ok(
            /typeof payload\.clearBeforePrompt === 'boolean'/.test(arm),
            'the standalone arm must fall back to the config default only when the field is ABSENT '
            + '(typeof === boolean), so an explicit false wins and an omitted field is unchanged.'
        );

        // The pty host child (extension-host fleet) resolves the same field itself.
        const child = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'ptyHost.ts'), 'utf8');
        assert.ok(
            /clearBeforePrompt:\s*payload\.clearBeforePrompt === true/.test(child),
            'ptyHost.ts must resolve clearBeforePrompt from the payload, defaulting to false.'
        );

        // The extension host injects the config default ONLY when the caller omitted it.
        const provider = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        assert.ok(
            /payload\.clearBeforePrompt === undefined/.test(provider),
            'TaskViewerProvider must inject the config default only when clearBeforePrompt is undefined — '
            + 'an unconditional injection overwrites an explicit false.'
        );

        // …and the link-up sender is the caller that depends on all of the above.
        const js = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'terminals.js'), 'utf8');
        const sendStart = js.indexOf('async function sendLinkMessage');
        assert.ok(sendStart !== -1, 'terminals.js must define sendLinkMessage (the link-up sender)');
        assert.ok(
            /clearBeforePrompt:\s*false/.test(js.slice(sendStart, sendStart + 4000)),
            'sendLinkMessage must post an explicit clearBeforePrompt: false — omitting it applies the '
            + 'config default (true) and wipes the parent agent before it is asked to relay.'
        );
    });

    await test('the clear-settle delay is PARTITIONED by delivery channel, not shared', () => {
        // One key served two channels with different physics. The PTY path writes straight
        // to the pty master fd; the vscode.Terminal path goes through a clipboard round
        // trip, focus acquisition and extension-host IPC — which is where 2000ms was
        // earned. Lowering the shared contributed default would have silently retuned the
        // slow path on ~4,000 shipped installs; lowering only the code fallbacks would
        // have been INERT, because a contributed default preempts get(key, fallback)'s
        // second argument. Hence a second key, and hence this partition assertion.
        const provider = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        const kanban = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        // The resolver was extracted out of TaskViewerProvider into its own module so
        // the standalone host reads the SAME precedence rule. "ONE place" is now that
        // module — assert against it, not against wherever it used to be inlined.
        const resolver = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'ptyClearPolicy.ts'), 'utf8');

        assert.ok(
            /export function resolvePtyClearDelay\(/.test(resolver)
            && /export function resolvePtyClearPolicy\(/.test(resolver),
            'resolvePtyClearDelay/resolvePtyClearPolicy must live in ptyClearPolicy.ts — '
            + 'the fallback rule has to live in ONE place'
        );
        assert.ok(
            /from '\.\/ptyClearPolicy'/.test(provider),
            'TaskViewerProvider must consume the shared resolver, not re-declare its own'
        );
        // inspect(), not get(): get() cannot tell "operator set 2000" from "contributed
        // default is 2000", and `!== undefined` rather than a truthy test because both
        // keys allow an explicit 0.
        assert.ok(
            /\.inspect<number>\('terminal\.ptyClearBeforePromptDelay'\)/.test(resolver)
            && /\.inspect<number>\('terminal\.clearBeforePromptDelay'\)/.test(resolver),
            'the resolver must use inspect() for BOTH keys — get() cannot distinguish an '
            + 'operator-set value from a contributed default'
        );
        assert.ok(
            /!==\s*undefined/.test(resolver) && !/if\s*\(\s*scoped\s*\)/.test(resolver),
            'scope values must be tested with !== undefined — an operator who deliberately '
            + 'sets 0 would read as unset under a truthy check'
        );

        // Every ptySendPrompt arm resolves through the policy — never a bare literal.
        // `defaultDelay` is the local binding the injection block derives from
        // resolvePtyClearPolicy(); the arms must read it, and must also carry the
        // Auto/Manual mode, or the child falls back to Auto for a Manual operator.
        assert.ok(
            /const policy = resolvePtyClearPolicy\(/.test(provider)
            && /const defaultDelay = policy\.mode === 'manual' \? policy\.delayMs : policy\.unknownDelayMs;/.test(provider),
            'the ptySendPrompt injection block must derive its delay from resolvePtyClearPolicy'
        );
        const ptyArms = (provider.match(/clearBeforePromptDelayMs:\s*payload\.clearBeforePromptDelayMs \?\? defaultDelay,/g) || []).length;
        assert.ok(
            ptyArms >= 2,
            `both ptySendPrompt injection arms must resolve the delay from the policy, found ${ptyArms}. `
            + 'The omitted-field branch is a second PTY-channel read; moving only the first '
            + 'leaves part of the path on 2000ms with every check green.'
        );
        const modeArms = (provider.match(/clearReadinessMode:/g) || []).length;
        assert.ok(
            modeArms >= 3,
            `every ptySendPrompt arm must carry clearReadinessMode, found ${modeArms}. `
            + 'An arm that omits it silently downgrades a Manual operator to Auto detection '
            + 'in the child, with every gate green.'
        );
        // …and the vscode.Terminal sites keep the legacy key and its 2000ms default.
        const legacyReads = (provider.match(/get<number>\('terminal\.clearBeforePromptDelay',\s*2000\)/g) || []).length;
        assert.ok(
            legacyReads >= 2,
            `the clipboard/sendRobustText sites must keep reading terminal.clearBeforePromptDelay `
            + `at 2000, found ${legacyReads} in TaskViewerProvider`
        );
        assert.ok(
            /get<number>\('terminal\.clearBeforePromptDelay',\s*2000\)/.test(kanban),
            'KanbanProvider\'s cache is the vscode.Terminal path and must stay on the legacy key'
        );

        const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
        const props = pkg.contributes.configuration.properties;
        assert.strictEqual(
            props['switchboard.terminal.clearBeforePromptDelay'].default, 2000,
            'the legacy key must keep default 2000 — a "cleanup" that harmonises the two keys '
            + 'silently retunes the clipboard path on every shipped install'
        );
        assert.strictEqual(
            props['switchboard.terminal.ptyClearBeforePromptDelay'].default, 600,
            'the PTY-scoped key must declare default 600 — the inline fallback alone is inert'
        );
    });

    await test('claudeInlineRendering is resolved host-side and reaches EVERY create path', () => {
        // ptyHost.ts runs in a child process with no vscode API and no configProvider, so
        // the flag has to arrive as a boolean on the wire. Two silent failure modes: wiring
        // one host leaves half the install base unfixed, and wiring only the two verb arms
        // leaves delegates, group heads and the auto-create paths spawning on Claude's
        // alternate screen — both with every gate green.
        const provider = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        const boot = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'bootstrap.ts'), 'utf8');
        const child = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'ptyHost.ts'), 'utf8');
        const fleet = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'ptyFleetService.ts'), 'utf8');

        const hostReads = (provider.match(/get<boolean>\('terminal\.claudeInlineRendering',\s*true\)/g) || []).length;
        assert.ok(hostReads >= 3,
            `the extension host must resolve terminal.claudeInlineRendering for ptyCreateTerminal, `
            + `ptyCreateBatch AND the agent-group head (which calls _ptyHostVerb directly, below `
            + `handlePtyVerb's injection), found ${hostReads}`);
        const bootReads = (boot.match(/getConfigBoolean\('terminal\.claudeInlineRendering',\s*true\)/g) || []).length;
        assert.ok(bootReads >= 3,
            `the standalone host must resolve it for ptyCreateTerminal, ptyCreateBatch and the `
            + `fleet-wide resolver, found ${bootReads}`);
        assert.ok(/setClaudeInlineRenderingResolver\(/.test(boot),
            'bootstrap must install the fleet-wide resolver — board dispatch, send-by-name, '
            + 'memo→planner and agent-group heads all call create() with no options');

        const childPassThrough = (child.match(/payload\.claudeInlineRendering !== false/g) || []).length;
        assert.ok(childPassThrough >= 2,
            `ptyHost.ts must forward the boolean in BOTH the create and batch arms, found ${childPassThrough}`);

        assert.ok(/claudeInlineRendering:\s*parent\.claudeInlineRendering/.test(fleet),
            'spawnDelegates must inherit the head\'s decision — a head rendering inline while '
            + 'its team members sit on the alternate screen is the reported bug, half fixed');
        assert.ok(/\?\?\s*\(this\._claudeInlineRenderingResolver/.test(fleet),
            'create() must fall back to the host resolver with ?? (not ||), so an explicit '
            + 'false from a verb arm still wins');

        // Precedence is the whole operator-override argument and is invisible to any
        // behavioural test that does not set a host env var.
        assert.ok(
            /env:\s*\{\s*\.\.\.claudeEnvDefaults,\s*\.\.\.process\.env,\s*\.\.\.switchboardEnv\s*\}/.test(fleet),
            'the env spread must be { ...claudeEnvDefaults, ...process.env, ...switchboardEnv } in '
            + 'that order: defaults lowest so process.env wins per variable, process.env present '
            + 'or the shell launches with no PATH/HOME/SHELL, seat identity last'
        );
        assert.ok(
            /CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN:\s*'1'/.test(fleet)
            && /CLAUDE_CODE_DISABLE_MOUSE:\s*'1'/.test(fleet)
            && !/CLAUDE_CODE_DISABLE_MOUSE_CLICKS/.test(fleet),
            'DISABLE_MOUSE is the correct variable — DISABLE_MOUSE_CLICKS preserves wheel '
            + 'capture, which is exactly the half of the symptom that must go'
        );
        assert.ok(!/payload\.env/.test(child),
            'never accept free-form env off the wire — every pty child holds an API token'
        );

        const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
        assert.strictEqual(
            pkg.contributes.configuration.properties['switchboard.terminal.claudeInlineRendering'].default,
            true,
            'switchboard.terminal.claudeInlineRendering must ship default true'
        );
    });

    if (failures > 0) {
        console.error(`\n${failures} contract check(s) failed.\n`);
        process.exit(1);
    }
    console.log('\nAll PTY route surface checks passed.\n');
})();
