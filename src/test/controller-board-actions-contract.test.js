'use strict';

/**
 * Contract: the Pilot acts on the board, not on the agent
 * (plan: the-pilot-acts-on-the-board-not-on-the-agent).
 *
 * Behavioural assertions against the compiled controller in `out/`, driven
 * end-to-end through `runController` with an injected board. The defects this
 * plan is about — a CR sent into a seat that is mid-ingestion, a re-delivery
 * that adds a marker and becomes a nudge, a ladder that re-applies its top rung
 * every wake forever — are invisible to a text search and only show up when a
 * wake actually runs.
 *
 * Run with:
 *   npm run compile-tests && node --require ./src/test/bootstrap/sandboxStateHome.js \
 *     src/test/controller-board-actions-contract.test.js
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

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

const sample = requireOut('standalone/controller/sample.js');
const matrix = requireOut('standalone/controller/matrix.js');
const controllerSrc = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'controller', 'controller.ts'), 'utf8');
const goMain = fs.readFileSync(path.join(ROOT, 'cmd', 'switchboard-pty-host', 'main.go'), 'utf8');
const bootstrapSrc = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'bootstrap.ts'), 'utf8');

// ── A board the controller can drive, with no HTTP and no database ───────

function makeBoard(opts = {}) {
    const seen = { paths: [], reports: [], dispatchBodies: [], terminalWrites: [], respawns: [] };
    let liveState = opts.state || {};
    const ok = (obj) => ({ status: 200, body: JSON.stringify(obj), json: () => obj });
    const raw = (body) => ({ status: 200, body, json: () => ({}) });

    const apiRequest = async (port, method, pathname, workspaceRoot, payload) => {
        seen.paths.push(`${method} ${pathname}`);
        if (pathname === '/health') { return ok({ service: 'switchboard', status: 'ok', pid: 4242 }); }
        if (pathname === '/kanban/plans') { return ok(opts.plans || []); }
        if (pathname === '/terminals/verb/ptyListTerminals') {
            // `fleetAfterFirst` models the RACE the re-check exists for: the seat
            // was idle when the wake read the fleet and resumed before delivery.
            seen.fleetReads = (seen.fleetReads || 0) + 1;
            if (seen.fleetReads > 1 && opts.fleetAfterFirst) { return ok(opts.fleetAfterFirst); }
            return ok(opts.fleet || []);
        }
        if (pathname === '/kanban/reports') { return ok({ success: true, reports: [] }); }
        if (pathname === '/controller/judgement') {
            return ok({ success: true, judgement: { tiers: opts.tiers || [], globalCeilingPerDay: null, source: 'test:judgement' } });
        }
        if (pathname === '/controller/quota') {
            if (method === 'PUT') { return ok({ success: true }); }
            return ok({ success: true, quota: { value: {} } });
        }
        if (pathname === '/controller/navigator') {
            return ok({ success: true, navigator: opts.navigatorView || { source: 'unset', reason: 'no Navigator model configured' } });
        }
        if (pathname === '/controller/escalations') {
            return ok({ success: true, escalations: { value: { open: {}, answered: {}, spuriousByRule: {} } } });
        }
        if (pathname === '/controller/escalations/open') { return ok({ success: true }); }
        if (pathname === '/controller/state') {
            if (method === 'PUT') { liveState = (payload && payload.state) || {}; return ok({ success: true }); }
            return ok({ success: true, state: { state: liveState } });
        }
        if (pathname === '/controller/report') { seen.reports.push(payload); return ok({ success: true }); }
        if (pathname === '/kanban/dispatch') {
            seen.dispatchBodies.push(payload);
            return ok({ success: true, delivery: 'delivered', moved: true, dispatched: true });
        }
        if (pathname === '/terminals/verb/ptyRespawnSeat') {
            seen.respawns.push(payload);
            return ok({ success: true, respawned: true, argvInjected: true, promptBytesWritten: 0 });
        }
        if (pathname === '/terminals/verb/ptyWrite') {
            seen.terminalWrites.push({ verb: 'ptyWrite', payload });
            return ok({ success: true });
        }
        if (pathname === '/terminals/verb/ptySendPrompt') {
            seen.terminalWrites.push({ verb: 'ptySendPrompt', payload });
            return ok({ success: true });
        }
        if (pathname === '/terminals/clear') { return ok({ success: true, cleared: [] }); }
        if (/^\/terminals\/.+\/log$/.test(pathname)) { return raw(opts.logTail !== undefined ? opts.logTail : 'still working on the problem\n'); }
        return ok({ success: true });
    };
    return { apiRequest, seen, state: () => liveState };
}

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

function tmpWorkspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-board-'));
}

async function oneWake({ board, workspaceRoot, config }) {
    const { runController } = requireOut('standalone/controller/controller.js');
    return runController({
        workspaceRoot,
        port: 7777,
        apiRequest: board.apiRequest,
        controllerId: 'controller:test',
        once: true,
        config,
        now: () => Date.now(),
        log: () => {},
    });
}

const reportBody = (board) => (board.seen.reports[0] && board.seen.reports[0].body) || '';
const lastReportBody = (board) => (board.seen.reports[board.seen.reports.length - 1] && board.seen.reports[board.seen.reports.length - 1].body) || '';

/**
 * A REAL idle process, so `/proc` yields a real CPU rate of zero.
 *
 * The CPU gate cannot be tested against a fabricated reading: `readProcessTable`
 * reads the host's own `/proc`, and an unavailable reading is deliberately NOT
 * "at rest". So the test spawns a genuinely idle child, seeds the previous
 * sample the controller would have carried from the last wake, and lets the
 * sampler compute a real 0%.
 */
function seedIdleSeat(pid, jiffies, startTime) {
    return { pid, startTime, jiffies, atMs: Date.now() - 60_000 };
}

function readProc(pid) {
    const line = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const row = sample.parseProcStat(line);
    if (!row) { throw new Error(`could not parse /proc/${pid}/stat`); }
    return row;
}

// ═══════════════════════════════════════════════════════════════════════

async function run() {
    console.log('\nContract: the Pilot acts on the board, not on the agent\n');

    // ── 1. The closed sets ────────────────────────────────────────────────

    check('the ladder opens bare-enter -> redeliver-dispatch -> respawn-seat and terminates at stop', () => {
        assert.deepStrictEqual(matrix.ESCALATION_LADDER.slice(0, 3),
            ['bare-enter', 'redeliver-dispatch', 'respawn-seat'],
            'the ladder must open with the three rungs of strictly increasing cost');
        assert.strictEqual(matrix.ESCALATION_LADDER[matrix.ESCALATION_LADDER.length - 1], 'stop',
            'the ladder must terminate at stop');
    });

    check("'nudge', 'report-to-lead', 'relay-answer' and 'escalate-human' are gone from all three places", () => {
        const decl = controllerSrc && fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'controller', 'matrix.ts'), 'utf8');
        const union = decl.slice(decl.indexOf('export type MatrixRemediation'), decl.indexOf(';', decl.indexOf('export type MatrixRemediation')));
        for (const gone of ['nudge', 'report-to-lead', 'relay-answer', 'escalate-human']) {
            assert.ok(!new RegExp(`'${gone}'`).test(union), `'${gone}' is still in the type union`);
            assert.ok(!matrix.MATRIX_REMEDIATIONS.includes(gone), `'${gone}' is still in the values array`);
            assert.ok(!matrix.ESCALATION_LADDER.includes(gone), `'${gone}' is still a rung`);
            assert.ok(!controllerSrc.includes(`case '${gone}':`), `'${gone}' still has a switch arm`);
        }
    });

    check("'clear-respawn' is renamed 'reset-context' everywhere", () => {
        const decl = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'controller', 'matrix.ts'), 'utf8');
        const union = decl.slice(decl.indexOf('export type MatrixRemediation'), decl.indexOf(';', decl.indexOf('export type MatrixRemediation')));
        assert.ok(!union.includes("'clear-respawn'"), 'the union still declares clear-respawn');
        assert.ok(!matrix.MATRIX_REMEDIATIONS.includes('clear-respawn'), 'the values array still declares clear-respawn');
        assert.ok(!matrix.ESCALATION_LADDER.includes('clear-respawn'), 'clear-respawn is still a rung');
        assert.ok(matrix.MATRIX_REMEDIATIONS.includes('reset-context'), 'reset-context must exist');
        assert.ok(controllerSrc.includes("case 'reset-context':"), 'reset-context needs a switch arm');
    });

    check('the rows carry the new remediations', () => {
        const row2 = matrix.DEFAULT_MATRIX_ROWS.find(r => r.id === 'idle-no-blocker');
        const row3 = matrix.DEFAULT_MATRIX_ROWS.find(r => r.id === 'waiting-on-human');
        const row9 = matrix.DEFAULT_MATRIX_ROWS.find(r => r.id === 'research-loop-no-write');
        const row4 = matrix.DEFAULT_MATRIX_ROWS.find(r => r.id === 'crashed-dead-process');
        assert.strictEqual(row2.remediation, 'bare-enter');
        assert.strictEqual(row3.remediation, 'supervisor');
        assert.strictEqual(row9.remediation, 'record-unknown');
        assert.strictEqual(row9.target, undefined, 'row 9 no longer targets the lead');
        assert.strictEqual(row4.remediation, 'reset-context');
    });

    check('every verb in the values array has a switch arm', () => {
        for (const verb of matrix.MATRIX_REMEDIATIONS) {
            assert.ok(controllerSrc.includes(`case '${verb}':`),
                `remediation '${verb}' has no switch arm — it would load and be inert at wake time`);
        }
    });

    check('an override naming a retired verb fails loudly, naming it', () => {
        for (const gone of ['nudge', 'report-to-lead', 'relay-answer', 'escalate-human']) {
            const ws = tmpWorkspace();
            fs.mkdirSync(path.join(ws, '.switchboard', 'controller'), { recursive: true });
            fs.writeFileSync(path.join(ws, '.switchboard', 'controller', 'matrix.json'), JSON.stringify({
                rows: [{ id: 'x', order: 1, cause: 'c', judge: 'model', condition: { kind: 'judgement' }, remediation: gone, requires: ['model'] }],
            }));
            let threw = null;
            try { matrix.loadMatrix(ws); } catch (e) { threw = e; }
            assert.ok(threw, `an override naming '${gone}' must be refused, not silently dropped`);
            assert.ok(threw.message.includes(gone), `the refusal must name '${gone}': ${threw.message}`);
        }
    });

    // ── 2. The controller composes no message ─────────────────────────────

    check('no controller-authored prompt text survives, and nothing calls ptySendPrompt', () => {
        for (const literal of ['continue and report', 'If you are blocked', 'switchboard:controller']) {
            assert.ok(!controllerSrc.includes(literal),
                `the controller still composes '${literal}'`);
        }
        assert.ok(!/ptySendPrompt/.test(controllerSrc),
            'the controller must have no ptySendPrompt call site at all — the only text it may deliver is the dispatch path\'s own output');
    });

    // ── 3. bare-enter ─────────────────────────────────────────────────────

    const idle = spawn('sleep', ['120'], { stdio: 'ignore' });
    const idleRow = readProc(idle.pid);

    await checkAsync('row 2 on a quiet, zero-CPU seat writes exactly one byte and nothing else', async () => {
        const board = makeBoard({
            plans: [coderPlan()],
            fleet: [{ friendlyName: 'coder-1', status: 'active', lastDataAt: Date.now() - 3 * 60 * 60_000, cliFamily: 'claude', pid: idle.pid }],
            state: { samples: { 'coder-1': seedIdleSeat(idle.pid, idleRow.jiffies, idleRow.startTime) } },
        });
        await oneWake({ board, workspaceRoot: tmpWorkspace() });
        const writes = board.seen.terminalWrites.filter(w => w.verb === 'ptyWrite');
        assert.strictEqual(writes.length, 1, `expected exactly one ptyWrite, got ${writes.length}`);
        const data = writes[0].payload.data;
        assert.strictEqual(data, '\r', `the payload must be a single CR, got ${JSON.stringify(data)}`);
        assert.strictEqual(Buffer.byteLength(data), 1, 'the payload must be exactly ONE byte');
        assert.ok(!writes[0].payload.slashCommand, 'a bare enter is not a slash command');
        assert.ok(!board.seen.terminalWrites.some(w => w.verb === 'ptySendPrompt'),
            'no prompt may be delivered to the seat');
        assert.ok(/bare-enter wrote 1 byte/.test(reportBody(board)), 'the report must record what was written');
    });

    await checkAsync('a seat with non-zero CPU receives NO bare-enter, however long it has been silent', async () => {
        const busy = spawn('node', ['-e', 'const t=Date.now(); while(Date.now()-t<30000){Math.sqrt(Math.random());}'], { stdio: 'ignore' });
        try {
            const before = readProc(busy.pid);
            // Seed a sample from a minute ago whose jiffy count is BELOW the
            // current one, so the sampler computes a real, non-zero rate.
            await new Promise(r => setTimeout(r, 400));
            const now = readProc(busy.pid);
            const board = makeBoard({
                plans: [coderPlan()],
                fleet: [{ friendlyName: 'coder-1', status: 'active', lastDataAt: Date.now() - 3 * 60 * 60_000, cliFamily: 'claude', pid: busy.pid }],
                state: { samples: { 'coder-1': { pid: busy.pid, startTime: before.startTime, jiffies: Math.max(0, before.jiffies - 50), atMs: Date.now() - 60_000 } } },
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(board.seen.terminalWrites.length, 0,
                'a seat that is burning CPU must receive NOTHING — a CR during ingestion can split a paste');
            assert.ok(now.jiffies >= 0);
        } finally {
            busy.kill('SIGKILL');
        }
    });

    // ── 4. redeliver-dispatch ─────────────────────────────────────────────

    await checkAsync('redeliver-dispatch goes through /kanban/dispatch, byte-identical by construction', async () => {
        const board = makeBoard({
            plans: [coderPlan()],
            fleet: [{ friendlyName: 'coder-1', status: 'active', lastDataAt: Date.now() - 3 * 60 * 60_000, cliFamily: 'claude', pid: idle.pid }],
            // The rung is already past bare-enter, so this wake applies
            // redeliver-dispatch.
            state: {
                samples: { 'coder-1': seedIdleSeat(idle.pid, idleRow.jiffies, idleRow.startTime) },
                subjects: { 'card:plan-1': { rung: 1, atRung: 0, ruleId: 'idle-no-blocker', firstSeenAt: 1, lastFiredAt: 1, ownerSince: STUCK_SINCE, stuckPasses: 3, lastClass: null } },
            },
        });
        await oneWake({ board, workspaceRoot: tmpWorkspace() });
        assert.strictEqual(board.seen.dispatchBodies.length, 1, 're-delivery must go through the dispatch route');
        const body = board.seen.dispatchBodies[0];
        // NO added content anywhere: the payload is the card, the seat, the
        // card's OWN column, and the repair flags. Nothing else.
        assert.deepStrictEqual(body, {
            plan: 'plan-1',
            targetColumn: 'CODER CODED',
            seat: 'coder-1',
            from: 'controller:test',
            skipClear: true,
            clearBeforePrompt: false,
        }, `the re-delivery payload must carry nothing of the controller's own: ${JSON.stringify(body)}`);
        assert.ok(!/switchboard:controller/.test(JSON.stringify(body)), 'no controller marker may be added');
        assert.strictEqual(board.seen.terminalWrites.length, 0,
            're-delivery must not write to the terminal directly — the dispatch path owns delivery');
    });

    await checkAsync('a delivery whose echo never appears is recorded UNVERIFIED, distinctly from delivered', async () => {
        const mk = (logTail) => makeBoard({
            plans: [coderPlan()],
            fleet: [{ friendlyName: 'coder-1', status: 'active', lastDataAt: Date.now() - 3 * 60 * 60_000, cliFamily: 'claude', pid: idle.pid }],
            logTail,
            state: {
                samples: { 'coder-1': seedIdleSeat(idle.pid, idleRow.jiffies, idleRow.startTime) },
                subjects: { 'card:plan-1': { rung: 1, atRung: 0, ruleId: 'idle-no-blocker', firstSeenAt: 1, lastFiredAt: 1, ownerSince: STUCK_SINCE, stuckPasses: 3, lastClass: null } },
            },
        });
        // Echo present: the CLI printed something after the delivery heading.
        // The heading is the log writer's own shape — `## <ISO> — <prompt>` —
        // not the callback's name.
        const echoed = mk('## 2026-09-22T01:02:03.004Z — Fix the flaky test\n\n> Reading the failing test now\n');
        await oneWake({ board: echoed, workspaceRoot: tmpWorkspace() });
        assert.ok(/delivery delivered/.test(reportBody(echoed)), `expected a delivered verdict: ${reportBody(echoed)}`);
        assert.ok(!/UNVERIFIED/.test(reportBody(echoed)), 'a verified delivery must not read as unverified');

        // Echo absent: the heading is there and NOTHING followed it — the
        // signature of an unsubmitted paste.
        const silent = mk('## 2026-09-22T01:02:03.004Z — Fix the flaky test\n');
        await oneWake({ board: silent, workspaceRoot: tmpWorkspace() });
        const body = reportBody(silent);
        assert.ok(/UNVERIFIED/.test(body), `expected an unverified verdict: ${body}`);
        assert.ok(/unsubmitted paste/.test(body), 'the report must say what an unverified delivery means');
        // Distinct outcomes, not merely distinct words: the action outcome differs.
        const echoedAction = /outcome: \*\*applied\*\*/.test(reportBody(echoed));
        const silentAction = /outcome: \*\*recorded\*\*/.test(body);
        assert.ok(echoedAction, 'a delivered re-delivery is `applied`');
        assert.ok(silentAction, 'an unverified re-delivery is `recorded`, not a silent success');
    });

    await checkAsync('a seat that resumed between diagnosis and delivery receives nothing', async () => {
        // The race the plan names: the seat was idle when the wake read the
        // fleet, and produced output before the re-delivery was sent. The
        // re-check reads the fleet AGAIN, which is the only reading that can
        // have changed.
        const board = makeBoard({
            plans: [coderPlan()],
            fleet: [{ friendlyName: 'coder-1', status: 'active', lastDataAt: Date.now() - 3 * 60 * 60_000, cliFamily: 'claude', pid: idle.pid }],
            fleetAfterFirst: [{ friendlyName: 'coder-1', status: 'active', lastDataAt: Date.now() - 500, cliFamily: 'claude', pid: idle.pid }],
            state: {
                samples: { 'coder-1': seedIdleSeat(idle.pid, idleRow.jiffies, idleRow.startTime) },
                subjects: { 'card:plan-1': { rung: 1, atRung: 0, ruleId: 'idle-no-blocker', firstSeenAt: 1, lastFiredAt: 1, ownerSince: STUCK_SINCE, stuckPasses: 3, lastClass: null } },
            },
        });
        await oneWake({ board, workspaceRoot: tmpWorkspace() });
        assert.strictEqual(board.seen.dispatchBodies.length, 0,
            'a seat that resumed must not be re-dispatched');
        assert.ok(/resumed on its own/.test(reportBody(board)), 'the report must say why nothing was sent');
        assert.strictEqual(board.seen.terminalWrites.length, 0, 'nothing may be written to the seat');
    });

    // ── 5. Row 3 — the question is CLASSIFIED, never answered ────────────

    function startNavigatorStub(reply) {
        const calls = [];
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', c => { raw += c; });
            req.on('end', () => {
                let body = {};
                try { body = JSON.parse(raw); } catch { /* never a non-JSON body from the controller */ }
                const system = String(body?.messages?.[0]?.content || '');
                const user = String(body?.messages?.[1]?.content || '');
                calls.push({ system, user });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { content: reply(system, user) }, finish_reason: 'stop' }] }));
            });
        });
        return new Promise(resolve => {
            server.listen(0, '127.0.0.1', () => resolve({
                url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
                calls,
                close: () => new Promise(r => server.close(r)),
            }));
        });
    }

    /** A row-3 wake: the Pilot answers `tail-question`, the Navigator classifies. */
    function row3Board(stub) {
        return makeBoard({
            plans: [coderPlan()],
            fleet: [{ friendlyName: 'coder-1', status: 'active', lastDataAt: Date.now() - 3 * 60 * 60_000, cliFamily: 'claude', pid: idle.pid }],
            logTail: 'error: repeated output\nShould I refactor the parser or patch the caller?\n',
            tiers: [{
                providerId: 'local', role: 'classifier', locality: 'loopback', operator: 'self', costClass: 'free',
                endpoint: stub.url, model: 'stub-pilot', keySet: false, source: 'test:tier',
            }],
            navigatorView: {
                providerId: 'local', endpoint: stub.url, model: 'stub-navigator', keySet: false,
                locality: 'loopback', costClass: 'free', operator: 'self', source: 'row:navigator',
            },
            state: {
                samples: { 'coder-1': seedIdleSeat(idle.pid, idleRow.jiffies, idleRow.startTime) },
                subjects: { 'card:plan-1': { rung: 5, atRung: 0, ruleId: 'waiting-on-human', firstSeenAt: 1, lastFiredAt: 1, ownerSince: STUCK_SINCE, stuckPasses: 3, lastClass: 'waiting-human' } },
            },
        });
    }

    const row3Reply = (system) => (system.includes('You supervise a board') ? 'nothing wrong'
        : system.includes('CLASSIFY that question') ? 'hedge'
            : 'SEAT: coder-1 | FLAGS: tail-question');

    await checkAsync('a row-3 question classified as a HEDGE gets the seat its own prompt back', async () => {
        const stub = await startNavigatorStub(row3Reply);
        try {
            const board = row3Board(stub);
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const asked = stub.calls.find(c => c.system.includes('CLASSIFY that question'));
            assert.ok(asked, 'the Navigator must be asked to CLASSIFY, not to answer');
            assert.ok(/never to answer it/.test(asked.system), 'the prompt must forbid answering');
            assert.ok(/real-block/.test(asked.system) && /hedge/.test(asked.system),
                'the closed set must be stated');
            assert.strictEqual(board.seen.dispatchBodies.length, 1,
                'a hedge must be answered with the seat\'s own dispatch prompt');
            assert.strictEqual(board.seen.dispatchBodies[0].plan, 'plan-1');
            // NOTHING is composed as an answer: no answer text anywhere.
            const body = reportBody(board);
            assert.ok(/classified the question as a HEDGE/.test(body), `the report must record the classification: ${body}`);
            assert.ok(/question recorded verbatim/.test(body), 'the question must be recorded verbatim');
            assert.strictEqual(board.seen.terminalWrites.length, 0,
                'no answer may be typed into the seat');
        } finally {
            await stub.close();
        }
    });

    await checkAsync('a row-3 question classified as a REAL BLOCK stops, delivering nothing', async () => {
        const stub = await startNavigatorStub((system) => (system.includes('You supervise a board') ? 'nothing wrong'
            : system.includes('CLASSIFY that question') ? 'real-block'
                : 'SEAT: coder-1 | FLAGS: tail-question'));
        try {
            const board = row3Board(stub);
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(board.seen.dispatchBodies.length, 0, 'a real block must not be re-dispatched');
            assert.strictEqual(board.seen.terminalWrites.length, 0, 'nothing may be delivered to the seat');
            const body = reportBody(board);
            assert.ok(/classified the question as a REAL BLOCK/.test(body), `the report must record it: ${body}`);
            assert.ok(/question recorded verbatim/.test(body), 'the question must be recorded verbatim');
            assert.ok(/stops acting on this subject/.test(body), 'the controller must stop acting');
            assert.strictEqual(board.state().subjects['card:plan-1'].exhausted, true,
                'the subject must be marked exhausted');
        } finally {
            await stub.close();
        }
    });

    await checkAsync('a row-3 classification outside the closed set is NOT coerced — it stops', async () => {
        const stub = await startNavigatorStub((system) => (system.includes('You supervise a board') ? 'nothing wrong'
            : system.includes('CLASSIFY that question') ? 'this looks like a genuine problem, probably a block of some kind'
                : 'SEAT: coder-1 | FLAGS: tail-question'));
        try {
            const board = row3Board(stub);
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(board.seen.dispatchBodies.length, 0,
                'an unreadable classification must not be coerced into a re-delivery');
            const body = reportBody(board);
            assert.ok(/UNREADABLE/.test(body), `the report must say the classification was unreadable: ${body}`);
            assert.ok(/rather than guessed at/.test(body), 'the report must say it was not guessed at');
        } finally {
            await stub.close();
        }
    });

    // ── 6. respawn-seat ───────────────────────────────────────────────────

    await checkAsync('respawn-seat performs NO terminal write, and the prompt arrives in the startup command', async () => {
        const board = makeBoard({
            plans: [coderPlan()],
            fleet: [{ friendlyName: 'coder-1', status: 'active', lastDataAt: Date.now() - 3 * 60 * 60_000, cliFamily: 'claude', pid: idle.pid }],
            state: {
                samples: { 'coder-1': seedIdleSeat(idle.pid, idleRow.jiffies, idleRow.startTime) },
                subjects: { 'card:plan-1': { rung: 2, atRung: 0, ruleId: 'idle-no-blocker', firstSeenAt: 1, lastFiredAt: 1, ownerSince: STUCK_SINCE, stuckPasses: 3, lastClass: null } },
            },
        });
        await oneWake({ board, workspaceRoot: tmpWorkspace() });
        assert.strictEqual(board.seen.respawns.length, 1, 'the respawn verb must be called');
        assert.strictEqual(board.seen.respawns[0].name, 'coder-1');
        assert.strictEqual(board.seen.terminalWrites.length, 0,
            'a declared-argv respawn must write NOTHING to the terminal — no paste, no CR');
        const body = reportBody(board);
        assert.ok(/ZERO prompt writes/.test(body), `the report must record that the prompt went in the argv: ${body}`);
        assert.ok(/clear strategy in-process \(source: default\)/.test(body),
            'the clear-strategy lookup must record WHICH arm answered');
    });

    check('the Go host respawns with the prompt in the startup command, and injects nothing without a shape', () => {
        assert.ok(/case "ptyRespawnSeat":/.test(goMain), 'the Go host must serve ptyRespawnSeat');
        const verb = goMain.slice(goMain.indexOf('case "ptyRespawnSeat":'));
        const verbBody = verb.slice(0, verb.indexOf('case "ptySendPrompt":'));
        assert.ok(/respawnAndReinject\(t, t\.cliFamily, prompt\)/.test(verbBody),
            'the verb must go through the existing respawn path, not hand-roll a send');
        assert.ok(/argvInjected/.test(verbBody), 'the verb must report whether the argv path was taken');
        const reinject = goMain.slice(goMain.indexOf('func (f *fleet) respawnAndReinject('));
        const reinjectBody = reinject.slice(0, reinject.indexOf('\n}\n'));
        assert.ok(/respawnArgvSuffix\(family, prompt\)/.test(reinjectBody),
            'the startup command must carry the prompt in the family\'s declared argv shape');
        assert.ok(/prompt != "" && suffix == ""/.test(reinjectBody),
            'a prompt with no declared shape must NOT be injected');
        // The only write on the path is the startup command line.
        assert.ok(/writeToPty\(t, line\)/.test(reinjectBody), 'the startup command is written to the fresh shell');
        assert.ok(!/deliverPrompt|bracketedPaste|confirmEnter/.test(reinjectBody),
            'the respawn path must not use the composer-delivery machinery');
    });

    check('the Node host falls back to a gated first delivery only when no shape is declared', () => {
        const arm = bootstrapSrc.slice(bootstrapSrc.indexOf("case 'ptyRespawnSeat':"));
        const armBody = arm.slice(0, arm.indexOf("case 'ptySendModel':"));
        assert.ok(/ptyHostSupervisor\.request\('ptyRespawnSeat'/.test(armBody), 'the arm must call the host verb');
        assert.ok(/argvInjected === false/.test(armBody), 'the fallback must be gated on argvInjected === false');
        const fallback = armBody.slice(armBody.indexOf('argvInjected === false'));
        assert.ok(/handlePtyVerb\('ptySendPrompt'/.test(fallback),
            'the fallback must be an ordinary first delivery (which passes the boot readiness gate), not a bespoke write');
        assert.ok(/generateUnifiedPrompt/.test(armBody),
            'the prompt must come from the SAME builder the dispatch path uses');
    });

    // ── 6. One rung per application, and the ladder terminates ───────────

    await checkAsync('successive wakes advance one rung each, and the exhausted ladder takes NO action', async () => {
        const board = makeBoard({
            plans: [coderPlan()],
            fleet: [{ friendlyName: 'coder-1', status: 'active', lastDataAt: Date.now() - 3 * 60 * 60_000, cliFamily: 'claude', pid: idle.pid }],
            logTail: '## 2026-09-22T01:02:03.004Z — Fix the flaky test\n\n> working on the flaky test\n',
            state: { samples: { 'coder-1': seedIdleSeat(idle.pid, idleRow.jiffies, idleRow.startTime) } },
        });
        const ws = tmpWorkspace();
        // No classifier tier is configured, so the judgement rungs are
        // unreachable and the ladder's reachable rungs are:
        // bare-enter, redeliver-dispatch, respawn-seat, reset-context, stop.
        const expected = ['bare-enter', 'redeliver-dispatch', 'respawn-seat', 'reset-context', 'stop'];
        const seenRungs = [];
        for (let i = 0; i < expected.length; i++) {
            await oneWake({ board, workspaceRoot: ws });
            const body = lastReportBody(board);
            const m = body.match(/- rung: `([a-z-]+)`/);
            seenRungs.push(m ? m[1] : '(none)');
        }
        assert.deepStrictEqual(seenRungs, expected,
            `each wake must apply exactly ONE rung and advance: got ${JSON.stringify(seenRungs)}`);
        // The top rung has been applied and the row fires again: NO action.
        const before = board.seen.reports.length;
        await oneWake({ board, workspaceRoot: ws });
        const after = board.seen.reports.length;
        assert.strictEqual(after, before + 1, 'a wake still writes a report');
        assert.ok(/_No rule fired this pass\./.test(lastReportBody(board)),
            `the exhausted ladder must take NO action: ${lastReportBody(board)}`);
        assert.ok(!/re-applied|re-applying/.test(lastReportBody(board)));
    });

    await checkAsync('the stop rung records that the controller has stopped, once', async () => {
        const board = makeBoard({
            plans: [coderPlan()],
            fleet: [{ friendlyName: 'coder-1', status: 'active', lastDataAt: Date.now() - 3 * 60 * 60_000, cliFamily: 'claude', pid: idle.pid }],
            logTail: '## 2026-09-22T01:02:03.004Z — Fix the flaky test\n\n> working on the flaky test\n',
            state: {
                samples: { 'coder-1': seedIdleSeat(idle.pid, idleRow.jiffies, idleRow.startTime) },
                subjects: { 'card:plan-1': { rung: 7, atRung: 0, ruleId: 'idle-no-blocker', firstSeenAt: 1, lastFiredAt: 1, ownerSince: STUCK_SINCE, stuckPasses: 5, lastClass: null } },
            },
        });
        await oneWake({ board, workspaceRoot: tmpWorkspace() });
        const body = reportBody(board);
        assert.ok(/the ladder is exhausted/.test(body), `the stop must be recorded: ${body}`);
        assert.ok(/stops acting on this subject/.test(body), 'the record must say the controller has stopped');
        assert.ok(!/Mission Control/.test(body), 'nothing may be sent to a Mission Control seat');
        assert.strictEqual(board.seen.terminalWrites.length, 0, 'stop delivers nothing');
        assert.strictEqual(board.seen.dispatchBodies.length, 0, 'stop dispatches nothing');
        assert.strictEqual(board.state().subjects['card:plan-1'].exhausted, true,
            'the subject must be marked exhausted in persisted state');
    });

    idle.kill('SIGKILL');

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) { process.exit(1); }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
