'use strict';

/**
 * Contract: a dispatch that reached a seat is reported as a dispatch that
 * reached a seat.
 *
 * Plan: .switchboard/plans/a-dispatch-erases-its-own-evidence-46ms-after-writing-it.md
 *
 * The defect: `updateDispatchInfoByPlanFile` stamps `plans.owner_since` and a
 * column move clears it 46 ms later (`_columnMoveDispatchClearSql`), so every
 * verifier that read `owner_since` as proof of delivery reported a delivered
 * dispatch as failed — 340 board rows against 2 survivors. The fix moves the
 * evidence to the append-only `dispatched` event in `plan_events`, scoped to the
 * attempt by its AUTOINCREMENT `event_id`.
 *
 * These are the checks that DISCRIMINATE on that mechanism. Before the fix,
 * 1/2/4/6 fail; the rest pin the invariants the fix must not lose.
 *
 *  1. The `dispatched` event survives the column move that clears `owner_since`.
 *  2. POST /kanban/dispatch reports `delivered` for exactly that sequence.
 *  3. A genuine non-delivery reports `not-delivered` (not `unknown`, not success),
 *     and no longer blames the terminal agent.
 *  4. A previous attempt's event never satisfies a new attempt (event_id baseline).
 *  5. One dispatch writes exactly one `workflow_event`/`stop` row, not four or five.
 *  6. An acked delivery rejection is recorded durably + in the poll entry, not
 *     only on stdout.
 *  7. A rejection arriving AFTER the delivery is evidenced does not overwrite it.
 *  8. GET /kanban/dispatch/state answers from the event, with the reason.
 *  9. The raw verb rail answers in the same vocabulary instead of hollow success.
 * 10. Goal invariants: no `owner_since` verifier, no clipboard `success` without a
 *     third outcome, and no dispatch-verification code in the legacy host.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KanbanDatabase } = require('../../out/services/KanbanDatabase');
const { LocalApiServer } = require('../../out/services/LocalApiServer');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (e) {
        console.error(`  FAIL ${name}`);
        console.error(`     ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n     ') : e}`);
        failed++;
    }
}

/** A LocalApiServer wired to a mock board whose triggerAction arm is scripted. */
function makeServer({ workspaceRoot, plan, arm, dragDropMode = 'terminal', events = [] }) {
    const mockDb = {
        getWorkspaceId: async () => 'ws-1',
        getDominantWorkspaceId: async () => 'ws-1',
        getBoard: async () => [plan],
        getPlanByPlanId: async (id) => (id === plan.planId ? plan : null),
        getPlanBySessionId: async (id) => (id === plan.sessionId ? plan : null),
        clearCompletedAt: async () => true,
        appendPlanEventByPlanId: async (planId, event) => {
            events.push({ planId, ...event, eventId: events.length + 1 });
            return true;
        },
        getLatestDispatchOutcomeByPlanId: async (planId) => {
            for (let i = events.length - 1; i >= 0; i--) {
                const e = events[i];
                if (e.planId !== planId) continue;
                if (e.eventType !== 'dispatched' && e.eventType !== 'dispatch_rejected') continue;
                let payload = {};
                try { payload = JSON.parse(e.payload || '{}'); } catch { /* empty */ }
                return {
                    eventId: e.eventId,
                    eventType: e.eventType,
                    timestamp: e.timestamp || '',
                    seat: String(payload.seat || ''),
                    agent: String(payload.agent || ''),
                    ide: String(payload.ide || ''),
                    error: String(payload.error || ''),
                };
            }
            return null;
        },
    };

    const server = new LocalApiServer({
        workspaceRoot,
        clickupMetadataPath: '',
        linearMetadataPath: '',
        getClickUpService: () => null,
        getLinearService: () => null,
        getNotionService: () => null,
        getAuthToken: async () => '',
        allRoots: [workspaceRoot],
        getKanbanDatabase: async () => mockDb,
        getRegisteredTerminals: () => ['coder-1'],
        resolveAutoDispatchColumn: async () => ({ targetColumn: 'CODER CODED', reason: 'complexity 5' }),
        resolveKanbanDispatch: async () => ({
            role: 'coder',
            boardMoveCliTriggersEnabled: true,
            dragDropMode,
            source: 'test',
        }),
        resolveTeamRoleTerminal: async () => 'coder-1',
        kanbanVerb: async (verb, payload) => {
            if (verb !== 'triggerAction') return { success: true };
            return arm(payload, mockDb);
        },
    });
    return { server, mockDb, events };
}

/** Fake req/res pair for the private GET /kanban/dispatch/state handler. */
function fakeExchange(query) {
    const res = { status: 0, headers: null, body: '' };
    return {
        req: { url: `/kanban/dispatch/state?${new URLSearchParams(query).toString()}`, headers: { host: '127.0.0.1:7777' }, socket: {} },
        res: {
            writeHead: (status, headers) => { res.status = status; res.headers = headers; },
            end: (body) => { res.body = body || ''; },
        },
        out: res,
    };
}

async function run() {
    console.log('\nDispatch evidence is append-only, and every entry point says so\n');

    // ---------------------------------------------------------------- real DB
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dispatch-evidence-')));
    fs.mkdirSync(path.join(tmpRoot, '.switchboard', 'plans'), { recursive: true });
    const db = KanbanDatabase.forWorkspace(tmpRoot);
    {
        const dbDir = path.dirname(db.dbPath);
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
        if (!fs.existsSync(db.dbPath)) fs.writeFileSync(db.dbPath, Buffer.alloc(0));
        assert.ok(await db.ensureReady(), 'seeded kanban.db must initialise');
    }
    const wsId = (await db.getWorkspaceId()) || (await db.getDominantWorkspaceId()) || 'dispatch-evidence-ws';

    async function seedPlan(slug, planId) {
        const rel = `.switchboard/plans/${slug}.md`;
        fs.writeFileSync(path.join(tmpRoot, rel), `# ${slug}\n\n## Goal\n${slug}\n`, 'utf8');
        const now = new Date().toISOString();
        assert.ok(await db.insertFileDerivedPlan({
            planId, sessionId: planId, topic: slug, planFile: rel, kanbanColumn: 'STAGING',
            status: 'active', complexity: '5', tags: '', project: '', workspaceId: wsId,
            createdAt: now, updatedAt: now, sourceType: 'local', workspaceName: 'dispatch-evidence',
            isFeature: 0,
        }), `seedPlan(${slug}) must insert`);
        return rel;
    }

    await test('1. the `dispatched` event survives the column move that clears owner_since', async () => {
        const rel = await seedPlan('evidence-survives', 'plan-evidence-1');
        assert.ok(await db.updateDispatchInfoByPlanFile(rel, wsId, {
            ownerSeat: 'planner-1', dispatchedAgent: 'planner', dispatchedIde: 'PTY',
        }), 'the one dispatch writer must succeed');

        const stamped = await db.getPlanByPlanId('plan-evidence-1');
        assert.ok(stamped.ownerSince, 'owner_since is stamped by the dispatch write');
        const evidence = await db.getLatestDispatchOutcomeByPlanId('plan-evidence-1');
        assert.ok(evidence, 'a dispatch appends a dispatch-outcome event');
        assert.strictEqual(evidence.eventType, 'dispatched');
        assert.strictEqual(evidence.seat, 'planner-1', 'the persisted payload carries the seat');
        assert.strictEqual(evidence.agent, 'planner', 'the persisted payload carries the agent');
        assert.strictEqual(evidence.ide, 'PTY', 'the persisted payload carries the ide');

        // The 46 ms write: a column move lands next and clears the activity light.
        assert.ok(await db.updateColumnByPlanFile(rel, wsId, 'CODER CODED'), 'the column move must persist');
        const moved = await db.getPlanByPlanId('plan-evidence-1');
        assert.ok(!moved.ownerSince, 'the column move DOES clear owner_since — that is the defect');

        const after = await db.getLatestDispatchOutcomeByPlanId('plan-evidence-1');
        assert.ok(after, 'the append-only evidence must survive the clear');
        assert.strictEqual(after.eventId, evidence.eventId, 'and it must be the same row, untouched');
    });

    await test('4a. a re-dispatch appends NEW evidence with a greater event_id', async () => {
        const rel = await seedPlan('evidence-rescoped', 'plan-evidence-2');
        await db.updateDispatchInfoByPlanFile(rel, wsId, { ownerSeat: 'coder-1', dispatchedAgent: 'coder', dispatchedIde: 'PTY' });
        const first = await db.getLatestDispatchOutcomeByPlanId('plan-evidence-2');
        await db.updateDispatchInfoByPlanFile(rel, wsId, { ownerSeat: 'coder-2', dispatchedAgent: 'coder', dispatchedIde: 'PTY' });
        const second = await db.getLatestDispatchOutcomeByPlanId('plan-evidence-2');
        assert.ok(second.eventId > first.eventId, 'the second attempt must be distinguishable by event_id');
        assert.strictEqual(second.seat, 'coder-2', 'and it must name the second attempt\'s seat');
    });

    await test('5. one dispatch writes exactly one workflow_event/stop row', async () => {
        const planId = 'plan-evidence-3';
        await seedPlan('evidence-no-fanout', planId);
        for (let i = 0; i < 5; i++) {
            await db.appendPlanEventByPlanId(planId, {
                eventType: 'workflow_event', workflow: 'dispatch', action: 'stop', workspaceId: wsId,
            });
        }
        const rows = (await db.getPlanEventsByPlanId(planId, wsId))
            .filter(r => String(r.event_type) === 'workflow_event' && String(r.action) === 'stop');
        assert.strictEqual(rows.length, 1, `five identical stop transitions must collapse to one row, got ${rows.length}`);

        // A real transition still writes: stop → start → stop is three rows.
        await db.appendPlanEventByPlanId(planId, { eventType: 'workflow_event', workflow: 'dispatch', action: 'start', workspaceId: wsId });
        await db.appendPlanEventByPlanId(planId, { eventType: 'workflow_event', workflow: 'dispatch', action: 'stop', workspaceId: wsId });
        const all = (await db.getPlanEventsByPlanId(planId, wsId))
            .filter(r => String(r.event_type) === 'workflow_event');
        assert.strictEqual(all.length, 3, 'de-duplication must not swallow genuine transitions');
    });

    // ------------------------------------------------------- POST /kanban/dispatch
    const WS = '/tmp/dispatch-evidence-ws';

    await test('2. a delivered dispatch whose owner_since is cleared 46 ms later reports `delivered`', async () => {
        const plan = {
            planId: 'p-sync-ok', sessionId: 'p-sync-ok', topic: 'Card', kanbanColumn: 'STAGING',
            featureId: '', ownerSeat: '', ownerSince: null, columnOrder: 1, complexity: 5,
        };
        const events = [];
        const { server } = makeServer({
            workspaceRoot: WS, plan, events,
            arm: async (payload, mockDb) => {
                // The real arm's order: stamp (with its append-only event), then the
                // column move lands and nulls owner_since.
                plan.ownerSeat = 'coder-1';
                plan.ownerSince = new Date().toISOString();
                await mockDb.appendPlanEventByPlanId(plan.planId, {
                    eventType: 'dispatched', action: 'dispatch',
                    payload: JSON.stringify({ seat: 'coder-1', agent: 'coder', ide: 'PTY' }),
                });
                plan.kanbanColumn = payload.targetColumn;
                plan.ownerSince = null; // <- the write that erased the evidence
                return { success: true, delivery: 'delivered' };
            },
        });

        const res = await server.performKanbanDispatch(WS, 'p-sync-ok');
        assert.strictEqual(res.status, 200, `must be 200, got ${res.status}: ${res.payload && res.payload.error}`);
        assert.strictEqual(res.payload.dispatched, true, 'dispatched must be true');
        assert.strictEqual(res.payload.delivery, 'delivered', 'the vocabulary must read `delivered`');
        assert.strictEqual(res.payload.ownerSince, null, 'and owner_since is still NULL — it is not the evidence');
    });

    await test('3. a dispatch that never reached a seat reports `not-delivered`, and stops blaming the agent', async () => {
        const plan = {
            planId: 'p-sync-miss', sessionId: 'p-sync-miss', topic: 'Card', kanbanColumn: 'STAGING',
            featureId: '', ownerSeat: '', ownerSince: null, columnOrder: 1, complexity: 5,
        };
        const { server } = makeServer({
            workspaceRoot: WS, plan,
            // The arm moves the card and reports success, but stamps nothing —
            // the clipboard fallback, or a stamp whose append failed.
            arm: async (payload) => { plan.kanbanColumn = payload.targetColumn; return { success: true }; },
        });

        const res = await server.performKanbanDispatch(WS, 'p-sync-miss');
        assert.strictEqual(res.status, 502, 'an unevidenced delivery must not be a 200');
        assert.strictEqual(res.payload.dispatched, false);
        assert.strictEqual(res.payload.delivery, 'not-delivered', 'not `unknown`, not a success');
        assert.ok(/no new dispatched event/.test(res.payload.error), `the remedy must name the missing evidence: ${res.payload.error}`);
        assert.ok(!/check the terminal agent/i.test(res.payload.error),
            'the 502 must no longer point at the one component that was working');
    });

    await test('4b. a previous attempt\'s event never satisfies a new attempt', async () => {
        const plan = {
            planId: 'p-stale', sessionId: 'p-stale', topic: 'Card', kanbanColumn: 'STAGING',
            featureId: '', ownerSeat: 'coder-1', ownerSince: null, columnOrder: 1, complexity: 5,
        };
        // Evidence from a dispatch that happened yesterday.
        const events = [{
            planId: 'p-stale', eventType: 'dispatched', action: 'dispatch', eventId: 1,
            payload: JSON.stringify({ seat: 'coder-1', agent: 'coder', ide: 'PTY' }),
        }];
        const { server } = makeServer({
            workspaceRoot: WS, plan, events,
            arm: async (payload) => { plan.kanbanColumn = payload.targetColumn; return { success: true }; },
        });

        const res = await server.performKanbanDispatch(WS, 'p-stale');
        assert.strictEqual(res.payload.dispatched, false,
            'an arm that stamped nothing must NOT inherit the previous attempt\'s evidence');
        assert.strictEqual(res.payload.delivery, 'not-delivered');
    });

    // --------------------------------------------------- acked path + state poll
    await test('6. an acked delivery rejection is recorded durably, not only on stdout', async () => {
        const plan = {
            planId: 'p-acked-fail', sessionId: 'p-acked-fail', topic: 'Card', kanbanColumn: 'STAGING',
            featureId: '', ownerSeat: '', ownerSince: null, columnOrder: 1, complexity: 5,
        };
        const events = [];
        const { server } = makeServer({
            workspaceRoot: WS, plan, events,
            arm: async () => { throw new Error('seat died mid-paste'); },
        });

        const ack = await server.performKanbanDispatchAcked(WS, 'p-acked-fail');
        assert.strictEqual(ack.status, 200, 'the ack is still immediate');
        assert.strictEqual(ack.payload.delivery, 'sent', 'the ack speaks the shared vocabulary');
        assert.strictEqual(typeof ack.payload.dispatchEventBaseline, 'number', 'the ack carries the event baseline');

        // Let the retained delivery promise settle.
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));

        const rejected = events.filter(e => e.eventType === 'dispatch_rejected');
        assert.strictEqual(rejected.length, 1, 'the rejection must reach plan_events, not just console.error');
        assert.ok(/seat died mid-paste/.test(rejected[0].payload), 'and it must carry the reason');

        const entry = server._ackedDispatchState.get('p-acked-fail');
        assert.ok(entry && entry.failed, 'the poll entry must be able to answer before the durable append lands');
    });

    await test('7. a rejection arriving AFTER delivery is evidenced does not overwrite it', async () => {
        const plan = {
            planId: 'p-late-throw', sessionId: 'p-late-throw', topic: 'Card', kanbanColumn: 'STAGING',
            featureId: '', ownerSeat: '', ownerSince: null, columnOrder: 1, complexity: 5,
        };
        const events = [];
        const { server } = makeServer({
            workspaceRoot: WS, plan, events,
            // The prompt landed and the stamp went in; something downstream of the
            // stamp (a broadcast, a status message) then threw.
            arm: async (payload, mockDb) => {
                await mockDb.appendPlanEventByPlanId(plan.planId, {
                    eventType: 'dispatched', action: 'dispatch',
                    payload: JSON.stringify({ seat: 'coder-1', agent: 'coder', ide: 'PTY' }),
                });
                plan.kanbanColumn = payload.targetColumn;
                throw new Error('broadcast failed after the prompt landed');
            },
        });

        await server.performKanbanDispatchAcked(WS, 'p-late-throw');
        for (let i = 0; i < 6; i++) { await new Promise(r => setImmediate(r)); }

        assert.strictEqual(events.filter(e => e.eventType === 'dispatch_rejected').length, 0,
            'a post-stamp throw must not append a rejection NEWER than the evidence');
        const entry = server._ackedDispatchState.get('p-late-throw');
        assert.ok(!entry || !entry.failed, 'and it must not flip the poll entry to failed');
    });

    await test('8. GET /kanban/dispatch/state answers from the event, with the reason', async () => {
        const plan = {
            planId: 'p-state', sessionId: 'p-state', topic: 'Card', kanbanColumn: 'STAGING',
            featureId: '', ownerSeat: 'coder-1', ownerSince: null, columnOrder: 1, complexity: 5,
        };
        // A previous attempt's evidence sits at event 1.
        const events = [{
            planId: 'p-state', eventType: 'dispatched', action: 'dispatch', eventId: 1,
            payload: JSON.stringify({ seat: 'stale-seat', agent: 'coder', ide: 'PTY' }),
        }];
        const { server, mockDb } = makeServer({ workspaceRoot: WS, plan, events, arm: async () => ({ success: true }) });

        // Baseline 1 ⇒ the stale row is not this attempt's evidence.
        const stale = fakeExchange({ planId: 'p-state', eventSince: '1', deadline: String(Date.now() + 60000) });
        await server._handleKanbanDispatchState(stale.req, stale.res);
        assert.strictEqual(JSON.parse(stale.out.body).state, 'sent',
            'a previous attempt\'s event must read as still-in-flight, never as delivered');

        // The attempt's own `dispatched` row lands.
        await mockDb.appendPlanEventByPlanId('p-state', {
            eventType: 'dispatched', action: 'dispatch',
            payload: JSON.stringify({ seat: 'coder-1', agent: 'coder', ide: 'PTY' }),
        });
        const ok = fakeExchange({ planId: 'p-state', eventSince: '1', deadline: String(Date.now() + 60000) });
        await server._handleKanbanDispatchState(ok.req, ok.res);
        const okBody = JSON.parse(ok.out.body);
        assert.strictEqual(okBody.state, 'delivered', 'the fresh event is the verdict');
        assert.strictEqual(okBody.delivery, 'delivered');
        assert.strictEqual(okBody.seat, 'coder-1', 'and the seat comes off the fresh event');
        assert.strictEqual(plan.ownerSince, null, 'with owner_since NULL throughout');

        // A rejection reports not-delivered WITH its reason, promptly.
        await mockDb.appendPlanEventByPlanId('p-state', {
            eventType: 'dispatch_rejected', action: 'reject',
            payload: JSON.stringify({ error: 'no live seat for role coder', seat: '' }),
        });
        const bad = fakeExchange({ planId: 'p-state', eventSince: '2', deadline: String(Date.now() + 60000) });
        await server._handleKanbanDispatchState(bad.req, bad.res);
        const badBody = JSON.parse(bad.out.body);
        assert.strictEqual(badBody.state, 'not-delivered', 'a rejection must not wait out the 60 s deadline');
        assert.ok(/no live seat/.test(badBody.error), 'and it must name the reason');
    });

    // ------------------------------------------------------------- source invariants
    await test('9. the raw verb rail annotates triggerAction with the shared vocabulary', () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const handler = src.slice(src.indexOf('private async _handleKanbanVerb('));
        const body = handler.slice(0, handler.indexOf('private async _handlePlanningVerb('));
        assert.ok(/getLatestDispatchOutcomeByPlanId/.test(body),
            'the verb rail must read the append-only evidence, not return a hollow {success:true}');
        assert.ok(/delivery: delivered\s*\n?\s*\?\s*'delivered'/.test(body) || /'not-delivered'/.test(body),
            'the verb rail must answer in the sent/delivered/not-delivered vocabulary');
    });

    await test('10a. no verifier decides `dispatched` from owner_since alone', () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const verifiers = [
            'public async performKanbanDispatch(',
            'public async performKanbanDispatchAcked(',
            'private async _handleKanbanDispatchState(',
        ];
        for (const fn of verifiers) {
            const at = src.indexOf(fn);
            assert.ok(at > 0, `${fn} must exist`);
            // The verdict-bearing slice of each verifier.
            const body = src.slice(at, at + 9000);
            assert.ok(/getLatestDispatchOutcomeByPlanId/.test(body),
                `${fn} must read delivery evidence from plan_events`);
        }
        assert.ok(!/const dispatched = .*ownerSince/.test(src),
            'no `dispatched` verdict may be computed from ownerSince');
    });

    await test('10b. the clipboard fallback carries a third outcome, not a bare success', () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        assert.ok(/delivery: result\.delivered \? 'delivered' : 'not-delivered'/.test(src),
            'the dispatchProjectManager result must carry delivery, not only success+delivered');
    });

    await test('10c. the legacy extension host gains no dispatch-verification code', () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'extension.ts'), 'utf8');
        assert.ok(!/getLatestDispatchOutcomeByPlanId/.test(src),
            'the cutover puts dispatch verification in the standalone host only');
    });

    await test('10d. the acked failure path is no longer a bare console.error', () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const at = src.indexOf('public async performKanbanDispatchAcked(');
        const body = src.slice(at, src.indexOf('private async _handleKanbanDispatchState('));
        assert.ok(/dispatch_rejected/.test(body), 'the rejection must reach a durable store');
        assert.ok(/entry\.failed = error/.test(body), 'and the in-memory poll entry');
    });

    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }

    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    if (failed > 0) { process.exit(1); }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
