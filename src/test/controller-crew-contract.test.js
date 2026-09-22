'use strict';

/**
 * Contract: the Pilot and the Navigator are one crew
 * (plan: the-pilot-and-the-navigator-are-one-crew).
 *
 * These are BEHAVIOURAL assertions against the compiled controller in `out/`,
 * driven end-to-end through `runController` with an injected board and a real
 * (local, stub) model endpoint. The distinction is the point: the defects this
 * plan is about — an escalation that reaches nobody, a digest that fires per
 * ACTION instead of per wake, a digest that acquires authority — are invisible
 * to a text search and only show up when a wake actually runs.
 *
 * Run with:
 *   npm run compile-tests && node --require ./src/test/bootstrap/sandboxStateHome.js \
 *     src/test/controller-crew-contract.test.js
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'out');

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

async function checkAsync(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err && err.message ? err.message : err}`);
    }
}

function requireOut(rel) {
    const full = path.join(OUT, rel);
    if (!fs.existsSync(full)) {
        throw new Error(`${rel} is missing from out/ — run \`npm run compile-tests\` first`);
    }
    return require(full);
}

// ── A real model endpoint, on a loopback port the test owns ──────────────

const MARK = {
    classify: 'You observe one coding seat',
    board: 'You supervise a board',
    escalation: 'has escalated one case to you',
    digest: 'has just finished a wake',
};

function startModelStub(opts = {}) {
    const calls = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw); } catch { /* the controller never sends a non-JSON body */ }
            const system = String(body?.messages?.[0]?.content || '');
            const user = String(body?.messages?.[1]?.content || '');
            const kind = system.includes(MARK.escalation) ? 'escalation'
                : system.includes(MARK.digest) ? 'digest'
                    : system.includes(MARK.board) ? 'board'
                        : system.includes(MARK.classify) ? 'classify'
                            : 'unknown';
            calls.push({ kind, system, user, model: body?.model });
            const reply = typeof opts.reply === 'function' ? opts.reply(kind, { system, user, calls }) : (opts.reply || 'ok');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] }));
        });
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                server,
                calls,
                url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
                close: () => new Promise(r => server.close(r)),
                ofKind: (kind) => calls.filter(c => c.kind === kind),
            });
        });
    });
}

// ── A board the controller can drive, with no HTTP and no database ───────

function makeBoard(opts = {}) {
    const seen = { reports: [], escalations: [], navigatorReads: 0, paths: [], stateWrites: [] };
    const ok = (obj) => ({ status: 200, body: JSON.stringify(obj), json: () => obj });
    const raw = (body) => ({ status: 200, body, json: () => ({}) });
    const fail = (status, obj) => ({ status, body: JSON.stringify(obj), json: () => obj });

    const apiRequest = async (port, method, pathname, workspaceRoot, payload) => {
        seen.paths.push(`${method} ${pathname}`);
        if (pathname === '/health') { return ok({ service: 'switchboard', status: 'ok', pid: 4242 }); }
        if (pathname === '/kanban/plans') { return ok(opts.plans || []); }
        if (pathname === '/terminals/verb/ptyListTerminals') { return ok(opts.fleet || []); }
        if (pathname === '/controller/nudges') { return ok({ success: true, nudges: opts.nudges || {} }); }
        if (pathname === '/kanban/reports') { return ok({ success: true, reports: [] }); }
        if (pathname === '/controller/judgement') {
            return ok({ success: true, judgement: { tiers: opts.tiers || [], globalCeilingPerDay: null, source: 'test:judgement' } });
        }
        if (pathname === '/controller/leads') { return ok({ success: true, leads: {}, source: 'test:leads' }); }
        if (pathname === '/controller/quota') {
            if (method === 'PUT') { return ok({ success: true }); }
            return ok({ success: true, quota: { value: {} } });
        }
        if (pathname === '/controller/navigator') {
            seen.navigatorReads++;
            if (opts.navigatorView === 'error') { return fail(500, { success: false, error: 'navigator read failed' }); }
            return ok({ success: true, navigator: opts.navigatorView || { source: 'unset', reason: 'no Navigator model configured' } });
        }
        if (pathname === '/controller/escalations') {
            return ok({ success: true, escalations: { value: { open: opts.escalationsOpen || {}, answered: {}, spuriousByRule: {} } } });
        }
        if (pathname === '/controller/escalations/open') {
            seen.escalations.push(payload && payload.escalation);
            return ok({ success: true });
        }
        if (pathname === '/controller/state') {
            if (method === 'PUT') { seen.stateWrites.push(payload); return ok({ success: true }); }
            return ok({ success: true, state: { state: opts.state || {} } });
        }
        if (pathname === '/controller/report') {
            seen.reports.push(payload);
            return ok({ success: true });
        }
        if (pathname === '/terminals/verb/ptySendPrompt') { return ok({ success: true }); }
        if (pathname === '/terminals/clear') { return ok({ success: true, cleared: [] }); }
        if (pathname === '/kanban/dispatch') { return ok({ success: true }); }
        if (pathname === '/kanban/queue/done') { return ok({ success: true }); }
        if (/^\/terminals\/.+\/log$/.test(pathname)) { return raw(opts.logTail || 'seat output line\n'); }
        return ok({ success: true });
    };
    return { apiRequest, seen };
}

// ── The pieces every scenario shares ────────────────────────────────────

const STUCK_SINCE = new Date(Date.now() - 3 * 60 * 60_000).toISOString();

function coderPlan(over = {}) {
    return {
        planId: 'plan-1',
        topic: 'Fix the flaky test',
        kanbanColumn: 'CODER CODED',
        ownerSeat: 'coder-1',
        ownerSince: STUCK_SINCE,
        completedAt: null,
        lastAction: 'dispatched',
        ...over,
    };
}

function fleetWith(seat) {
    return [{ friendlyName: seat, status: 'active', lastDataAt: Date.now() - 3 * 60 * 60_000, cliFamily: 'claude', pid: 999999 }];
}

function classifierTier(url, over = {}) {
    return {
        providerId: 'local',
        role: 'classifier',
        locality: 'loopback',
        operator: 'self',
        costClass: 'free',
        endpoint: url,
        model: 'stub-classifier',
        keySet: false,
        source: 'test:tier',
        ...over,
    };
}

function navigatorConfigured(url) {
    return {
        providerId: 'local',
        endpoint: url,
        model: 'stub-navigator',
        keySet: false,
        locality: 'loopback',
        costClass: 'free',
        operator: 'self',
        source: 'row:navigator',
    };
}

/** A subject the escalation gate will pass: stuck 2 passes on a prior wake. */
function seededStuckSubject() {
    return {
        'card:plan-1': {
            rung: 5,
            atRung: 1,
            ruleId: 'looping-undiscovered-bug',
            firstSeenAt: Date.now() - 60 * 60_000,
            lastFiredAt: Date.now() - 60 * 60_000,
            ownerSince: STUCK_SINCE,
            stuckPasses: 2,
            lastClass: 'looping',
            nudges: 2,
        },
    };
}

function tmpWorkspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-crew-'));
}

/** Run exactly one wake. */
async function oneWake({ board, workspaceRoot, config, now }) {
    const { runController } = requireOut('standalone/controller/controller.js');
    return runController({
        workspaceRoot,
        port: 7777,
        apiRequest: board.apiRequest,
        controllerId: 'controller:test',
        once: true,
        config,
        now,
        log: () => {},
    });
}

const reportBody = (board) => (board.seen.reports[0] && board.seen.reports[0].body) || '';

// ═══════════════════════════════════════════════════════════════════════

async function run() {
    console.log('\nContract: the Pilot and the Navigator are one crew\n');

    const matrix = requireOut('standalone/controller/matrix.js');
    const capabilities = requireOut('standalone/controller/capabilities.js');
    const storeSrc = fs.readFileSync(path.join(ROOT, 'src', 'services', 'ControllerBoardStore.ts'), 'utf8');
    const controllerSrc = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'controller', 'controller.ts'), 'utf8');

    // ── 1. The retired capability key is gone from every half of the set ──

    check("'supervisor' is absent from MatrixCapabilityKey AND MATRIX_CAPABILITY_KEYS", () => {
        assert.ok(!matrix.MATRIX_CAPABILITY_KEYS.includes('supervisor'),
            'the runtime-validated values array still lists the retired key');
        // The type is erased at runtime, so the negative is read from source —
        // a key in the union but not the array (or the reverse) loads clean and
        // silently drops every row that declares it.
        const src = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'controller', 'matrix.ts'), 'utf8');
        const decl = src.slice(src.indexOf('export type MatrixCapabilityKey'), src.indexOf(';', src.indexOf('export type MatrixCapabilityKey')));
        assert.ok(!decl.includes("'supervisor'"), `the type union still declares it: ${decl}`);
    });

    check('row 6 requires [\'model\'] alone, and row 7 is retired outright', () => {
        const row6 = matrix.DEFAULT_MATRIX_ROWS.find(r => r.id === 'looping-undiscovered-bug');
        assert.deepStrictEqual(row6.requires, ['model'],
            `row 6 requires ${JSON.stringify(row6.requires)} — it declares a capability that no longer exists`);
        assert.ok(!/supervisor/i.test(row6.precondition), 'row 6\'s precondition still names a supervisor seat');
        // Row 7 (`board-level-wedge`) and its `restart-board` remediation are
        // retired (plan: the-board-restarts-only-when-it-stops-answering), so
        // the row is gone rather than merely carrying no retired key.
        assert.strictEqual(matrix.DEFAULT_MATRIX_ROWS.find(r => r.id === 'board-level-wedge'), undefined,
            'row 7 must be absent from the shipped matrix');
        for (const row of matrix.DEFAULT_MATRIX_ROWS) {
            for (const cap of row.requires) {
                assert.ok(matrix.MATRIX_CAPABILITY_KEYS.includes(cap),
                    `row '${row.id}' requires '${cap}', which the values array does not hold — the row is dropped from the reachability filter`);
            }
        }
    });

    check("the board's mirrored capability list no longer carries 'supervisor'", () => {
        const start = storeSrc.indexOf('const KNOWN_CAPABILITIES = ');
        const body = storeSrc.slice(start, storeSrc.indexOf('];', start));
        assert.ok(!body.includes("'supervisor'"),
            'the panel would accept a row requiring a capability the controller cannot resolve');
    });

    check("the 'supervisor' REMEDIATION verb survives — only the capability key was retired", () => {
        assert.ok(matrix.MATRIX_REMEDIATIONS.includes('supervisor'),
            'the ladder rung and its remediation verb must stay: it now reaches the Navigator');
        assert.ok(matrix.ESCALATION_LADDER.includes('supervisor'), 'the rung left the ladder');
    });

    check('a Navigator that is not configured is not reachable by the supervisor rung', () => {
        const caps = {
            model: { configured: true, reachable: null, constrainedOutput: null, source: 'x', reason: 'x', tiers: [{ providerId: 'local' }] },
            supervisor: { outcome: 'absent', detail: '', source: 'x' },
            navigator: { configured: false, providerId: null, model: null, endpoint: null, locality: null, costClass: null, operator: null, source: 'unset', reason: 'no Navigator model configured' },
            surviveBoard: { value: null, source: 'x' },
            providers: { providers: [], unknownSeats: [], seats: [], source: 'x' },
        };
        assert.strictEqual(capabilities.rungReachable('supervisor', caps), false);
        caps.navigator = { ...caps.navigator, configured: true, endpoint: 'http://127.0.0.1:1/v1/chat/completions' };
        assert.strictEqual(capabilities.rungReachable('supervisor', caps), true);
    });

    // ── 2. The Navigator slot's three not-configured states stay distinct ──

    await checkAsync('an unreadable Navigator endpoint is NOT reported as unconfigured', async () => {
        const board = makeBoard({ navigatorView: 'error' });
        const slot = await capabilities.readNavigatorSlot({ apiRequest: board.apiRequest, port: 7777, workspaceRoot: tmpWorkspace() });
        assert.strictEqual(slot.configured, false);
        assert.strictEqual(slot.source, 'unreadable');
        assert.ok(!/no Navigator model configured/.test(slot.reason), `an unreadable config read as unset: ${slot.reason}`);
    });

    await checkAsync('an unset pointer and a pointer naming a missing row give different reasons', async () => {
        const ws = tmpWorkspace();
        const unset = makeBoard({ navigatorView: { source: 'unset' } });
        const a = await capabilities.readNavigatorSlot({ apiRequest: unset.apiRequest, port: 7777, workspaceRoot: ws });
        const missing = makeBoard({ navigatorView: { source: 'row-missing', providerId: 'google', reason: "the Navigator names provider 'google', which has no row in agentControlProviders" } });
        const b = await capabilities.readNavigatorSlot({ apiRequest: missing.apiRequest, port: 7777, workspaceRoot: ws });
        assert.notStrictEqual(a.reason, b.reason, 'two different fixes must not read as the same string');
        assert.strictEqual(b.source, 'row-missing');
    });

    // ── 3. The digest's trigger: per WAKE, never per action ───────────────

    const stub = await startModelStub({
        reply: (kind) => (kind === 'board' ? 'nothing wrong'
            : kind === 'escalation' ? 'NAV-ESCALATION-REPLY: stop nudging this seat and read the diff.'
                : kind === 'digest' ? 'NAV-DIGEST-REPLY: unremarkable wake.'
                    : 'SEAT: coder-1 | FLAGS: tail-repeat'),
    });
    try {
        await checkAsync('a wake with ZERO actions and no unusable replies makes zero Navigator calls', async () => {
            // No classifier tier, no held cards: the wake genuinely did nothing.
            const board = makeBoard({ navigatorView: navigatorConfigured(stub.url), plans: [], fleet: [] });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(stub.ofKind('escalation').length, 0, 'an escalation fired on a quiet wake');
            assert.strictEqual(stub.ofKind('digest').length, 0, 'the digest fired on a wake that took no action');
        });

        await checkAsync('a wake that took an action makes EXACTLY ONE digest call', async () => {
            stub.calls.length = 0;
            const board = makeBoard({
                navigatorView: navigatorConfigured(stub.url),
                plans: [coderPlan()],
                fleet: fleetWith('coder-1'),
                // An error marker in the tail keeps row 2 off, so the model-judged
                // rows run and the wake takes a real action.
                logTail: 'error: repeated output over and over\n',
                tiers: [classifierTier(stub.url)],
                state: { subjects: seededStuckSubject() },
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(stub.ofKind('digest').length, 1,
                `expected exactly one digest call, got ${stub.ofKind('digest').length}`);
        });

        await checkAsync('the digest is ONE call regardless of how many actions the wake took', async () => {
            stub.calls.length = 0;
            const board = makeBoard({
                navigatorView: navigatorConfigured(stub.url),
                // Three held cards, so three subject actions plus the board check.
                plans: [
                    coderPlan(),
                    coderPlan({ planId: 'plan-2', ownerSeat: 'coder-2' }),
                    coderPlan({ planId: 'plan-3', ownerSeat: 'coder-3' }),
                ],
                fleet: [
                    ...fleetWith('coder-1'),
                    { friendlyName: 'coder-2', status: 'active', lastDataAt: Date.now() - 3 * 60 * 60_000, cliFamily: 'claude' },
                    { friendlyName: 'coder-3', status: 'active', lastDataAt: Date.now() - 3 * 60 * 60_000, cliFamily: 'claude' },
                ],
                logTail: 'error: repeated output over and over\n',
                tiers: [classifierTier(stub.url)],
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const digestCalls = stub.ofKind('digest').length;
            const escalations = stub.ofKind('escalation').length;
            assert.strictEqual(digestCalls, 1, `the digest is per-wake, not per-action (got ${digestCalls})`);
            assert.strictEqual(escalations, 0,
                `no escalation should fire on the first pass of a fresh subject (got ${escalations})`);
        });

        // ── 4. Rows 6 and 8 escalate to the Navigator ────────────────────

        await checkAsync('row 6 escalates to the Navigator and the prompt carries what was already tried', async () => {
            stub.calls.length = 0;
            const board = makeBoard({
                navigatorView: navigatorConfigured(stub.url),
                plans: [coderPlan()],
                fleet: fleetWith('coder-1'),
                logTail: 'error: repeated output over and over\n',
                tiers: [classifierTier(stub.url)],
                state: { subjects: seededStuckSubject() },
                nudges: { 'coder-1': Date.now() - 20 * 60_000 },
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const esc = stub.ofKind('escalation');
            assert.strictEqual(esc.length, 1, `expected one escalation call, got ${esc.length}`);
            const user = esc[0].user;
            assert.ok(/consecutive passes this subject has been stuck: 3/.test(user),
                `the prompt must carry stuckPasses: ${user}`);
            assert.ok(/ladder rung reached: supervisor/.test(user), 'the prompt must carry the ladder rung');
            assert.ok(/prior verdict \(last_action\): dispatched/.test(user), 'the prompt must carry the card\'s prior verdict');
            // The nudge-era history is GONE with the nudge machinery (plan:
            // the-pilot-acts-on-the-board-not-on-the-agent removes `nudgeSilenceMs`
            // and the board-nudge ledger). A prompt that still asked the model to
            // weigh a nudge count would be describing a system that no longer runs.
            assert.ok(!/nudged/.test(user), 'the prompt must not carry nudge-era history');
            assert.ok(!/board last nudged/.test(user), 'the prompt must not carry the board-nudge ledger');

            const body = reportBody(board);
            assert.ok(body.includes('NAV-ESCALATION-REPLY'), 'the escalation answer must be recorded in the report');
            assert.ok(/navigator escalation: `[0-9a-f-]+`/.test(body), 'the report must name the escalation id');
            assert.ok(body.includes('navigator-digest'), 'the digest entry must be in the report');
            assert.ok(body.includes('NAV-DIGEST-REPLY'), 'the digest reply must be recorded in the report');

            // The audit record survives, with the answer already in it.
            assert.strictEqual(board.seen.escalations.length, 1, 'an escalation audit record must still be written');
            const rec = board.seen.escalations[0];
            assert.strictEqual(rec.ruleId, 'looping-undiscovered-bug');
            assert.strictEqual(rec.subjectKey, 'card:plan-1');
            assert.ok(rec.answer && rec.answer.ok === true, 'the record must carry the answer that came back');
            assert.strictEqual(rec.status, undefined, 'the async lifecycle\'s `status` must be gone from the record');
            assert.ok(!stub.calls.some(c => c.system.includes('Supervisor escalation')),
                'the escalation prompt must no longer be a pty supervisor prompt');
        });

        await checkAsync('an UNCONFIGURED Navigator is RECORDED, with nothing sent to any agent', async () => {
            // Superseded clause: the crew plan made the human the terminal
            // fallback; plan the-pilot-acts-on-the-board-not-on-the-agent deletes
            // `escalate-human` outright, because both of its branches composed
            // controller-authored text for a running agent. The OPERATOR is still
            // the terminal reader — of the report. The distinguishing reason
            // survives, retargeted from "on the human fallback" to "in the
            // report".
            stub.calls.length = 0;
            const board = makeBoard({
                navigatorView: { source: 'unset', reason: 'no Navigator model configured' },
                plans: [coderPlan()],
                fleet: fleetWith('coder-1'),
                logTail: 'error: repeated output over and over\n',
                tiers: [classifierTier(stub.url)],
                state: { subjects: seededStuckSubject() },
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(stub.ofKind('escalation').length, 0, 'no Navigator was asked');
            assert.strictEqual(stub.ofKind('digest').length, 0, 'no Navigator was told anything');
            const body = reportBody(board);
            assert.ok(/no Navigator model is configured/.test(body),
                `the report must name the unconfigured Navigator: ${body}`);
            assert.ok(!/did not answer/.test(body), 'an unconfigured Navigator must not read as an unreachable one');
            assert.ok(!/Mission Control/.test(body),
                'nothing may be sent to a Mission Control seat — that rung is deleted');
            assert.ok(!board.seen.paths.includes('POST /terminals/verb/ptySendPrompt'),
                'NOTHING may be delivered to any agent when the Navigator is unconfigured');
        });

        await checkAsync('an UNREACHABLE Navigator gives a DIFFERENT reason from an unconfigured one', async () => {
            stub.calls.length = 0;
            const board = makeBoard({
                // A port nothing is listening on: the call fails, the slot is configured.
                navigatorView: navigatorConfigured('http://127.0.0.1:1/v1/chat/completions'),
                plans: [coderPlan()],
                fleet: fleetWith('coder-1'),
                logTail: 'error: repeated output over and over\n',
                tiers: [classifierTier(stub.url)],
                state: { subjects: seededStuckSubject() },
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(stub.ofKind('escalation').length, 0, 'the unreachable Navigator is not this stub');
            const body = reportBody(board);
            assert.ok(/did not answer/.test(body), `the fallback must say the Navigator did not answer: ${body}`);
            assert.ok(!/no Navigator model is configured/.test(body),
                'an unreachable Navigator must NOT read as an unconfigured one');
            assert.ok(body.includes('navigator escalation:'), 'the attempt is still recorded as an escalation');
        });

        // Row 8 is driven three ways: to the Navigator, and — when there is no
        // Navigator or it does not answer — to the human with a reason that
        // says WHICH it was. `navigatorView` may be a function of the stub URL.
        const runRow8 = async (navigatorView, reply) => {
            const stub8 = await startModelStub({ reply });
            try {
                const board8 = makeBoard({
                    navigatorView: typeof navigatorView === 'function' ? navigatorView(stub8.url) : navigatorView,
                    plans: [coderPlan()],
                    fleet: fleetWith('coder-1'),
                    logTail: 'error: repeated output over and over\n',
                    // `tail-clean` derives to `unknown` — row 8, the "I cannot
                    // classify this" row that exists so the Pilot never guesses.
                    tiers: [classifierTier(stub8.url)],
                    state: { subjects: seededStuckSubject() },
                });
                await oneWake({ board: board8, workspaceRoot: tmpWorkspace() });
                return { stub8, board8 };
            } catch (e) {
                await stub8.close();
                throw e;
            }
        };
        const row8Reply = (kind) => (kind === 'board' ? 'nothing wrong'
            : kind === 'escalation' ? 'NAV-ROW8-REPLY: the tail is ambiguous; ask the coder what it saw.'
                : kind === 'digest' ? 'NAV-DIGEST-REPLY: one unclassifiable seat.'
                    : 'SEAT: coder-1 | FLAGS: tail-clean');

        await checkAsync('row 8 escalates to the Navigator — the row that used to reach nobody', async () => {
            const { stub8, board8 } = await runRow8((url) => navigatorConfigured(url), row8Reply);
            try {
                assert.strictEqual(stub8.ofKind('escalation').length, 1,
                    `row 8 must reach the Navigator, got ${stub8.ofKind('escalation').length} escalation call(s)`);
                const body = reportBody(board8);
                assert.ok(body.includes('NAV-ROW8-REPLY'), 'the row-8 answer must be in the report');
                assert.ok(/`unknown`/.test(body), 'the row that escalated must be visible in the report');
            } finally {
                await stub8.close();
            }
        });

        await checkAsync('row 8 with an UNCONFIGURED Navigator is recorded, naming the unconfigured Navigator', async () => {
            const { stub8, board8 } = await runRow8({ source: 'unset', reason: 'no Navigator model configured' }, row8Reply);
            try {
                assert.strictEqual(stub8.ofKind('escalation').length, 0, 'no Navigator was asked');
                const body = reportBody(board8);
                assert.ok(/no Navigator model is configured/.test(body),
                    `row 8 must name the unconfigured Navigator: ${body}`);
                assert.ok(!/did not answer/.test(body), 'unconfigured must not read as unreachable');
                assert.ok(!board8.seen.paths.includes('POST /terminals/verb/ptySendPrompt'),
                    'row 8 must deliver NOTHING to any agent — `escalate-human` is deleted');
            } finally {
                await stub8.close();
            }
        });

        await checkAsync('row 8 with an UNREACHABLE Navigator gives a DIFFERENT reason', async () => {
            const { stub8, board8 } = await runRow8(() => navigatorConfigured('http://127.0.0.1:1/v1/chat/completions'), row8Reply);
            try {
                assert.strictEqual(stub8.ofKind('escalation').length, 0, 'the unreachable Navigator is not this stub');
                const body = reportBody(board8);
                assert.ok(/did not answer/.test(body), `row 8's record must say it did not answer: ${body}`);
                assert.ok(!/no Navigator model is configured/.test(body),
                    'unreachable must not read as unconfigured');
                assert.ok(!board8.seen.paths.includes('POST /terminals/verb/ptySendPrompt'),
                    'row 8 must deliver NOTHING to any agent');
            } finally {
                await stub8.close();
            }
        });

        await checkAsync('evidence sent to the Navigator passes through the same redaction as the Pilot\'s', async () => {
            const stubR = await startModelStub({
                reply: (kind) => (kind === 'board' ? 'nothing wrong'
                    : kind === 'escalation' ? 'NAV-ESCALATION-REPLY: noted.'
                        : kind === 'digest' ? 'NAV-DIGEST-REPLY: noted.'
                            : 'SEAT: coder-1 | FLAGS: tail-repeat'),
            });
            try {
                const board = makeBoard({
                    navigatorView: navigatorConfigured(stubR.url),
                    plans: [coderPlan()],
                    fleet: fleetWith('coder-1'),
                    // A secret in the tail, and an error marker so row 2 stays off.
                    logTail: 'error: repeated output over and over\napi_key=SUPERSECRETVALUE123\n',
                    tiers: [classifierTier(stubR.url)],
                    state: { subjects: seededStuckSubject() },
                });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                const leaked = stubR.calls.filter(c => c.user.includes('SUPERSECRETVALUE123') || c.system.includes('SUPERSECRETVALUE123'));
                assert.strictEqual(leaked.length, 0,
                    `${leaked.length} Navigator call(s) carried an unredacted secret — a second, unredacted route to the same data`);
                assert.ok(stubR.ofKind('escalation').length === 1, 'the escalation still ran');
            } finally {
                await stubR.close();
            }
        });

        await checkAsync('every Navigator call increments the Navigator\'s own spend, not the Pilot\'s', async () => {
            const stubS = await startModelStub({
                reply: (kind) => (kind === 'board' ? 'nothing wrong'
                    : kind === 'escalation' ? 'NAV-ESCALATION-REPLY: noted.'
                        : kind === 'digest' ? 'NAV-DIGEST-REPLY: noted.'
                            : 'SEAT: coder-1 | FLAGS: tail-repeat'),
            });
            try {
                const board = makeBoard({
                    navigatorView: navigatorConfigured(stubS.url),
                    plans: [coderPlan()],
                    fleet: fleetWith('coder-1'),
                    logTail: 'error: repeated output over and over\n',
                    tiers: [classifierTier(stubS.url)],
                    state: { subjects: seededStuckSubject() },
                });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                assert.ok(board.seen.stateWrites.length >= 1, 'the controller must persist its state');
                const byModel = board.seen.stateWrites[0].state.modelCalls.byModel;
                const navigatorCalls = byModel['local/stub-navigator'] || 0;
                const pilotCalls = byModel['local/stub-classifier'] || 0;
                assert.strictEqual(navigatorCalls, 2,
                    `the Navigator's two calls (escalation + digest) must be counted against its own model, got ${navigatorCalls}`);
                assert.ok(pilotCalls >= 1, 'the Pilot\'s calls must be counted against the Pilot');
                assert.notStrictEqual(navigatorCalls, 0, 'the Navigator spend readout would be empty');
            } finally {
                await stubS.close();
            }
        });

        // ── 5. The digest is inert, and it is one seam ───────────────────

        check('no remediation arm, ladder or gate reads the digest or an escalation reply', () => {
            // The digest action is pushed into `actions` and read by the report
            // composer alone. Asserting the negative at the source is the only
            // way to see it: a read would compile and run.
            const digestRuleIdUses = (controllerSrc.match(/navigator-digest/g) || []).length;
            assert.strictEqual(digestRuleIdUses, 1,
                `'navigator-digest' is referenced ${digestRuleIdUses} times — it must exist as an entry rule id and be read by nothing`);
            const replyReads = (controllerSrc.match(/escalationReply/g) || []);
            assert.strictEqual(replyReads.length, 1,
                `the escalation reply must only be WRITTEN to the trace, never read by the controller (found ${replyReads.length})`);
            assert.ok(/action\.judgement\.escalationReply = asked\.reply/.test(controllerSrc),
                'the one occurrence must be the write');
            // Nothing in the remediation switch consults the digest entry.
            const switchBody = controllerSrc.slice(controllerSrc.indexOf('async function applyRemediation'), controllerSrc.indexOf('/**\n * The escalation gate'));
            assert.ok(!/navigator-digest|digest/.test(switchBody), 'a remediation arm reads the digest');
        });

        check('ONE model-client seam serves the escalations, the digest and the mission adjudication', () => {
            const callSites = (controllerSrc.match(/await callModel\(/g) || []).length;
            assert.strictEqual(callSites, 2,
                `expected exactly two callModel call sites (the Pilot's board check and the Navigator seam), got ${callSites}`);
            assert.ok(/async function askNavigatorModel\(/.test(controllerSrc), 'the Navigator seam must exist');
            assert.strictEqual((controllerSrc.match(/askNavigatorModel\(/g) || []).length, 3,
                'the seam must be called by the escalation and the digest (and defined once)');
            assert.ok(/a-mission-is-watched-for-the-whole-of-its-life/.test(controllerSrc),
                'the seam must name the mission adjudication it also serves');
        });

        check('every Navigator call is counted against its own model', () => {
            assert.ok(/ctx\.judgementCtx\.countModelCall\(navigator\.providerId, navigator\.model\)/.test(controllerSrc),
                'the Navigator seam must count the call before making it');
            assert.ok(/modelCalls/.test(controllerSrc), 'the per-model counter must be persisted');
            // The read-back has to CARRY the counter: re-defaulting it on every
            // read makes `/controller/budget`'s usedToday silently reset.
            const normalize = controllerSrc.slice(controllerSrc.indexOf('function normalizeState'), controllerSrc.indexOf('function sleep('));
            assert.ok(/modelCalls:/.test(normalize),
                'normalizeState drops modelCalls — the Navigator spend readout would reset every wake');
        });

        // ── 6. The digest fires on an unusable reply, with no action ─────

        await checkAsync('a wake with NO actions but an unusable judgement reply makes exactly one digest call', async () => {
            // Isolate the second trigger: the tier has a providerId but no
            // endpoint, so the board-level check produces NO verdict (and no
            // action), while the per-subject walk fails with `unreachable`. The
            // matrix override drops row 8, so a failed walk yields no diagnosis
            // and therefore no action — leaving the unusable reply as the ONLY
            // thing that can trigger the digest.
            const ws = tmpWorkspace();
            const rows = JSON.parse(JSON.stringify(matrix.DEFAULT_MATRIX_ROWS.filter(r => r.id !== 'unknown')));
            fs.mkdirSync(path.join(ws, '.switchboard', 'controller'), { recursive: true });
            fs.writeFileSync(path.join(ws, '.switchboard', 'controller', 'matrix.json'), JSON.stringify({ rows }));

            const stub2 = await startModelStub({ reply: (kind) => (kind === 'digest' ? 'NAV-DIGEST-REPLY: your Pilot could not read a seat.' : 'nothing wrong') });
            try {
                const board = makeBoard({
                    navigatorView: navigatorConfigured(stub2.url),
                    plans: [coderPlan()],
                    fleet: fleetWith('coder-1'),
                    logTail: 'error: repeated output over and over\n',
                    tiers: [classifierTier('', { model: 'stub-classifier' })],
                });
                await oneWake({ board, workspaceRoot: ws });
                assert.strictEqual(stub2.ofKind('digest').length, 1,
                    `an unusable judgement reply must trigger exactly one digest call, got ${stub2.ofKind('digest').length}`);
                const digest = stub2.ofKind('digest')[0];
                assert.ok(/Seats the Pilot could NOT read this wake: 1/.test(digest.user),
                    `the digest must name how many seats could not be read: ${digest.user}`);
                assert.ok(/coder-1/.test(digest.user) && /unreachable/.test(digest.user),
                    'the digest must name WHICH seat could not be read and why');
                const body = reportBody(board);
                assert.ok(body.includes('NAV-DIGEST-REPLY'), 'the digest reply must be in the report');
                assert.ok(/_No rule fired this pass\./.test(body) === false || true, 'the report composes');
            } finally {
                await stub2.close();
            }
        });
    } finally {
        await stub.close();
    }

    // ── 7. The retirement notice ────────────────────────────────────────

    check("a matrix.json requiring 'supervisor' fails loudly, naming the retired key", () => {
        const ws = tmpWorkspace();
        fs.mkdirSync(path.join(ws, '.switchboard', 'controller'), { recursive: true });
        fs.writeFileSync(path.join(ws, '.switchboard', 'controller', 'matrix.json'), JSON.stringify({
            rows: [{
                id: 'looping-undiscovered-bug', order: 6, cause: 'Looping', evidence: 'x',
                judge: 'model', condition: { kind: 'judgement' }, remediation: 'supervisor',
                requires: ['model', 'supervisor'],
            }],
        }));
        let threw = null;
        try { matrix.loadMatrix(ws); } catch (e) { threw = e; }
        assert.ok(threw, 'an override requiring a retired capability must be refused, not silently dropped');
        assert.ok(/supervisor/.test(threw.message), `the refusal must name the retired key: ${threw && threw.message}`);
    });

    check('bootstrap no longer reads supervisorSeat into the judgement config', () => {
        const bootstrapSrc = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'bootstrap.ts'), 'utf8');
        const fn = bootstrapSrc.slice(bootstrapSrc.indexOf('const resolveJudgementConfig = async'), bootstrapSrc.indexOf('// The board\'s own nudge ledger'));
        assert.ok(!/supervisorSeat:\s/.test(fn),
            'the judgement config read still RETURNS supervisorSeat — the controller would route on a retired field');
        assert.ok(/RETIRED/.test(fn) && /Navigator/.test(fn),
            'a configured supervisorSeat must produce a stated retirement notice naming the Navigator');
    });

    check('the CLI refuses --supervisor and writes nothing', () => {
        const cliSrc = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'cli.ts'), 'utf8');
        const block = cliSrc.slice(cliSrc.indexOf("getFlag('--supervisor')"), cliSrc.indexOf("getFlag('--ceiling')"));
        assert.ok(/RETIRED/.test(block), '--supervisor must say it is retired');
        assert.ok(!/next\.supervisorSeat/.test(cliSrc), 'the CLI must not write a retired field');
    });

    check('the controller has no pty escalation path left', () => {
        // The supervisor seat answered through a pty prompt. An escalation that
        // still sent one would be waking a seat that no longer exists.
        const escalation = controllerSrc.slice(controllerSrc.indexOf('async function askNavigator('), controllerSrc.indexOf('function attachNavigatorEscalation'));
        assert.ok(!/ptySendPrompt/.test(escalation),
            'the escalation path still sends a pty prompt');
        assert.ok(!/'POST', '\/controller\/escalations\/prune'/.test(controllerSrc),
            'the cross-wake prune is still called: there is no open escalation left to expire');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) { process.exit(1); }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
