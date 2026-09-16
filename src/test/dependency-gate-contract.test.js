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

/**
 * The dispatch-analysis protocol body. Retired protocols were moved to control
 * plane rows (bodies in `bundledProtocols.ts`) and are materialized on setup, so
 * the source of truth is the bundle — reading the on-disk path alone makes this
 * test red on every checkout that has not run setup. Same pattern as
 * `skill-preconditions-contract.test.js`.
 */
function dispatchAnalysisBody() {
    const fs = require('fs');
    const disk = path.join(process.cwd(), '.agents', 'protocols', 'dispatch-analysis', 'SKILL.md');
    if (fs.existsSync(disk)) return fs.readFileSync(disk, 'utf8');
    const { BUNDLED_PROTOCOLS } = require(path.join(process.cwd(), 'out', 'services', 'bundledProtocols.js'));
    const bundled = BUNDLED_PROTOCOLS['dispatch-analysis'];
    assert.ok(bundled, 'dispatch-analysis must exist on disk or in the bundle');
    return bundled.body;
}

function card(planId, kanbanColumn, extra = {}) {
    return {
        planId,
        sessionId: planId,
        topic: planId,
        kanbanColumn,
        featureId: '',
        ownerSeat: '',
        ownerSince: null,
        columnOrder: null,
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

    await check('a card whose predecessor has not asserted completion is held, not dispatched', async () => {
        const board = [
            card('A', 'CODER CODED', { ownerSince: '2026-08-25T00:00:00Z', completedAt: null }),
            card('B', 'STAGING', { columnOrder: 1 }),
        ];
        const { server, dispatched } = makeServer(board, { edges: { B: ['A'] } });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        // V81: the board never refuses. A blocked pop is a 200 that reports
        // "not ready" and names the blocker — distinguishable from success by
        // `dispatched: null`, never by a non-2xx status.
        assert.strictEqual(out.status, 200, 'the board never refuses a dispatch — no 409');
        assert.strictEqual(out.payload.dispatched, null, 'nothing dispatched while a predecessor is incomplete');
        assert.deepStrictEqual(dispatched, []);
        assert.ok(
            out.payload.dependencyBlocked && out.payload.dependencyBlocked.blockedBy === 'A',
            'the not-ready body must NAME the blocking predecessor'
        );
    });

    await check('the same card is handed out once its predecessor asserts completion', async () => {
        const board = [
            card('A', 'CODER CODED', { ownerSince: '2026-08-25T00:00:00Z', completedAt: '2026-08-25T01:00:00Z' }),
            card('B', 'STAGING', { columnOrder: 1 }),
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
            card('A', 'CODER CODED', { ownerSince: '2026-08-25T00:00:00Z', completedAt: null }),
            card('B', 'STAGING', { columnOrder: 1 }),
            card('X', 'STAGING', { columnOrder: 2 }),
            card('Y', 'STAGING', { columnOrder: 3 }),
        ];
        const { server, dispatched } = makeServer(board, { edges: { B: ['A'], Y: ['X'] } });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200,
            'a blocked head must be filtered out of the candidate list, not 409 the whole pop');
        assert.deepStrictEqual(dispatched, ['X'],
            'the pop must skip blocked B and take independent X — head-of-line blocking is the defect');
    });

    await check('the pop reports not-ready only when EVERY staged card is blocked', async () => {
        const board = [
            card('A', 'CODER CODED', { ownerSince: '2026-08-25T00:00:00Z', completedAt: null }),
            card('B', 'STAGING', { columnOrder: 1 }),
            card('C', 'STAGING', { columnOrder: 2 }),
        ];
        const { server, dispatched } = makeServer(board, { edges: { B: ['A'], C: ['A'] } });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200, 'with no unblocked candidate the pop is still a 200 — not ready, never refused');
        assert.strictEqual(out.payload.dispatched, null);
        assert.strictEqual(out.payload.dependencyBlocked.planId, 'B',
            'the not-ready body names the highest-precedence blocked card, not an arbitrary one');
        assert.deepStrictEqual(dispatched, []);
    });

    await check('a chain dispatches in order without re-running the analysis', async () => {
        // A→B→C staged together. Drive the whole chain by asserting completion,
        // never by re-analysing.
        const board = [
            card('A', 'STAGING', { columnOrder: 1 }),
            card('B', 'STAGING', { columnOrder: 2 }),
            card('C', 'STAGING', { columnOrder: 3 }),
        ];
        const edges = { B: ['A'], C: ['B'] };
        const { server, dispatched } = makeServer(board, { edges });
        const advance = async (planId) => {
            const row = board.find(p => p.planId === planId);
            row.kanbanColumn = 'CODER CODED';
            row.ownerSince = '2026-08-25T00:00:00Z';
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
        const board = [card('B', 'STAGING', { columnOrder: 1 })];
        const coldStore = {
            A: card('A', 'COMPLETED', { ownerSince: '2026-08-20T00:00:00Z', completedAt: '2026-08-21T00:00:00Z' }),
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
        const board = [card('B', 'STAGING', { columnOrder: 1 })];
        const { server, dispatched } = makeServer(board, { edges: { B: ['ghost'] } });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200, 'a dangling edge must not deadlock the queue');
        assert.deepStrictEqual(dispatched, ['B']);
    });

    // ── NULL-inert ────────────────────────────────────────────────────────

    await check('with no edges the queue behaves exactly as before', async () => {
        const board = [
            card('a', 'STAGING', { columnOrder: 2 }),
            card('b', 'STAGING', { columnOrder: 7 }),
        ];
        const { server, dispatched } = makeServer(board, { edges: {} });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatched, ['a'], 'no edges → pure queue_position order');
    });

    await check('a host without the dependency API is not broken by the gate', async () => {
        // The gate is feature-detected: an older or stubbed db that has no
        // getPlanDependencies must still pop normally.
        const board = [card('only', 'STAGING', { columnOrder: 1 })];
        const { server, dispatched } = makeServer(board, { omitDependencyApi: true });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatched, ['only']);
    });

    await check('ownership never gates the pop — the dependency gate is the only filter', async () => {
        // V81 deleted the in-flight refusal. A card owned by a seat does not
        // make the pop refuse, and it does not shadow the dependency gate: the
        // only thing that can hold a card back is an unmet dependency.
        const board = [
            card('held', 'CODER CODED', { ownerSeat: 'Coder 1', ownerSince: '2026-08-25T00:00:00Z', completedAt: null }),
            card('B', 'STAGING', { columnOrder: 1 }),
        ];
        const { server, dispatched } = makeServer(board, { edges: {} });
        const out = await server.dispatchNextFromQueue({
            workspaceRoot: WS,
            from: 'Coder 1',
            resolveTeamMembers: undefined,
        });
        assert.strictEqual(out.status, 200, 'an owned card never refuses the pop');
        assert.ok(!out.payload.inFlight, 'no in-flight refusal exists');
        assert.ok(!out.payload.dependencyBlocked, 'no dependency edge → no blocker');
        assert.deepStrictEqual(dispatched, ['B'], 'the next staged card is handed out');
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
        // The readiness rule moved to the ONE shared predicate (kanbanOrdering's
        // isDependencyReady) so the pop and the sendable filter cannot drift. The
        // gate now delegates; the cold-store lookup lives in the source builder it
        // is handed. Asserting the lookup inside the gate block would pin the
        // duplication this refactor removed.
        assert.ok(
            /isDependencyReady\(String\(p\.planId\), readiness\)/.test(block),
            'the gate must call the shared readiness predicate'
        );
        const builder = src.slice(src.indexOf('_dependencyReadinessSource(db: any, board: any[])'), src.indexOf('_handleGetSendable'));
        assert.ok(
            /getPlanByPlanIdUnion/.test(builder),
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
        const skill = dispatchAnalysisBody();
        assert.ok(/mapFingerprint/.test(skill),
            'the analysis protocol must send the fingerprint it computes');
        assert.ok(/stale/i.test(skill),
            'the protocol must compare the fingerprint and report staleness — computing it and discarding it detects nothing');
    });

    await check('the analysis protocol keeps its unprovable-plan guardrails', () => {
        const skill = dispatchAnalysisBody();
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

    // ─── The shipped panel lights up ───────────────────────────────────────
    // The plan is explicit that nothing else catches this: "A mission model that
    // satisfies the plan but not this list leaves 43 KB of finished UI rendering
    // nothing, and no other check catches it." `mission-control.js` was in the
    // tree before any backend existed, so its field names and verb names are the
    // contract — not the other way round.

    await check('every mission field the panel reads is produced by the backend', () => {
        const fs = require('fs');
        const panel = fs.readFileSync(
            path.join(process.cwd(), 'src', 'webview', 'mission-control.js'), 'utf8');
        const dbSrc = fs.readFileSync(
            path.join(process.cwd(), 'src', 'services', 'KanbanDatabase.ts'), 'utf8');

        // Whatever the panel dereferences off a mission object, the db must emit.
        const read = new Set();
        for (const m of panel.matchAll(/\bm\.([a-zA-Z][a-zA-Z0-9]*)/g)) read.add(m[1]);
        assert.ok(read.size >= 10, `expected the panel to read a mission's fields, found ${read.size}`);

        const missionShape = dbSrc.slice(
            dbSrc.indexOf('public async getMissions('),
            dbSrc.indexOf('public async createMission(')
        );
        assert.ok(missionShape.length > 0, 'getMissions..createMission block must exist');

        for (const field of read) {
            // runState/sequencing are filled by the derived-field hydrator, which
            // lives inside the same block.
            assert.ok(
                new RegExp(`\\b${field}\\s*[:=]`).test(missionShape),
                `the panel reads m.${field} but no mission reader populates it — that field renders blank forever`
            );
        }
    });

    await check('every mc* verb the panel posts has a handler and is in the generated allowlist', () => {
        const fs = require('fs');
        const panel = fs.readFileSync(
            path.join(process.cwd(), 'src', 'webview', 'mission-control.js'), 'utf8');
        const provider = fs.readFileSync(
            path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const allowlist = fs.readFileSync(
            path.join(process.cwd(), 'src', 'generated', 'verbAllowlist.ts'), 'utf8');
        const schemas = fs.readFileSync(
            path.join(process.cwd(), 'src', 'services', 'verbSchemas.ts'), 'utf8');

        const posted = new Set();
        for (const m of panel.matchAll(/type:\s*'(mc[A-Z][A-Za-z]*)'/g)) posted.add(m[1]);
        // Only the mission verbs — the Schedules tab is owned by the automation plan.
        const missionVerbs = [...posted].filter(v => /Mission/.test(v));
        assert.ok(
            missionVerbs.length >= 8,
            `expected the panel's mission verbs, found ${missionVerbs.length}: ${missionVerbs.join(', ')}`
        );
        missionVerbs.push('mcInit');

        for (const verb of missionVerbs) {
            assert.ok(
                provider.includes(`case '${verb}':`),
                `${verb} is posted by the panel with no handler arm — the button does nothing`
            );
            assert.ok(
                allowlist.includes(`'${verb}'`),
                `${verb} is missing from the generated allowlist — handleServiceVerb throws on every /kanban/verb/* call while the webview path works fine`
            );
            assert.ok(
                new RegExp(`\\b${verb}:\\s*\\{`).test(schemas),
                `${verb} has no verb schema — the HTTP path cannot validate it`
            );
        }
    });

    await check('no mc* arm reports a write it did not perform', () => {
        const fs = require('fs');
        const provider = fs.readFileSync(
            path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        // A dead control that returns success is worse than one that refuses: the
        // panel shows no error and the operator believes the member/launch landed.
        //
        // This originally asserted the arms said "not implemented", which pinned a
        // placeholder refusal. Launch, stop and add-member are now built, so the
        // durable form of the same contract is: no arm may return success on a path
        // where nothing was written.
        const arm = (verb) => {
            const start = provider.indexOf(`case '${verb}':`);
            assert.notStrictEqual(start, -1, `${verb} arm must exist`);
            return provider.slice(start, provider.indexOf("\n            case '", start + 10));
        };

        // add-member: a missing member id must refuse, not silently succeed.
        const add = arm('mcAddMissionMember');
        assert.ok(/No member to add/.test(add),
            'mcAddMissionMember must refuse when there is no member id — it used to return success '
            + 'having written nothing');
        assert.ok(/added \? \{ success: true \}/.test(add),
            'mcAddMissionMember must report the db result, not assume it');
        assert.ok(/member picker is not implemented/.test(add),
            'the refusal must say WHY — a picker does not exist, and the programmatic route does');

        // launch / stop: delegate, and pass the real outcome back.
        const launch = arm('mcLaunchMission');
        assert.ok(/launchMission\(/.test(launch) && /return result/.test(launch),
            'mcLaunchMission must return launchMission\'s actual result rather than fabricating success');
        const stop = arm('mcStopMission');
        assert.ok(/released > 0/.test(stop),
            'mcStopMission must refuse when it released nothing — otherwise Stop reports success on a '
            + 'mission that is not running');

        // and launchMission itself must refuse on every non-dispatching path.
        // V81 deleted the launch-time in-flight/completed guards: pressing Launch
        // again re-dispatches the head, which unconditionally resets owner and
        // completion state. Duplicate work is not a failure mode. What survives is
        // that a launch which dispatches NOTHING still refuses rather than
        // reporting success.
        const li = provider.indexOf('public async launchMission(');
        assert.notStrictEqual(li, -1, 'launchMission must exist');
        const body = provider.slice(li, provider.indexOf('\n    public ', li + 50));
        for (const [label, pattern] of [
            ['no members', /has no members/],
            // Run provisioning IS built now (item 7). The refusal it replaced —
            // "provisioning is not built" — is retired; the durable contract is
            // that a tree that cannot be cut still refuses rather than running in
            // the wrong checkout.
            ['the run worktree could not be cut', /Failed to provision run worktree/],
            ['no seated team', /No coding terminal is live/],
            ['dispatch refused', /Dispatch refused/],
        ]) {
            assert.ok(pattern.test(body),
                `launchMission must refuse in words when ${label} — a launch that dispatches nothing `
                + 'must not report success');
        }
        assert.ok(!/already in flight/.test(body) && !/already completed/.test(body),
            'V81 deleted the launch-time in-flight/completed guards — the board never refuses a dispatch');
    });

    await check('a mission codename is stable and collision-checked', () => {
        const { generateCodename } = require(
            path.join(process.cwd(), 'out', 'services', 'codenameGenerator.js'));
        const fs = require('fs');
        const dbSrc = fs.readFileSync(
            path.join(process.cwd(), 'src', 'services', 'KanbanDatabase.ts'), 'utf8');

        // Stable: the same seed always yields the same name, so a reload cannot
        // rename a mission the operator already referred to in a handoff.
        assert.strictEqual(generateCodename('mission-abc'), generateCodename('mission-abc'));
        assert.notStrictEqual(generateCodename('mission-abc', 0), generateCodename('mission-abc', 1));
        assert.ok(/^[a-z]+-[a-z]+$/.test(generateCodename('mission-abc')), 'a codename is {adjective}-{noun}');

        // Unique: creation must consult the existing names, not hash once and hope.
        // ~3,900 combinations collide well before a hundred missions.
        const create = dbSrc.slice(
            dbSrc.indexOf('public async createMission('),
            dbSrc.indexOf('public async updateMission(')
        );
        assert.ok(
            /_uniqueCodename/.test(create),
            'createMission must route the codename through the collision check — a bare generateCodename() call can name two missions the same thing'
        );
        assert.ok(
            /generateCodename\(seed, salt\)/.test(dbSrc),
            'the collision check must rehash with a salt, per the plan'
        );
    });

    await check('the pop-time gate refuses rather than fails open when a lookup faults', () => {
        const fs = require('fs');
        const src = fs.readFileSync(
            path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const start = src.indexOf('const dependencyBlockers = new Map<string, string>();');
        assert.notStrictEqual(start, -1, 'the dependency gate block must exist');
        const block = src.slice(start, src.indexOf('const isQueueable', start));
        assert.ok(
            !/dependencyBlockers\.clear\(\)/.test(block),
            'clearing the blockers on a fault deletes the gate and dispatches unverified dependents — the exact invariant the gate exists to hold'
        );
        assert.ok(
            /dependencyBlockers\.set\(String\(p\.planId\), '\(dependency lookup failed\)'\)/.test(block),
            'a per-card lookup fault must BLOCK that card; the gate exists to refuse, so its failure mode must be refusal'
        );
    });

    // ── Missions: reachable, produced, contained, launchable ──────────────

    await check('the Mission Control panel has a verb route', () => {
        const fs = require('fs');
        const api = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        assert.ok(/pathname\.startsWith\('\/mission-control\/verb\/'\)/.test(api),
            'transport.js derives a panel route from data-panel, so the panel posts to '
            + '/mission-control/verb/*. Without that arm every mc* verb 404s while the handlers, '
            + 'the allowlist and the catalog all look correct.');
    });

    await check('staging always joins a mission — no card stages outside one', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const i = src.indexOf('public async stageForQueue(');
        assert.notStrictEqual(i, -1, 'stageForQueue must exist');
        const body = src.slice(i, src.indexOf('\n    public ', i + 50));
        assert.ok(/resolveOrCreateOpenMission/.test(body),
            'stageForQueue must resolve or create a mission — item 10, "a drag into STAGING always '
            + 'succeeds; the only question is which mission receives it". Without it STAGING holds '
            + 'loose cards belonging to no mission and the missions table stays empty.');
        assert.ok(/addMissionMember/.test(body),
            'each staged card must be added as a member');
        assert.ok(/appendQueuePositions/.test(body),
            'queue_position must still be written — it is the intra-mission order');
    });

    await check('staging provisions no worktrees', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const i = src.indexOf('public async stageForQueue(');
        const body = src.slice(i, src.indexOf('\n    public ', i + 50));
        assert.ok(!/_ensureFeatureIntegrationWorktree|_createSafetyWorktree/.test(body),
            'staging must cut no branch. One worktree per staged feature put sibling branches off '
            + 'the default branch that could not see each other, and contradicted item 8c '
            + '("0 by default ... may never exceed 1").');
        assert.ok(!/_ensureFeatureIntegrationWorktree/.test(src),
            'the per-feature provisioning helper must be gone, not merely uncalled');
    });

    await check('a board card carries its mission, resolved in ONE place', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const i = src.indexOf('private async _buildBoardCards(');
        assert.notStrictEqual(i, -1, '_buildBoardCards must exist');
        const body = src.slice(i, i + 6000);
        assert.ok(/missionByMember/.test(body),
            'mission identity must be resolved in _buildBoardCards — every surface renders through '
            + 'it, so resolving anywhere else is how one site gets missed and a member leaks back '
            + 'onto the board as a loose card');
        assert.ok(/missionId:/.test(body) && /missionName:/.test(body),
            'cards must carry missionId and missionName');
    });

    await check('STAGING renders the mission as a card, and its members nowhere', () => {
        const fs = require('fs');
        const html = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'kanban.html'), 'utf8');
        // The interim grouping (a label above the member cards) is retired — item 1
        // replaces it with a real card, so the drag has something to drop onto.
        assert.ok(!/mission-group-label/.test(html),
            'the mission group label is retired — STAGING renders one mission CARD, not a label '
            + 'above loose member cards');
        assert.ok(/function createMissionCardHtml\(/.test(html),
            'a mission is not a plan (no complexity, no role routing, no advance) — it needs its '
            + 'own renderer, not createCardHtml');
        assert.ok(/\.kanban-card\.mission-card\s*\{/.test(html),
            'kanban.html is a self-contained webview — the rule belongs in its own inline style');
        // The containment predicate must be applied at BOTH sites (computeColumnOccupancy
        // and renderBoard) and must be SCOPED to STAGING: mission_members rows survive
        // dispatch, so an unscoped predicate hides every in-flight card from the board.
        const scoped = html.match(/!card\.featureId && !\(card\.missionId && [^;]*?'STAGING'\)/g) || [];
        assert.strictEqual(scoped.length, 2,
            'the mission containment filter must be applied at both renderBoard sites and scoped '
            + `to STAGING (found ${scoped.length})`);
        assert.ok(!/!card\.featureId && !card\.missionId/.test(html),
            'an unscoped !card.missionId predicate hides launched members from every column — '
            + 'the members move to a coding column and their membership row is never cleared');
    });

    await check('launch fans out through the pop and never writes a stored run flag', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const i = src.indexOf('public async launchMission(');
        assert.notStrictEqual(i, -1, 'launchMission must exist');
        const body = src.slice(i, src.indexOf('\n    public ', i + 50));
        // V81: the launch-time in-flight guard is deleted. Pressing Launch twice
        // re-dispatches the head; the dispatch write resets owner/completion
        // state unconditionally. There is no refusal to pin here.
        assert.ok(!/runState === 'in-flight'/.test(body),
            'launch must NOT refuse an in-flight mission — the board never refuses a dispatch (V81)');
        assert.ok(/dispatchNextFromQueue/.test(body),
            'launch must fan out through the queue pop — one dispatch path, so the pop-time '
            + 'dependency gate applies to a mission launch too');
        assert.ok(/maxExtraWorktrees/.test(body),
            'launch must honour maxExtraWorktrees rather than silently ignoring it');
        assert.ok(!/updateMission\([^)]*runState/.test(body),
            'launch must not write a run state — it is derived');
    });

    await check('stop clears the holder rather than writing a status', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const i = src.indexOf("case 'mcStopMission'");
        const body = src.slice(i, i + 2200);
        assert.ok(/clearOwnerStamp\(plan\.planFile/.test(body),
            'clearOwnerStamp is keyed by plan FILE + workspace id. Passing a plan id no-ops '
            + 'silently, which is a Stop button that reports success and stops nothing.');
        assert.ok(!/releaseDispatchHolder/.test(body),
            'releaseDispatchHolder was deleted with the release valve — stop uses the queue\'s own clearOwnerStamp');
    });

    await check('the operator can ask which mission it oversees', () => {
        const fs = require('fs');
        const api = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        assert.ok(/'\/kanban\/mission\/active'/.test(api),
            'an operation is supervised, so the operator must be able to resolve WHICH mission — '
            + 'adopt/start/confirm/handoff all take only { workspaceRoot }');
        const i = api.indexOf("'/kanban/mission/active'");
        const body = api.slice(i, i + 1200);
        assert.ok(/type === 'operation'/.test(body),
            "the response must distinguish supervised ('operation') from unsupervised ('mission')");
    });

    console.log(`\n${failures === 0 ? 'all dependency-gate contracts passed' : `${failures} contract(s) failed`}\n`);
    process.exit(failures === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
