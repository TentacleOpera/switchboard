/**
 * Mission 07 — a mission can be paused and resumed.
 *
 * Pause CANNOT be derived, which is why it is stored. `runState` is computed
 * from member state on every read (`_deriveMissionRunState`), so a paused
 * mission with no in-flight member is indistinguishable from one that never
 * started; `ready` is arm-ness, a different fact. So the fix is a stored
 * `missions.paused` (V85) plus one refusal inside the serialised pop.
 *
 * The cases below pin the four things a diff cannot show:
 *  - a paused mission delivers NOTHING, keeps its members and their queue order;
 *  - the refusal is distinguishable from "drained" and from "held" — three
 *    different strings, never collapsed;
 *  - resume continues from the next UNDELIVERED member, not the first, and never
 *    re-launches (no second worktree, no re-stamped owner);
 *  - a paused mission and an unarmed one are different strings on the card and
 *    different columns in the row.
 *
 * The last group are source-shape assertions on the call sites that must carry
 * the write: the card's pause button, the team-close pause, and the pop.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

require(path.join(process.cwd(), 'src', 'test', 'bootstrap', 'sandboxStateHome.js'));

const { LocalApiServer } = require(path.join(process.cwd(), 'out', 'services', 'LocalApiServer.js'));
const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

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

const WS = '/tmp/mission-pause-resume-ws';

/** A board row shaped the way `getBoard` returns them. */
function card(planId, kanbanColumn, extra = {}) {
    return {
        planId,
        sessionId: planId,
        topic: planId,
        kanbanColumn,
        featureId: '',
        ownerSince: null,
        ownerSeat: '',
        columnOrder: null,
        completedAt: null,
        ...extra,
    };
}

/**
 * A LocalApiServer wired with a mission-aware kanban db. `dispatched` records
 * every planId the pop actually sent — the only thing worth asserting; the pop's
 * contract is "which card, if any".
 */
function makeServer(board, opts = {}) {
    const dispatched = [];
    const config = new Map();
    const missions = opts.missions || {};
    const members = opts.members || {};
    const memberOf = opts.memberOf || {};
    const pauseCalls = [];
    const db = {
        getWorkspaceId: async () => 'ws1',
        getDominantWorkspaceId: async () => 'ws1',
        getBoard: async () => board,
        getConfigJson: async (key, fallback) => config.has(key) ? config.get(key) : fallback,
        setConfigJson: async (key, value) => { config.set(key, value); },
        getMissionById: async (id) => missions[id] || null,
        getMissionMembers: async (id) => (members[id] || []).map(memberId => ({ memberId, kind: 'plan' })),
        getMissionsForMember: async (planId) => memberOf[planId] || [],
        pauseMissionsForTeam: async (teamId, wsId) => {
            pauseCalls.push({ teamId, wsId });
            return { paused: opts.pauseResult || [], skipped: [] };
        },
        ...(opts.db || {}),
    };
    const server = new LocalApiServer({
        clickupMetadataPath: '',
        linearMetadataPath: '',
        getClickUpService: () => null,
        getLinearService: () => null,
        getNotionService: () => null,
        getAuthToken: async () => 'test-token',
        allRoots: [WS],
        workspaceRoot: WS,
        getKanbanDatabase: async () => db,
        resolveTeamMembers: opts.resolveTeamMembers,
        resolveTeamPacing: opts.resolveTeamPacing,
        getRegisteredTerminals: opts.getRegisteredTerminals,
        getFleetOrdersDatabase: opts.getFleetOrdersDatabase,
        clearTerminalContext: opts.clearTerminalContext || (async () => ({ cleared: true })),
        armQueueWatch: opts.armQueueWatch || (async () => { /* not under test */ }),
    });
    // Stub the dispatch machinery: this contract is about SELECTION, not about
    // what performKanbanDispatch does with the card. The card MOVES, because a
    // real dispatch moves it — a stub that left it in STAGING would let a second
    // pop hand out the same member.
    server.performKanbanDispatch = async (workspaceRoot, planId, targetColumn) => {
        dispatched.push(planId);
        const row = board.find(p => p && p.planId === planId);
        if (row) { row.kanbanColumn = targetColumn || 'LEAD CODED'; }
        return { status: 200, payload: { success: true, planId, moved: true, dispatched: true } };
    };
    return { server, dispatched, pauseCalls, db };
}

/** A five-member mission with two already delivered, and its queue order. */
function fiveMembers() {
    const board = [
        card('a-1', 'LEAD CODED', { columnOrder: 1 }),  // delivered
        card('a-2', 'LEAD CODED', { columnOrder: 2 }),  // delivered
        card('a-3', 'STAGING', { columnOrder: 3 }),     // the next undelivered
        card('a-4', 'STAGING', { columnOrder: 4 }),
        card('a-5', 'STAGING', { columnOrder: 5 }),
    ];
    const mission = { id: 'mission-a', workspaceId: 'ws1', team: '', paused: false, ready: false };
    return {
        board,
        mission,
        missions: { 'mission-a': mission },
        members: { 'mission-a': ['a-1', 'a-2', 'a-3', 'a-4', 'a-5'] },
        memberOf: Object.fromEntries(['a-1', 'a-2', 'a-3', 'a-4', 'a-5'].map(id => [id, ['mission-a']])),
    };
}

async function postPauseTeam(server, body) {
    const req = {
        method: 'POST',
        url: '/kanban/mission/pause-team',
        headers: {
            'content-type': 'application/json',
            'authorization': 'Bearer test-token',
            'x-switchboard-client': 'contract-test',
        },
        on: (event, cb) => {
            if (event === 'data') cb(Buffer.from(JSON.stringify(body)));
            else if (event === 'end') cb();
        },
        socket: { destroy: () => {}, remoteAddress: '127.0.0.1' },
    };
    let status = 0;
    let responseBody = null;
    const res = {
        writeHead: (code) => { status = code; },
        setHeader: () => {},
        getHeaders: () => ({}),
        getHeader: () => undefined,
        end: (data) => { responseBody = data ? JSON.parse(data) : null; },
    };
    await server._handleRequest(req, res);
    return { status, body: responseBody };
}

async function run() {
    console.log('\nmission pause/resume contract\n');

    await check('a paused mission delivers nothing and keeps its members and their queue order', async () => {
        const { board, missions, members, memberOf } = fiveMembers();
        missions['mission-a'].paused = true;
        const before = board.map(p => ({ planId: p.planId, column: p.kanbanColumn, order: p.columnOrder }));
        const { server, dispatched } = makeServer(board, { missions, members, memberOf });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding', missionId: 'mission-a' });
        assert.strictEqual(out.status, 200, 'a paused mission is not an error');
        assert.strictEqual(out.payload.dispatched, null);
        assert.deepStrictEqual(dispatched, [], 'a paused mission must release NOTHING');
        const after = board.map(p => ({ planId: p.planId, column: p.kanbanColumn, order: p.columnOrder }));
        assert.deepStrictEqual(after, before, 'a pause must not move a member or renumber the queue');
    });

    await check('a paused refusal is distinguishable from drained and from held', async () => {
        const { board, missions, members, memberOf } = fiveMembers();
        missions['mission-a'].paused = true;
        const { server } = makeServer(board, { missions, members, memberOf });
        const paused = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding', missionId: 'mission-a' });
        assert.ok(/paused/i.test(String(paused.payload.reason)),
            `the reason must name the pause, got '${paused.payload.reason}'`);
        assert.strictEqual(paused.payload.paused, true, 'the payload must carry the fact, not only prose');
        assert.notStrictEqual(paused.payload.reason, 'queue empty',
            '"paused" and "the mission is drained" must never render the same string');
        assert.ok(!/queue empty/.test(String(paused.payload.reason)),
            'a paused mission is not a drained mission — the two strings must differ');

        // The same mission, drained instead of paused: a different string.
        const drained = fiveMembers();
        drained.board.forEach(p => { if (p.planId.startsWith('a-')) { p.kanbanColumn = 'LEAD CODED'; } });
        const other = makeServer(drained.board, drained);
        const drainedOut = await other.server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding', missionId: 'mission-a' });
        assert.notStrictEqual(drainedOut.payload.reason, paused.payload.reason,
            'paused and drained must be two different reasons');
        assert.ok(/queue empty for mission mission-a/.test(String(drainedOut.payload.reason)));
    });

    await check('resume continues from the next UNDELIVERED member, not the first', async () => {
        const { board, missions, members, memberOf } = fiveMembers();
        missions['mission-a'].paused = true;
        const { server, dispatched } = makeServer(board, { missions, members, memberOf });

        const whilePaused = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding', missionId: 'mission-a' });
        assert.strictEqual(whilePaused.payload.dispatched, null);
        assert.deepStrictEqual(dispatched, [], 'nothing is delivered while paused');

        // Resume: clear the stored flag — no launch, no re-hold, no worktree.
        missions['mission-a'].paused = false;
        const afterResume = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding', missionId: 'mission-a' });
        assert.strictEqual(afterResume.status, 200, `expected 200, got ${afterResume.status}: ${afterResume.payload.error || ''}`);
        assert.deepStrictEqual(dispatched, ['a-3'],
            'the first member dispatched after a resume is the highest-precedence member STILL UNDELIVERED — a-1 and a-2 are already delivered');
    });

    await check('resume does not call launchMission (no second worktree, no re-stamped owner)', () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const i = src.indexOf('private async _runQueuePop(');
        assert.notStrictEqual(i, -1, '_runQueuePop must exist');
        const body = src.slice(i, src.indexOf('\n    private async ', i + 10));
        assert.ok(!/\blaunchMission\s*\(/.test(body),
            'the pop must never CALL launchMission — resume continues the drain, it does not re-launch');
        assert.ok(!/clearOwnerStamp/.test(body),
            'the pop must not clear owner stamps: pausing keeps the team held, and clearing is what makes a stop read as a release');
    });

    await check('a paused mission is refused inside the serialised pop, before any candidate work', () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const i = src.indexOf('private async _runQueuePop(');
        assert.notStrictEqual(i, -1, '_runQueuePop must exist');
        const body = src.slice(i, src.indexOf('\n    private async ', i + 10));
        assert.ok(/mission\.paused === true \|\| Number\(mission\.paused\) === 1/.test(body),
            'the pop must read the stored pause off the mission row');
        assert.ok(/paused: mission \$\{missionId\} is paused/.test(body),
            'the paused refusal must name the mission, so "paused" and "drained" differ');
        const pauseIdx = body.indexOf('mission.paused');
        const membersIdx = body.indexOf('getMissionMembers(missionId)');
        assert.ok(pauseIdx !== -1 && membersIdx !== -1 && pauseIdx < membersIdx,
            'the pause check belongs beside the member read, inside the serialised section — a caller-side check races a resume');
    });

    await check('paused and unarmed are different strings on the card and different columns in the row', () => {
        const html = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'kanban.html'), 'utf8');
        assert.ok(/mission-paused/.test(html), 'the card needs a PAUSED element');
        assert.ok(/mission-unarmed/.test(html), 'the card needs a distinct UNARMED element');
        assert.ok(/>PAUSED</.test(html), 'the paused chip must read PAUSED');
        assert.ok(/>UNARMED</.test(html), 'the unarmed chip must read UNARMED — never the same string');
        assert.ok(/const isPaused = mission\.paused === true/.test(html), 'the card reads the stored `paused` field');
        assert.ok(/const isUnarmed = mission\.ready !== true/.test(html), 'the card reads `ready` separately');
        assert.ok(/mission-pause-btn/.test(html), 'the card needs the pause/resume control');

        const db = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanDatabase.ts'), 'utf8');
        assert.ok(/ready\s+INTEGER DEFAULT 0,\s*\n\s*paused\s+INTEGER DEFAULT 0,/.test(db),
            '`ready` and `paused` must be two separate columns on a fresh DB — one field cannot hold both facts');
        assert.ok(/ALTER TABLE missions ADD COLUMN paused INTEGER DEFAULT 0/.test(db),
            'a shipped DB must be migrated to the paused column');
        assert.ok(/paused: Number\(r\.paused \|\| 0\) === 1/.test(db),
            'both mission reads must serve `paused`');
        assert.ok(/ready, paused, team/.test(db), 'the mission SELECTs must carry the column');
    });

    await check('an unrelated mission edit never silently unpauses a stopped mission', () => {
        const db = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanDatabase.ts'), 'utf8');
        const i = db.indexOf('public async updateMission(');
        assert.notStrictEqual(i, -1, 'updateMission must exist');
        const body = db.slice(i, db.indexOf('\n    /**', i));
        assert.ok(/updates\.paused !== undefined \? \(updates\.paused \? 1 : 0\) : \(existing\.paused \? 1 : 0\)/.test(body),
            'paused must be written only when named — a rename must not resume a stopped mission');
        assert.ok(/paused = \?/.test(body), 'the UPDATE must carry the paused column');
    });

    await check('the pause write survives a restart because it is stored, not derived', () => {
        const db = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanDatabase.ts'), 'utf8');
        const deriveStart = db.indexOf('private async _deriveMissionRunState(');
        assert.notStrictEqual(deriveStart, -1, '_deriveMissionRunState must exist');
        const deriveBody = db.slice(deriveStart, db.indexOf('\n    /**', deriveStart));
        assert.ok(!/paused/.test(deriveBody),
            'runState must not try to derive pause — a paused mission with no in-flight member is indistinguishable from an unstarted one');
        assert.ok(/paused INTEGER DEFAULT 0/.test(db), 'the fact lives in the row');
        const select = db.match(/SELECT id, name, type, goal, ready, paused, team[^\n]*FROM missions/g) || [];
        assert.strictEqual(select.length, 2, `both mission reads must select paused (found ${select.length})`);
    });

    await check('stopping a team pauses its mission instead of releasing it', async () => {
        const { board, missions, members, memberOf } = fiveMembers();
        const { server, pauseCalls } = makeServer(board, { missions, members, memberOf, pauseResult: ['mission-a'] });
        const out = await postPauseTeam(server, { teamId: 'team-coding' });
        assert.strictEqual(out.status, 200, `expected 200, got ${out.status}: ${out.body && out.body.error}`);
        assert.deepStrictEqual(pauseCalls, [{ teamId: 'team-coding', wsId: 'ws1' }],
            'the route must hand the helper the team and the workspace it resolved');
        assert.deepStrictEqual(out.body.paused, ['mission-a'], 'the paused missions must be reported');
        assert.ok(Array.isArray(out.body.skipped), 'nothing may be silently dropped — the skips are reported');
    });

    await check('the pause-team route refuses a request with no team', async () => {
        const { board, missions, members, memberOf } = fiveMembers();
        const { server, pauseCalls } = makeServer(board, { missions, members, memberOf });
        const out = await postPauseTeam(server, {});
        assert.strictEqual(out.status, 400, 'a nameless team must refuse loudly');
        assert.deepStrictEqual(pauseCalls, [], 'nothing is paused on a refused request');
    });

    await check('pauseMissionsForTeam pauses only the undelivered, and says what it skipped', async () => {
        // The helper itself, against a stub `this` — the real body, not a copy.
        const missions = [
            { id: 'm-undelivered', team: 'team-coding', paused: false, plans: ['u-1', 'u-2'], features: [] },
            { id: 'm-delivered', team: 'team-coding', paused: false, plans: ['d-1'], features: [] },
            { id: 'm-other-team', team: 'team-review', paused: false, plans: ['x-1'], features: [] },
            { id: 'm-already', team: 'team-coding', paused: true, plans: ['p-1'], features: [] },
        ];
        const board = [
            card('u-1', 'LEAD CODED', { columnOrder: 1 }),  // delivered
            card('u-2', 'STAGING', { columnOrder: 2 }),     // undelivered
            card('d-1', 'LEAD CODED', { columnOrder: 3 }),  // delivered
            card('x-1', 'STAGING', { columnOrder: 4 }),
            card('p-1', 'STAGING', { columnOrder: 5 }),
        ];
        const writes = [];
        const stub = {
            ensureReady: async () => true,
            _db: {},
            getMissions: async () => missions,
            getBoard: async () => board,
            updateMission: async (id, updates) => { writes.push({ id, updates }); return true; },
        };
        const result = await KanbanDatabase.prototype.pauseMissionsForTeam.call(stub, 'team-coding', 'ws1');
        assert.deepStrictEqual(result.paused, ['m-undelivered'],
            'only a mission of THIS team with a member still in STAGING is paused');
        assert.deepStrictEqual(writes, [{ id: 'm-undelivered', updates: { paused: true } }],
            'the write is `paused = 1` and nothing else — no member is moved, no owner stamp is cleared');
        const skippedIds = result.skipped.map(s => s.missionId).sort();
        assert.deepStrictEqual(skippedIds, ['m-already', 'm-delivered'],
            'a fully delivered mission and an already-paused one are both reported, not silently dropped');
        const deliveredSkip = result.skipped.find(s => s.missionId === 'm-delivered');
        assert.ok(/delivered/i.test(deliveredSkip.reason),
            `the delivered skip must say why, got '${deliveredSkip.reason}'`);
    });

    await check('the operator stop path is ONE server call, and the route carries the pause', () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'terminals.js'), 'utf8');
        const i = src.indexOf('async function closeTeam()');
        assert.notStrictEqual(i, -1, 'closeTeam must exist — it is the operator gesture that stops a team');
        const body = src.slice(i, src.indexOf('\n    }', i));
        assert.ok(/\/kanban\/team\/stop/.test(body),
            'stopping a team must be ONE board call — the board owns pause + release + close as one operation');
        assert.ok(!/ptyCloseTerminal/.test(body),
            'the client-side fan-out must be gone: two implementations of one operation are free to diverge');
        assert.ok(/snap\.definitionId/.test(body), 'the stop names the team by its definition id');

        const api = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        assert.ok(/'\/kanban\/mission\/pause-team'/.test(api), 'the route must exist');
        assert.ok(/pauseMissionsForTeam/.test(api), 'the route must reach the one helper that writes the pause');

        // The pause is step 1 of the stop route, and it runs BEFORE the seats
        // die — otherwise a mission is wedged with no way back.
        const routeStart = api.indexOf("pathname === '/kanban/team/stop'");
        assert.ok(routeStart > 0, 'the stop route must exist');
        const routeEnd = api.indexOf("pathname === '/kanban/", routeStart + 1);
        const route = api.slice(routeStart, routeEnd > routeStart ? routeEnd : routeStart + 6000);
        const pauseIdx = route.indexOf('pauseMissionsForTeam');
        const releaseIdx = route.indexOf('_releaseHeldCardsForSeats');
        const closeIdx = route.indexOf('_closeTeamSeats');
        assert.ok(pauseIdx > 0 && releaseIdx > 0 && closeIdx > 0, 'all three steps must run in the route');
        assert.ok(pauseIdx < releaseIdx && releaseIdx < closeIdx,
            'the order is load-bearing: pause, then release, then close — closing first produces orphans');
    });

    await check('the card pause control rides the existing mission verb', () => {
        const html = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'kanban.html'), 'utf8');
        const i = html.indexOf('const pauseBtn = e.target.closest');
        assert.notStrictEqual(i, -1, 'the pause button needs a handler');
        const body = html.slice(i, i + 700);
        assert.ok(/type: 'mcUpdateMission'/.test(body),
            'pause/resume must ride the existing mission update verb — no second write path for the drain to disagree with');
        assert.ok(/field: 'paused'/.test(body), 'the write names the stored field');

        const provider = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const setMatch = provider.match(/const MC_EDITABLE = new Set\(\[[^\]]*\]\)/);
        assert.ok(setMatch, 'MC_EDITABLE must exist');
        assert.ok(/'paused'/.test(setMatch[0]), 'paused must be editable through the panel verb');
        assert.ok(/String\(msg\.field\) === 'paused'/.test(provider),
            'a paused edit must refresh the BOARD, where the card renders the state the operator just changed');
    });

    await check('launching a paused mission says it is paused, not a bare refusal', () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const i = src.indexOf('public async launchMission(');
        assert.notStrictEqual(i, -1, 'launchMission must exist');
        const body = src.slice(i, src.indexOf('\n    /**', i));
        assert.ok(/pausedRefusal/.test(body), 'the launch must recognise the pop\'s pause refusal');
        assert.ok(/Mission is paused/.test(body), 'and name it, rather than returning "Dispatch refused."');
    });

    if (failures > 0) {
        console.log(`\n${failures} mission pause/resume check(s) failed\n`);
        process.exit(1);
    }
    console.log('\nAll mission pause/resume checks passed\n');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
