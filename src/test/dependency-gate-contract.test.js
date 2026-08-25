'use strict';

/**
 * Pop-time dependency gate — the behavioural contract of dependency-ordered
 * dispatch, plus the mission model's derived (never stored) run state.
 *
 * `staging-streams-parallel-dispatch-and-worktrees.md` asked for this gate to
 * have "its own test rather than being folded into the existing 409 path",
 * because it is a new refusal inside a critical section maintained for ~4,000
 * installs. The implementation shipped without one, and the first review pass
 * found three defects that no other gate could see:
 *
 *   1. The gate refused `candidates[0]` instead of filtering. Two independent
 *      chains staged together — A→B and X→Y — put B ahead of X the moment A
 *      dispatches, so the pop 409'd and never reached X. That breaks the plan's
 *      own invariant that independent chains dispatch concurrently, and the code
 *      it replaced said so in a comment: "Filter first, then sort, and the two
 *      never interact."
 *   2. A predecessor that had been archived out of the hot store resolved to
 *      "not found", which the gate read as "not complete" — a permanent 409 with
 *      no UI to clear it.
 *   3. `run_state` was a stored column. The shipped Mission Control panel's own
 *      comment says a stored copy means "in flight forever" the first time a run
 *      dies. It is now derived from the same asserted-completion fact the queue
 *      pop gates on.
 *
 * These are behavioural assertions against the shipped modules, driven with stub
 * seams and no `vscode`, in the same style as `queue-pipeline-contract.test.js`.
 */

const assert = require('assert');
const path = require('path');

require(path.join(process.cwd(), 'src', 'test', 'bootstrap', 'sandboxStateHome.js'));

const { LocalApiServer } = require(path.join(process.cwd(), 'out', 'services', 'LocalApiServer.js'));

let failures = 0;
async function check(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err && err.message ? err.message : err}`);
    }
}

const WS = '/tmp/dependency-gate-contract-ws';

function card(planId, kanbanColumn, extra = {}) {
    return {
        planId,
        sessionId: planId,
        topic: planId,
        kanbanColumn,
        featureId: '',
        dispatchedAt: null,
        dispatchedTerminal: '',
        queuePosition: null,
        completedAt: null,
        ...extra,
    };
}

/**
 * A server wired with a dependency edge table.
 *
 * `edges` maps planId → the planIds it depends on. `coldStore` holds rows that
 * have left the hot store (archived), reachable only through
 * `getPlanByPlanIdUnion` — the archival case that used to deadlock the pop.
 */
function makeServer(board, { edges = {}, coldStore = {}, omitDependencyApi = false } = {}) {
    const dispatched = [];
    const db = {
        getWorkspaceId: async () => 'ws1',
        getDominantWorkspaceId: async () => 'ws1',
        getBoard: async () => board,
        getConfigJson: async (key, fallback) => fallback,
        setConfigJson: async () => {},
        getPlanByPlanId: async (planId) => board.find(p => p.planId === planId) || null,
        getPlanByPlanIdUnion: async (planId) =>
            board.find(p => p.planId === planId) || coldStore[planId] || null,
    };
    if (!omitDependencyApi) {
        db.getPlanDependencies = async (planId) => edges[planId] || [];
    }
    const server = new LocalApiServer({
        clickupMetadataPath: '',
        linearMetadataPath: '',
        getClickUpService: () => null,
        getLinearService: () => null,
        getNotionService: () => null,
        getAuthToken: async () => '',
        allRoots: [WS],
        workspaceRoot: WS,
        getKanbanDatabase: async () => db,
        armQueueWatch: async () => {},
    });
    server.performKanbanDispatch = async (workspaceRoot, planId) => {
        dispatched.push(planId);
        return { status: 200, payload: { success: true, planId, moved: true, dispatched: true } };
    };
    return { server, dispatched };
}

async function run() {
    console.log('\ndependency gate contract\n');

    // ── The gate itself ────────────────────────────────────────────────────

    await check('a card whose predecessor has not asserted completion is refused', async () => {
        const board = [
            card('A', 'CODER CODED', { dispatchedAt: '2026-08-25T00:00:00Z', completedAt: null }),
            card('B', 'STAGING', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer(board, { edges: { B: ['A'] } });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 409, 'B depends on an uncompleted A — the pop must refuse');
        assert.deepStrictEqual(dispatched, [], 'nothing may be dispatched while a predecessor is incomplete');
        assert.ok(
            out.payload.dependencyBlocked && out.payload.dependencyBlocked.blockedBy === 'A',
            'the refusal must NAME the blocking predecessor, not just refuse'
        );
    });

    await check('the same card is handed out once its predecessor asserts completion', async () => {
        const board = [
            card('A', 'CODER CODED', { dispatchedAt: '2026-08-25T00:00:00Z', completedAt: '2026-08-25T01:00:00Z' }),
            card('B', 'STAGING', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer(board, { edges: { B: ['A'] } });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatched, ['B'],
            'completed_at on A is the ONLY fact that releases B — asserted, never inferred from column');
    });

    // ── Eligibility is a filter, not a refusal on the head ────────────────

    await check('a blocked head does not block an independent chain behind it', async () => {
        // Two chains staged in one Analyze run: A→B and X→Y. A has dispatched,
        // so B sits at the head of the queue, blocked. X is independent and must
        // still be dispatchable — the plan's "parallel streams are concurrent"
        // invariant. A refusal on candidates[0] never reaches X.
        const board = [
            card('A', 'CODER CODED', { dispatchedAt: '2026-08-25T00:00:00Z', completedAt: null }),
            card('B', 'STAGING', { queuePosition: 1 }),
            card('X', 'STAGING', { queuePosition: 2 }),
            card('Y', 'STAGING', { queuePosition: 3 }),
        ];
        const { server, dispatched } = makeServer(board, { edges: { B: ['A'], Y: ['X'] } });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200,
            'a blocked head must be filtered out of the candidate list, not 409 the whole pop');
        assert.deepStrictEqual(dispatched, ['X'],
            'the pop must skip blocked B and take independent X — head-of-line blocking is the defect');
    });

    await check('the pop refuses only when EVERY staged card is blocked', async () => {
        const board = [
            card('A', 'CODER CODED', { dispatchedAt: '2026-08-25T00:00:00Z', completedAt: null }),
            card('B', 'STAGING', { queuePosition: 1 }),
            card('C', 'STAGING', { queuePosition: 2 }),
        ];
        const { server, dispatched } = makeServer(board, { edges: { B: ['A'], C: ['A'] } });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 409, 'with no unblocked candidate the pop refuses');
        assert.strictEqual(out.payload.dependencyBlocked.planId, 'B',
            'the refusal names the highest-precedence blocked card, not an arbitrary one');
        assert.deepStrictEqual(dispatched, []);
    });

    await check('a chain dispatches in order without re-running the analysis', async () => {
        // A→B→C staged together. Drive the whole chain by asserting completion,
        // never by re-analysing.
        const board = [
            card('A', 'STAGING', { queuePosition: 1 }),
            card('B', 'STAGING', { queuePosition: 2 }),
            card('C', 'STAGING', { queuePosition: 3 }),
        ];
        const edges = { B: ['A'], C: ['B'] };
        const { server, dispatched } = makeServer(board, { edges });
        const advance = async (planId) => {
            const row = board.find(p => p.planId === planId);
            row.kanbanColumn = 'CODER CODED';
            row.dispatchedAt = '2026-08-25T00:00:00Z';
            row.completedAt = '2026-08-25T01:00:00Z';
        };
        for (const expected of ['A', 'B', 'C']) {
            const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
            assert.strictEqual(out.status, 200, `pop for ${expected} must succeed`);
            await advance(expected);
        }
        assert.deepStrictEqual(dispatched, ['A', 'B', 'C'],
            'the persisted edges alone must order the chain — no second Analyze pass');
    });

    // ── The archival deadlock ─────────────────────────────────────────────

    await check('a completed predecessor archived out of the hot store does not block forever', async () => {
        const board = [card('B', 'STAGING', { queuePosition: 1 })];
        const coldStore = {
            A: card('A', 'COMPLETED', { dispatchedAt: '2026-08-20T00:00:00Z', completedAt: '2026-08-21T00:00:00Z' }),
        };
        const { server, dispatched } = makeServer(board, { edges: { B: ['A'] }, coldStore });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200,
            'an archived predecessor must be resolved through the union store, not read as incomplete');
        assert.deepStrictEqual(dispatched, ['B']);
    });

    await check('an edge to a plan that no longer exists is stale, not a permanent block', async () => {
        // A deleted predecessor can never assert completion, so treating the
        // edge as blocking deadlocks the queue with nothing to clear it.
        const board = [card('B', 'STAGING', { queuePosition: 1 })];
        const { server, dispatched } = makeServer(board, { edges: { B: ['ghost'] } });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200, 'a dangling edge must not deadlock the queue');
        assert.deepStrictEqual(dispatched, ['B']);
    });

    // ── NULL-inert ────────────────────────────────────────────────────────

    await check('with no edges the queue behaves exactly as before', async () => {
        const board = [
            card('a', 'STAGING', { queuePosition: 2 }),
            card('b', 'STAGING', { queuePosition: 7 }),
        ];
        const { server, dispatched } = makeServer(board, { edges: {} });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatched, ['a'], 'no edges → pure queue_position order');
    });

    await check('a host without the dependency API is not broken by the gate', async () => {
        // The gate is feature-detected: an older or stubbed db that has no
        // getPlanDependencies must still pop normally.
        const board = [card('only', 'STAGING', { queuePosition: 1 })];
        const { server, dispatched } = makeServer(board, { omitDependencyApi: true });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatched, ['only']);
    });

    await check('the gate runs AFTER the in-flight refusal, not instead of it', async () => {
        // A team already holding an uncompleted card is refused on in-flight
        // grounds, and the message must be the in-flight one — the two refusals
        // stay distinguishable.
        const board = [
            card('held', 'CODER CODED', { dispatchedTerminal: 'Coder 1', completedAt: null }),
            card('B', 'STAGING', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer(board, { edges: { B: ['held'] } });
        const out = await server.dispatchNextFromQueue({
            workspaceRoot: WS,
            from: 'Coder 1',
            resolveTeamMembers: undefined,
        });
        assert.strictEqual(out.status, 409);
        assert.ok(out.payload.inFlight, 'the in-flight refusal must win — it is checked first');
        assert.ok(!out.payload.dependencyBlocked, 'the dependency gate must not shadow the in-flight refusal');
        assert.deepStrictEqual(dispatched, []);
    });

    // ── Source contracts the behaviour above cannot reach ─────────────────

    await check('eligibility is applied as a filter over candidates, never as a refusal on candidates[0]', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const i = src.indexOf('// ── Pop-time Dependency Gate');
        assert.notStrictEqual(i, -1, 'the pop-time dependency gate must exist in _runQueuePop');
        const block = src.slice(i, src.indexOf('// ── Dispatch ─', i));
        assert.ok(
            /dependencyBlockers/.test(block),
            'the gate must compute a blocked set — a check on the chosen card alone head-of-line blocks independent chains'
        );
        const predicate = src.slice(src.indexOf('const isQueueable = (p: any)'), src.indexOf('const byPrecedence'));
        assert.ok(
            /dependencyBlockers\.has/.test(predicate),
            'isQueueable must consult the blocked set — the pop\'s own contract says eligibility belongs in the predicate, as a filter'
        );
        assert.ok(
            /const next = candidates\[0\];/.test(src),
            'the pop must still take the first candidate outright — no star exception, no post-selection refusal'
        );
        assert.ok(
            /getPlanByPlanIdUnion/.test(block),
            'the predecessor lookup must reach the cold store, or an archived predecessor blocks forever'
        );
    });

    await check('no mission stores its run state', () => {
        const fs = require('fs');
        const dbSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanDatabase.ts'), 'utf8');
        assert.ok(
            !/run_state/.test(dbSrc),
            'launched-ness must not be persisted in any column — a stored copy reads "in-flight forever" after a run dies'
        );
        assert.ok(
            /_deriveMissionRunState/.test(dbSrc),
            'runState must be derived from member state on read'
        );
        const provSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        assert.ok(
            !/updateMission\([^)]*\{\s*runState/.test(provSrc),
            'no verb arm may write runState'
        );
    });

    await check('a dependency cycle is refused at the write, not discovered at dispatch', () => {
        const fs = require('fs');
        const dbSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanDatabase.ts'), 'utf8');
        assert.ok(/findDependencyCycle/.test(dbSrc), 'the db must expose a cycle check');
        const addFn = dbSrc.slice(dbSrc.indexOf('public async addPlanDependency('));
        assert.ok(
            /findDependencyCycle/.test(addFn.slice(0, 400)),
            'addPlanDependency must refuse an edge that closes a cycle — otherwise every cycle member 409s every other one forever'
        );
        const setFn = dbSrc.slice(dbSrc.indexOf('public async setPlanDependencies('));
        assert.ok(
            /findDependencyCycle/.test(setFn.slice(0, 700)),
            'setPlanDependencies must refuse the whole write if any edge would cycle — a partial order is a silently wrong order'
        );
    });

    await check('the map fingerprint is written and read back, not just stored', () => {
        const fs = require('fs');
        const apiSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const i = apiSrc.indexOf('_handleKanbanDependencies');
        const block = apiSrc.slice(i, i + 6000);
        assert.ok(/setMapFingerprint/.test(block),
            'the dependency write path must accept the analysis-time fingerprint — a column nobody writes detects nothing');
        assert.ok(/getMapFingerprint/.test(block),
            'the read path must return the stored fingerprint so a later run can compare it');
        const skill = fs.readFileSync(
            path.join(process.cwd(), '.agents', 'protocols', 'dispatch-analysis', 'SKILL.md'), 'utf8');
        assert.ok(/mapFingerprint/.test(skill),
            'the analysis protocol must send the fingerprint it computes');
        assert.ok(/stale/i.test(skill),
            'the protocol must compare the fingerprint and report staleness — computing it and discarding it detects nothing');
    });

    await check('the analysis protocol keeps its unprovable-plan guardrails', () => {
        const fs = require('fs');
        const skill = fs.readFileSync(
            path.join(process.cwd(), '.agents', 'protocols', 'dispatch-analysis', 'SKILL.md'), 'utf8');
        for (const rule of [
            'never synthesize it',
            'Unprovable stays in Planned',
            'Conservative on conflicts',
            'Re-query the board',
        ]) {
            assert.ok(
                skill.includes(rule),
                `the rule "${rule}" must survive — dropping it turns an unreadable plan into a staged one`
            );
        }
    });

    console.log(`\n${failures === 0 ? 'all dependency-gate contracts passed' : `${failures} contract(s) failed`}\n`);
    process.exit(failures === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
