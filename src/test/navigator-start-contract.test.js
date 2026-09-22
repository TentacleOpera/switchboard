'use strict';

/**
 * The Navigator starts the mission it set up
 * (plan: the-navigator-starts-the-mission-it-set-up, subtask 4).
 *
 * Starting has a concrete meaning here: stage every member above the
 * workspace-wide STAGING maximum, mark the mission ready, dispatch exactly ONE
 * card, stop. Five fences this suite holds:
 *
 *  - **A refusal writes NOTHING.** Staging has no inverse, so every check
 *    precedes every write: no staging, no `ready`, no dispatch.
 *  - **The staging order is the topological sort of the recorded edges.** With
 *    no edges the queue pops members in board order — the round-wasting failure
 *    the parameters subtask exists to prevent — so that case is a STATED
 *    FINDING, and distinct from "the cards genuinely have no constraints".
 *  - **One card, then the queue.** The Navigator dispatches the head and hands
 *    off; the second member is started by automated dispatch, not by this pass.
 *  - **Only the mission the operator approved.** Not the next one, not a card
 *    outside it.
 *  - **`coding_rounds` is absent from the code path** — the unit is one card,
 *    not one round.
 *
 * Harness notes (mirrored from navigator-parameters-contract.test.js — do not
 * "simplify" these): `vscode` → the standalone shim before any out/ require;
 * kanban.db must exist on disk before `ensureReady()`. No model server is needed
 * — the start makes no model call, which is itself a contract point.
 *
 * Run with:
 *   npm run compile-tests && npm run test:contract:navigator-start
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// `vscode` → the standalone shim, installed BEFORE any out/services require.
const shimPath = path.join(__dirname, '..', '..', 'out', 'standalone', 'vscodeShim.js');
{
    const originalLoad = Module._load;
    Module._load = function (request) {
        if (request === 'vscode') { return require(shimPath); }
        return originalLoad.apply(this, arguments);
    };
}

const { KanbanDatabase } = require('../../out/services/KanbanDatabase');
const { LocalApiServer } = require('../../out/services/LocalApiServer');
const { GlobalIntegrationConfigService } = require('../../out/services/GlobalIntegrationConfigService');
const navigator = require('../../out/standalone/controller/navigator');

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(`     ${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n     ') : e}`);
        failed++;
    }
}

const TEAM_GROUPS_KEY = 'switchboard.prompts.terminals.groups';
const AGENT_GROUPS_KEY = 'terminals.agentGroups';

function row(planId, extra = {}) {
    return {
        planId, sessionId: planId, topic: 'topic of ' + planId, kanbanColumn: 'PLAN REVIEWED',
        project: '', isFeature: 0, featureId: '', ownerSince: null, completedAt: null,
        planFile: `/tmp/${planId}.md`, columnOrder: null, ...extra,
    };
}

function mission(plans, extra = {}) {
    return {
        id: 'm1', name: 'Mission', goal: 'a goal', team: 'coding-team', maxExtraWorktrees: 0,
        runState: 'not-started', paused: false, plans, features: [], ...extra,
    };
}

const CODING = { id: 'coding-team', label: 'Coding', head: 'Coding Coder', headRole: 'coder', policy: 'pool', policySource: 'config' };

/** Fake ports for the capability's own contract. */
function fakePorts(opts = {}) {
    const writes = { staged: [], ready: [], dispatched: [], records: [], provenance: [] };
    let boardCall = 0;
    return {
        writes,
        ports: {
            listPlans: async () => {
                boardCall++;
                if (opts.board) { return opts.board(boardCall); }
                return opts.rows || [];
            },
            isMissionMember: async () => false,
            readPlanBody: async () => '',
            navigatorModel: async () => (opts.unconfigured
                ? { error: 'Agent-control config could not be read (config may be corrupt).' }
                : { providerId: 'stub', endpoint: 'http://127.0.0.1:1/v1/chat/completions', model: 'stub-model', apiKey: null, source: 'row:navigator' }),
            callModel: async () => { throw new Error('the start must make no model call'); },
            createMission: async () => ({ missionId: 'm1' }),
            claimIntoMission: async () => ({ claimed: true }),
            readMission: async () => (opts.mission === undefined ? mission(opts.members || []) : opts.mission),
            readAvailableTeams: async () => opts.teams || { available: [CODING], unavailable: [] },
            writeDependencies: async () => ({ ok: true }),
            updateMission: async () => ({ ok: true }),
            readParameterRecord: async () => opts.record || null,
            writeParameterRecord: async () => ({ written: true }),
            recordParameterProvenance: async () => ({ written: true }),
            readDependencies: async (planIds) => {
                const out = {};
                for (const id of planIds) { out[id] = (opts.deps && opts.deps[id]) || []; }
                return out;
            },
            stageMembers: async (input) => {
                writes.staged.push(input);
                return opts.stage ? opts.stage(input) : { ok: true };
            },
            markReady: async (missionId) => {
                writes.ready.push(missionId);
                return opts.ready ? opts.ready(missionId) : { ok: true };
            },
            dispatchCard: async (input) => {
                writes.dispatched.push(input);
                return opts.dispatch ? opts.dispatch(input) : { status: 200, payload: { success: true, delivery: 'delivered' } };
            },
            recordStartProvenance: async (entry) => { writes.provenance.push(entry); return { written: true }; },
            now: () => '2026-09-22T07:00:00.000Z',
        },
    };
}

const A = 'plan-a', B = 'plan-b', C = 'plan-c';

async function run() {
    console.log('\nThe Navigator starts the mission it set up\n');

    // ══ The capability's own contract ══════════════════════════════════════

    await test('a start stages every member in dependency order, marks ready, and dispatches exactly ONE card', async () => {
        const h = fakePorts({
            members: [C, A, B], // insertion order deliberately NOT the dependency order
            rows: [row(A), row(B), row(C)],
            deps: { [B]: [A], [C]: [B] },
        });
        const outcome = await navigator.startMission({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'started', JSON.stringify(outcome).slice(0, 400));
        assert.deepStrictEqual(h.writes.staged, [{ missionId: 'm1', orderedPlanIds: [A, B, C] }],
            'staging is one write, in the topological order — not insertion order');
        assert.deepStrictEqual(h.writes.ready, ['m1'], 'the mission is marked ready');
        assert.strictEqual(h.writes.dispatched.length, 1, 'exactly ONE card is dispatched');
        assert.strictEqual(h.writes.dispatched[0].planId, A, 'and it is the head of the staged order');
        assert.strictEqual(h.writes.dispatched[0].seat, 'Coding Coder', 'dispatched to the mission\'s own team head');
        assert.strictEqual(outcome.orderSource, 'dependency-order');
        assert.strictEqual(outcome.finding, null);
        assert.strictEqual(outcome.readyWritten, true);
        assert.ok(outcome.teamPolicy === 'pool' && outcome.teamPolicySource === 'config');
    });

    await test('the second member is left to the queue — the Navigator does nothing further', async () => {
        const h = fakePorts({ members: [A, B], rows: [row(A), row(B)], deps: { [B]: [A] } });
        const outcome = await navigator.startMission({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'started');
        assert.deepStrictEqual(outcome.stagedIds, [A, B], 'both members are staged, so the queue can carry the second');
        assert.strictEqual(h.writes.dispatched.length, 1, 'and only the head was dispatched');
        assert.ok(/carried by automated dispatch/i.test(navigator.startOutcomeMessage(outcome)));
    });

    await test('a team whose policy is never is refused at the check, naming the policy and its source, and NOTHING is written', async () => {
        const h = fakePorts({
            members: [A, B], rows: [row(A), row(B)], deps: { [B]: [A] },
            teams: {
                available: [],
                unavailable: [{ id: 'coding-team', label: 'Coding', head: 'Coding Coder', reason: "head of 'Coding' (automatedDispatch=never)", policy: 'never', policySource: 'config' }],
            },
        });
        const outcome = await navigator.startMission({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'team-unavailable');
        assert.ok(/never/.test(outcome.reason), outcome.reason);
        assert.ok(/source: config/.test(outcome.reason), `the policy's SOURCE must be named: ${outcome.reason}`);
        assert.ok(outcome.reason.includes("head of 'Coding' (automatedDispatch=never)"), 'the resolver\'s reason travels verbatim');
        assert.deepStrictEqual(h.writes.staged, [], 'no staging');
        assert.deepStrictEqual(h.writes.ready, [], 'no ready');
        assert.deepStrictEqual(h.writes.dispatched, [], 'no dispatch');
    });

    await test('a mission whose team is not live is refused, and nothing is written', async () => {
        const h = fakePorts({ members: [A], rows: [row(A)], teams: { available: [], unavailable: [] } });
        const outcome = await navigator.startMission({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'team-unavailable');
        assert.ok(/not live/.test(outcome.reason), outcome.reason);
        assert.deepStrictEqual(h.writes.staged, []);
        assert.deepStrictEqual(h.writes.ready, []);
        assert.deepStrictEqual(h.writes.dispatched, []);
    });

    await test('a mission with no team assigned is refused, naming the missing team', async () => {
        const h = fakePorts({ mission: mission([A], { team: '' }), rows: [row(A)] });
        const outcome = await navigator.startMission({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'no-team');
        assert.ok(/no team is assigned/i.test(outcome.reason), outcome.reason);
        assert.deepStrictEqual(h.writes.staged, []);
    });

    await test('runState !== not-started and paused = 1 each refuse with their own reason, and write nothing', async () => {
        for (const [kind, extra, pattern] of [
            ['already-started', { runState: 'in-flight' }, /in-flight/],
            ['already-started', { runState: 'completed' }, /completed/],
            ['paused', { paused: true }, /paused/],
        ]) {
            const h = fakePorts({ mission: mission([A], extra), rows: [row(A)] });
            const outcome = await navigator.startMission({ missionId: 'm1' }, h.ports);
            assert.strictEqual(outcome.kind, kind, `${JSON.stringify(extra)} must refuse`);
            assert.ok(pattern.test(outcome.reason), outcome.reason);
            assert.deepStrictEqual(h.writes.staged, [], 'nothing staged');
            assert.deepStrictEqual(h.writes.ready, [], 'nothing marked ready');
            assert.deepStrictEqual(h.writes.dispatched, [], 'nothing dispatched');
        }
    });

    await test('a dependency cycle over the member set refuses the start, and nothing is written', async () => {
        const h = fakePorts({ members: [A, B], rows: [row(A), row(B)], deps: { [A]: [B], [B]: [A] } });
        const outcome = await navigator.startMission({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'cycle');
        assert.ok(outcome.cycle.length >= 3, `the cycle path must be named: ${JSON.stringify(outcome.cycle)}`);
        assert.deepStrictEqual(h.writes.staged, []);
        assert.deepStrictEqual(h.writes.ready, []);
        assert.deepStrictEqual(h.writes.dispatched, []);
    });

    await test('an EMPTY edge set is a stated finding, distinct from "the cards have no constraints"', async () => {
        const unrecorded = fakePorts({ members: [A, B], rows: [row(A), row(B)], deps: {}, record: null });
        const a = await navigator.startMission({ missionId: 'm1' }, unrecorded.ports);
        assert.strictEqual(a.kind, 'started');
        assert.strictEqual(a.orderSource, 'no-dependency-order-recorded');
        assert.ok(a.finding, 'the finding must be present — this is the clause the whole subtask turns on');
        assert.ok(/board order/.test(a.finding), a.finding);
        assert.deepStrictEqual(unrecorded.writes.staged[0].orderedPlanIds, [A, B], 'it stages, but in board order and SAYS SO');

        const stated = fakePorts({
            members: [A, B], rows: [row(A), row(B)], deps: {},
            record: { finding: 'no-hard-ordering-constraints', modelId: 'stub', at: 'x', order: [A, B], setters: {}, team: '', maxExtraWorktrees: 0, teamReason: '', worktreeReason: '' },
        });
        const b = await navigator.startMission({ missionId: 'm1' }, stated.ports);
        assert.strictEqual(b.orderSource, 'no-dependencies-stated');
        assert.strictEqual(b.finding, null, 'the pass ran and found none — that is not a finding about a missing pass');

        assert.notStrictEqual(navigator.startOutcomeMessage(a), navigator.startOutcomeMessage(b));
        assert.ok(/STATED FINDING/.test(navigator.startOutcomeMessage(a)));
        assert.ok(!/STATED FINDING/.test(navigator.startOutcomeMessage(b)));
    });

    await test('a member already held or already complete is skipped and NAMED, never a reason to refuse', async () => {
        const h = fakePorts({
            members: [A, B, C],
            rows: [row(A, { ownerSince: '2026-09-22T06:00:00Z' }), row(B, { completedAt: '2026-09-22T06:30:00Z' }), row(C)],
            deps: { [B]: [A], [C]: [B] },
        });
        const outcome = await navigator.startMission({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'started');
        assert.deepStrictEqual(outcome.stagedIds, [C], 'only the untouched member is staged');
        assert.deepStrictEqual(outcome.skippedHeld, [A]);
        assert.deepStrictEqual(outcome.skippedCompleted, [B]);
        assert.strictEqual(h.writes.dispatched[0].planId, C);
        const msg = navigator.startOutcomeMessage(outcome);
        assert.ok(/already being worked on/.test(msg) && /already complete/.test(msg), msg);
    });

    await test('a mission whose members have all completed refuses with "nothing left to start"', async () => {
        const h = fakePorts({ members: [A], rows: [row(A, { completedAt: '2026-09-22T06:30:00Z' })] });
        const outcome = await navigator.startMission({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'nothing-to-start');
        assert.ok(/nothing left to start/i.test(outcome.reason), outcome.reason);
        assert.deepStrictEqual(h.writes.staged, []);
        assert.deepStrictEqual(h.writes.ready, []);
        assert.deepStrictEqual(h.writes.dispatched, []);
    });

    await test('a head the queue already picked up is SUCCESS, not an error', async () => {
        const h = fakePorts({
            members: [A, B], rows: [row(A), row(B)], deps: { [B]: [A] },
            dispatch: () => ({ status: 409, payload: { success: false, error: 'card is already owned by Feature Coder' } }),
        });
        const outcome = await navigator.startMission({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'started', JSON.stringify(outcome).slice(0, 300));
        assert.strictEqual(outcome.dispatchOutcome, 'already-in-flight');
        assert.strictEqual(outcome.dispatchedCard, A);
        assert.ok(/already picked up by the queue/i.test(navigator.startOutcomeMessage(outcome)));
    });

    await test('a dispatch that genuinely failed is a PARTIAL START naming the staged ids', async () => {
        const h = fakePorts({
            members: [A, B], rows: [row(A), row(B)], deps: { [B]: [A] },
            dispatch: () => ({ status: 400, payload: { success: false, error: 'Column has no dispatch role configured' } }),
        });
        const outcome = await navigator.startMission({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'partial-start');
        assert.strictEqual(outcome.dispatchOutcome, 'failed');
        assert.ok(outcome.dispatchError.includes('no dispatch role'), outcome.dispatchError);
        assert.deepStrictEqual(outcome.actuallyStaged, [A, B], 'the operator must be told which cards the queue will act on');
        assert.ok(/PARTIAL START/.test(navigator.startOutcomeMessage(outcome)));
    });

    await test('a failed mission update reports started-but-not-ready, naming the staged ids', async () => {
        const h = fakePorts({
            members: [A], rows: [row(A)],
            ready: () => ({ ok: false, error: 'the board refused the mission update' }),
        });
        const outcome = await navigator.startMission({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'partial-start');
        assert.strictEqual(outcome.readyWritten, false);
        assert.deepStrictEqual(outcome.actuallyStaged, [A]);
        assert.strictEqual(outcome.dispatchedCard, null, 'nothing is dispatched when the mission could not be marked ready');
        assert.ok(/NOT marked ready/.test(navigator.startOutcomeMessage(outcome)));
    });

    await test('a failed staging write reports exactly which cards the board actually holds in STAGING', async () => {
        const h = fakePorts({
            members: [A, B], rows: [row(A), row(B)],
            stage: () => ({ ok: false, error: 'the board refused the staging write' }),
            // A half-applied staging write leaves A in STAGING and B where it was.
            board: (call) => (call === 1 ? [row(A), row(B)] : [row(A, { kanbanColumn: 'STAGING' }), row(B)]),
        });
        const outcome = await navigator.startMission({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'partial-start');
        assert.deepStrictEqual(outcome.actuallyStaged, [A], 'the queue will act on A regardless — the operator must know');
        assert.deepStrictEqual(h.writes.ready, [], 'nothing is marked ready after a failed staging');
        assert.deepStrictEqual(h.writes.dispatched, [], 'and nothing is dispatched');
    });

    await test('the mission beginning between the check and the staging write refuses, and stages nothing', async () => {
        let call = 0;
        const h = fakePorts({
            members: [A], rows: [row(A)],
            mission: undefined,
            board: () => [row(A)],
        });
        // readMission is called twice: the check, then the race re-read.
        h.ports.readMission = async () => (++call === 1 ? mission([A]) : mission([A], { runState: 'in-flight' }));
        const outcome = await navigator.startMission({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'already-started');
        assert.ok(/between the check and the staging write/.test(outcome.reason), outcome.reason);
        assert.deepStrictEqual(h.writes.staged, [], 'nothing was staged');
    });

    await test('the start is recorded with its author, the approval, the order, the card and the team', async () => {
        const h = fakePorts({ members: [A, B], rows: [row(A), row(B)], deps: { [B]: [A] } });
        await navigator.startMission({ missionId: 'm1' }, h.ports);
        const p = h.writes.provenance[0];
        assert.strictEqual(p.missionId, 'm1');
        assert.strictEqual(p.modelId, 'stub (stub-model)');
        assert.strictEqual(p.approvedBy, 'operator');
        assert.strictEqual(p.at, '2026-09-22T07:00:00.000Z');
        assert.deepStrictEqual(p.stagedIds, [A, B]);
        assert.strictEqual(p.dispatchedCard, A);
        assert.strictEqual(p.team, 'coding-team');
        assert.strictEqual(p.teamPolicy, 'pool');
        assert.strictEqual(p.orderSource, 'dependency-order');
    });

    await test('an unconfigured Navigator is TAGGED in the record rather than silently blank', async () => {
        const h = fakePorts({ members: [A], rows: [row(A)], unconfigured: true });
        const outcome = await navigator.startMission({ missionId: 'm1' }, h.ports);
        assert.strictEqual(outcome.kind, 'started', 'the start is mechanical — it does not need a model');
        assert.strictEqual(outcome.modelId, '');
        assert.ok(/navigator-slot-unreadable/.test(outcome.authorSource), outcome.authorSource);
        assert.ok(/navigator-slot-unreadable/.test(h.writes.provenance[0].authorSource));
    });

    await test('the start touches no coding_rounds, and its order is the sort of the dependency edges', async () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'standalone', 'controller', 'navigator.ts'), 'utf8');
        assert.ok(!/coding_rounds/.test(src), 'the unit of the first dispatch is one card, not one round');
        assert.ok(!/\.appendQueuePositions\s*\(/.test(src),
            'the staging write is reached through the port; this module has no store to call it on');
        assert.ok(src.includes('stageMembers') && src.includes('markReady') && src.includes('dispatchCard'),
            'paired positive: the three writes are the staging, the approval and the one dispatch');
        assert.ok(!/dispatchNextFromQueue/.test(src), 'the Navigator dispatches one card; it does not drive the queue');
    });

    // ══ The route, against a real board ════════════════════════════════════

    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-navstart-')));
    fs.mkdirSync(path.join(tmpRoot, '.switchboard', 'plans'), { recursive: true });
    const db = KanbanDatabase.forWorkspace(tmpRoot);
    {
        const dbDir = path.dirname(db.dbPath);
        if (!fs.existsSync(dbDir)) { fs.mkdirSync(dbDir, { recursive: true }); }
        if (!fs.existsSync(db.dbPath)) { fs.writeFileSync(db.dbPath, Buffer.alloc(0)); }
        assert.ok(await db.ensureReady(), 'seeded kanban.db must initialise');
    }
    const wsId = (await db.getWorkspaceId()) || (await db.getDominantWorkspaceId()) || 'navstart-ws';

    const P1 = 'start-one', P2 = 'start-two', OTHER = 'other-card';
    async function seedPlan(planId) {
        const rel = `.switchboard/plans/${planId}.md`;
        fs.writeFileSync(path.join(tmpRoot, rel), `# ${planId}\n\n## Goal\nsomething about ${planId}\n`, 'utf8');
        const now = new Date().toISOString();
        assert.ok(await db.insertFileDerivedPlan({
            planId, sessionId: planId, topic: 'topic ' + planId, planFile: rel,
            status: 'active', complexity: '3', tags: '', project: '', workspaceId: wsId,
            createdAt: now, updatedAt: now, sourceType: 'local', workspaceName: 'navstart',
            isFeature: 0,
        }), `seedPlan(${planId}) must insert`);
    }
    for (const id of [P1, P2, OTHER]) { await seedPlan(id); }

    // Another mission's card is already staged, so the workspace-wide maximum the
    // new mission's positions must clear is not zero.
    const otherMission = await db.createMission({ name: 'older mission', type: 'mission', workspaceId: wsId });
    await db.claimIntoMission(otherMission.id, OTHER, 'plan', { by: 'test' });
    assert.ok(await db.appendQueuePositions(wsId, [OTHER], otherMission.id), 'the older mission stages first');

    const m = await db.createMission({ name: 'start mission', goal: 'order these', type: 'mission', workspaceId: wsId });
    for (const id of [P2, P1]) { await db.claimIntoMission(m.id, id, 'plan', { by: 'test' }); } // insertion order P2, P1
    await db.updateMission(m.id, { team: 'coding-team' });
    assert.ok(await db.setPlanDependencies(P2, [P1]), 'P2 waits on P1');
    assert.ok(await db.setMapFingerprint(P2, 'fingerprint-for-test'));

    await db.setConfigJson(AGENT_GROUPS_KEY, [
        { id: 'coding-team', name: 'Coding', headRole: 'coder', enabled: true, automatedDispatch: 'pool', automatedDispatchSource: 'config', members: [{ role: 'intern', count: 1 }] },
    ]);
    await db.setConfigJson(TEAM_GROUPS_KEY, [
        { id: 'team_Coding', name: 'Coding Coder', head: 'Coding Coder', headRole: 'coder', teamKind: 'spawned', definitionId: 'coding-team', members: ['Coding Intern'], order: ['Coding Coder', 'Coding Intern'] },
    ]);

    await GlobalIntegrationConfigService.setAgentConfig('agentControlNavigatorProvider', 'stubnav');
    await GlobalIntegrationConfigService.setAgentConfig('agentControlProviders', {
        stubnav: { endpoint: 'http://127.0.0.1:1/v1/chat/completions', model: 'stub-model' },
    });

    const reports = [];
    const dispatches = [];
    const server = new LocalApiServer({
        clickupMetadataPath: '', linearMetadataPath: '',
        getClickUpService: () => null, getLinearService: () => null, getNotionService: () => null,
        getAuthToken: async () => '',
        allRoots: [tmpRoot], workspaceRoot: tmpRoot,
        getKanbanDatabase: async () => db,
        controllerStore: { writeReport: async (root, req) => { reports.push({ root, req }); return { success: true }; } },
        terminalVerb: async () => ({ terminals: [{ friendlyName: 'Coding Coder', status: 'active', role: 'coder' }, { friendlyName: 'Coding Intern', status: 'active', role: 'intern' }] }),
        armQueueWatch: async () => { /* not under test */ },
    });
    // The dispatch machinery needs a live fleet and a pty to deliver for real;
    // what this suite asserts is that the START calls it exactly once, for the
    // head, on the mission's team. (Same harness shape as
    // mission-release-column-contract.test.js.)
    server.performKanbanDispatch = async (workspaceRoot, ref, targetColumn, opts) => {
        dispatches.push({ ref, targetColumn, seat: opts && opts.targetTerminalOverride });
        return { status: 200, payload: { success: true, planId: ref, delivery: 'delivered' } };
    };

    async function request(method, url, body) {
        const headers = { 'content-type': 'application/json', 'host': '127.0.0.1:7777', 'x-switchboard-client': 'navigator-start-contract' };
        const req = {
            method, url, headers,
            on: (event, cb) => { if (event === 'data') cb(Buffer.from(JSON.stringify(body || {}))); else if (event === 'end') cb(); },
            socket: { destroy: () => {}, remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
        };
        let status = 0;
        let responseBody = null;
        const headerMap = {};
        const res = {
            headersSent: false,
            writeHead: (code, hdrs) => {
                status = code; res.statusCode = code; res.headersSent = true;
                if (hdrs && typeof hdrs === 'object') { for (const [k, v] of Object.entries(hdrs)) { headerMap[k.toLowerCase()] = v; } }
                return res;
            },
            setHeader: (k, v) => { headerMap[String(k).toLowerCase()] = v; },
            getHeader: (k) => headerMap[String(k).toLowerCase()],
            getHeaders: () => ({ ...headerMap }),
            removeHeader: (k) => { delete headerMap[String(k).toLowerCase()]; },
            write: (chunk) => { if (chunk) { responseBody = (responseBody || '') + String(chunk); } return true; },
            once: () => res, on: () => res, destroy: () => {},
            end: (data) => {
                if (data) { responseBody = (responseBody || '') + String(data); }
                responseBody = responseBody ? JSON.parse(responseBody) : null;
            },
        };
        await server._handleRequest(req, res);
        return { status, body: responseBody };
    }

    const start = (missionId) => request('POST', '/controller/navigator/start', { missionId });
    const progress = () => request('GET', '/kanban/missions/progress');
    const rowsById = async () => {
        const board = await db.getBoardWorkingSet(wsId);
        return new Map(board.map(r => [r.planId, r]));
    };

    let started = null;

    await test('before the start, no member of this mission is in STAGING', async () => {
        const before = await rowsById();
        assert.strictEqual(before.get(P1).kanbanColumn, 'CREATED');
        assert.strictEqual(before.get(P2).kanbanColumn, 'CREATED');
        const prog = await progress();
        const strip = (prog.body.data.missions || []).find(x => x.id === m.id);
        assert.strictEqual(strip.runState, 'not-started', 'the panel read carries the derived run state');
        assert.strictEqual(strip.ready, false);
    });

    await test('approving stages every member above the pre-start STAGING maximum, marks ready, and dispatches ONE card', async () => {
        const before = await rowsById();
        const preMax = Math.max(0, before.get(OTHER).columnOrder || 0);
        const r = await start(m.id);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.kind, 'started', JSON.stringify(r.body.outcome).slice(0, 500));
        started = r.body.outcome;

        const after = await rowsById();
        assert.strictEqual(after.get(P1).kanbanColumn, 'STAGING', 'every member is staged');
        assert.strictEqual(after.get(P2).kanbanColumn, 'STAGING');
        assert.ok(after.get(P1).columnOrder > preMax, `P1's position ${after.get(P1).columnOrder} must clear the pre-start max ${preMax}`);
        assert.ok(after.get(P2).columnOrder > preMax, `P2's position ${after.get(P2).columnOrder} must clear the pre-start max ${preMax}`);
        assert.ok(after.get(P2).columnOrder > after.get(P1).columnOrder, 'and the recorded order is preserved: P1 before P2');
        assert.ok(after.get(OTHER).columnOrder < after.get(P1).columnOrder, 'the older mission\'s card is not overtaken');

        const missionRow = await db.getMissionById(m.id);
        assert.strictEqual(missionRow.ready, true, 'missions.ready is set');

        assert.strictEqual(dispatches.length, 1, 'exactly ONE card is dispatched by the Navigator');
        assert.strictEqual(dispatches[0].ref, P1, 'and it is the head of the dependency order');
        assert.strictEqual(dispatches[0].seat, 'Coding Coder', 'to the mission\'s own team head');
    });

    await test('the panel read shows the started mission from the board, not from the response', async () => {
        const prog = await progress();
        const strip = (prog.body.data.missions || []).find(x => x.id === m.id);
        assert.strictEqual(strip.ready, true);
        assert.ok(strip.cardsTotal === 2, `cardsTotal ${strip.cardsTotal}`);
        assert.deepStrictEqual(Object.keys(strip.columns), ['STAGING'], JSON.stringify(strip.columns));
        assert.strictEqual(strip.runState, 'not-started', 'no member is held yet — the queue has not popped');
    });

    await test('the second member is started by the QUEUE: the Navigator dispatched once and stopped', async () => {
        assert.strictEqual(dispatches.length, 1, 'a second dispatch would be the Navigator feeding the queue');
        assert.deepStrictEqual(started.stagedIds, [P1, P2]);
        assert.strictEqual(started.dispatchedCard, P1);
        const after = await rowsById();
        assert.strictEqual(after.get(P2).kanbanColumn, 'STAGING', 'the second card is waiting for automated dispatch');
    });

    await test('a second start of the same mission is refused, and writes nothing', async () => {
        // The queue has not popped, so runState is still not-started; mark it in
        // flight the way a dispatch would, and re-try.
        const rowP1 = await db.getPlanByPlanId(P1);
        await db.updateDispatchInfoByPlanFile(rowP1.planFile, rowP1.workspaceId || wsId, { ownerSeat: 'Coding Coder', dispatchedAgent: 'coder' });
        const before = await rowsById();
        const r = await start(m.id);
        assert.strictEqual(r.body.kind, 'already-started', JSON.stringify(r.body).slice(0, 300));
        assert.ok(/in-flight/.test(r.body.outcome.reason), r.body.outcome.reason);
        assert.strictEqual(dispatches.length, 1, 'no second dispatch');
        const after = await rowsById();
        for (const id of [P1, P2]) {
            assert.strictEqual(after.get(id).kanbanColumn, before.get(id).kanbanColumn, `${id} moved on a refused start`);
        }
    });

    await test('a refused start leaves every member where it was and missions.ready at 0', async () => {
        // A fresh mission whose team is switched to `never`.
        await db.setConfigJson(AGENT_GROUPS_KEY, [
            { id: 'coding-team', name: 'Coding', headRole: 'coder', enabled: true, automatedDispatch: 'never', automatedDispatchSource: 'config', members: [{ role: 'intern', count: 1 }] },
        ]);
        const refusedMission = await db.createMission({ name: 'refused mission', goal: 'g', type: 'mission', workspaceId: wsId });
        await db.claimIntoMission(refusedMission.id, OTHER, 'plan', { by: 'test' });
        await db.updateMission(refusedMission.id, { team: 'coding-team' });
        const before = await rowsById();
        const r = await start(refusedMission.id);
        assert.strictEqual(r.body.kind, 'team-unavailable', JSON.stringify(r.body).slice(0, 300));
        assert.ok(r.body.outcome.reason.includes("head of 'Coding' (automatedDispatch=never)"), r.body.outcome.reason);
        assert.ok(/source: config/.test(r.body.outcome.reason), r.body.outcome.reason);
        const after = await rowsById();
        assert.strictEqual(after.get(OTHER).kanbanColumn, before.get(OTHER).kanbanColumn, 'the member did not move');
        assert.strictEqual(after.get(OTHER).columnOrder, before.get(OTHER).columnOrder, 'and its position did not change');
        const missionRow = await db.getMissionById(refusedMission.id);
        assert.strictEqual(missionRow.ready, false, 'missions.ready stays 0 on a refusal');
        assert.strictEqual(dispatches.length, 1, 'and nothing was dispatched');
        // A refusal is not a start, so it appends no start entry.
        const reportsBefore = reports.length;
        await start(refusedMission.id);
        assert.strictEqual(reports.length, reportsBefore, 'a refusal writes no start entry — there was no start');
    });

    await test('zero rows written to coding_rounds by any start', async () => {
        const rounds = await db.getCodingRoundsByWorkspace(wsId);
        assert.strictEqual(rounds.length, 0, 'the unit of the first dispatch is one card, not one round');
    });

    await test('the start record reaches the controller report with the author, the order, the card and the team', async () => {
        assert.strictEqual(reports.length, 1, 'exactly one successful start, so exactly one entry');
        const r = reports[0];
        assert.strictEqual(r.req.from, 'navigator');
        assert.strictEqual(r.req.kind, 'mission-started');
        assert.ok(r.req.body.includes('approved by: operator'), r.req.body);
        assert.ok(r.req.body.includes('stubnav (stub-model)'), 'the author of record is named');
        assert.ok(r.req.body.includes('order source: dependency-order'), r.req.body);
        assert.ok(r.req.body.includes(`\`${P1}\` -> \`${P2}\``), 'the staged ids, in order');
        assert.ok(r.req.body.includes('automatedDispatch=pool'), 'the team and its policy');
        assert.ok(!/^### Actions$/m.test(r.req.body), 'no ### Actions heading — the panel\'s latest-report walk must not be hijacked');
    });

    fs.rmSync(tmpRoot, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) { process.exit(1); }
}

run().catch(err => { console.error(err); process.exit(1); });
