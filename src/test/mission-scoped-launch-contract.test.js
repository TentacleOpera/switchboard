/**
 * Mission 01 — a launch touches only its own members.
 *
 * `launchMission` used to read the mission's member list only to COUNT streams
 * and then pop the queue workspace-wide, so launching mission A could dispatch
 * mission B's card whenever B's member happened to sort first. The fix is one
 * optional `missionId` on `dispatchNextFromQueue` → `_runQueuePop`: present
 * means "select only this mission's members", absent means the workspace-wide
 * queue the Run queue button, the schedule timer and `queue/next` all still use.
 *
 * Every case below puts the FOREIGN mission's card first in queue order, so a
 * workspace-wide pop fails the assertion. That ordering is the whole point: with
 * the foreign card last, a leaky pop passes by accident.
 *
 * The last two checks are source-shape assertions on the two composition-root
 * wirings — `launchMission`'s pop call and the webview LAUNCH MISSION body. A
 * passing runtime suite that never sends `missionId` proves nothing about the
 * call sites that must send it.
 */
const assert = require('assert');
const fs = require('fs');
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

const WS = '/tmp/mission-scoped-launch-ws';
const OTHER_WS = '/tmp/mission-scoped-launch-other-ws';

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
 * A LocalApiServer wired with the mission-aware kanban db and the seams the
 * pop and the seat-paced release need. `dispatched` records every planId the
 * pop actually sent — the only thing worth asserting; the pop's contract is
 * "which card, if any".
 */
function makeServer(board, opts = {}) {
    const dispatched = [];
    const config = new Map();
    const missions = opts.missions || {};
    const members = opts.members || {};
    const memberOf = opts.memberOf || {};
    const db = {
        getWorkspaceId: async () => 'ws1',
        getDominantWorkspaceId: async () => 'ws1',
        getBoard: async () => board,
        getConfigJson: async (key, fallback) => config.has(key) ? config.get(key) : fallback,
        setConfigJson: async (key, value) => { config.set(key, value); },
        getMissionById: async (id) => missions[id] || null,
        getMissionMembers: async (id) => (members[id] || []).map(memberId => ({ memberId, kind: 'plan' })),
        getMissionsForMember: async (planId) => memberOf[planId] || [],
        ...(opts.db || {}),
    };
    const server = new LocalApiServer({
        clickupMetadataPath: '',
        linearMetadataPath: '',
        getClickUpService: () => null,
        getLinearService: () => null,
        getNotionService: () => null,
        getAuthToken: async () => '',
        allRoots: [WS, OTHER_WS],
        workspaceRoot: WS,
        getKanbanDatabase: async () => db,
        resolveTeamMembers: opts.resolveTeamMembers,
        resolveTeamPacing: opts.resolveTeamPacing,
        resolveKanbanDispatch: opts.resolveKanbanDispatch,
        getRegisteredTerminals: opts.getRegisteredTerminals,
        getFleetOrdersDatabase: opts.getFleetOrdersDatabase,
        onWorkingStateCleared: opts.onWorkingStateCleared,
        onTurnEndNotify: opts.onTurnEndNotify,
        clearTerminalContext: opts.clearTerminalContext || (async () => ({ cleared: true })),
        armQueueWatch: opts.armQueueWatch || (async () => { /* not under test */ }),
    });
    // Stub the dispatch machinery: this contract is about SELECTION, not about
    // what performKanbanDispatch does with the card. The card MOVES, because a
    // real dispatch moves it — a stub that left it in STAGING would let a
    // second pop hand out the same member and hide the double-dispatch case.
    server.performKanbanDispatch = async (workspaceRoot, planId, targetColumn) => {
        dispatched.push(planId);
        const row = board.find(p => p && p.planId === planId);
        if (row) { row.kanbanColumn = targetColumn || 'LEAD CODED'; }
        return { status: 200, payload: { success: true, planId, moved: true, dispatched: true } };
    };
    return { server, dispatched };
}

/** Mission A: two members. Mission B: one member, and it sorts FIRST. */
function twoMissions() {
    const board = [
        card('b-1', 'STAGING', { columnOrder: 0 }),   // foreign, sorts first
        card('a-1', 'STAGING', { columnOrder: 5 }),
        card('a-2', 'STAGING', { columnOrder: 6 }),
    ];
    return {
        board,
        missions: {
            'mission-a': { id: 'mission-a', workspaceId: 'ws1' },
            'mission-b': { id: 'mission-b', workspaceId: 'ws1' },
        },
        members: { 'mission-a': ['a-1', 'a-2'], 'mission-b': ['b-1'] },
        memberOf: { 'a-1': ['mission-a'], 'a-2': ['mission-a'], 'b-1': ['mission-b'] },
    };
}

async function run() {
    console.log('\nmission-scoped launch contract\n');

    await check('a mission-scoped pop dispatches only its own members (foreign card sorts first)', async () => {
        const { board, missions, members, memberOf } = twoMissions();
        const { server, dispatched } = makeServer(board, { missions, members, memberOf });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding', missionId: 'mission-a' });
        assert.strictEqual(out.status, 200, `expected 200, got ${out.status}: ${out.payload.error || ''}`);
        assert.deepStrictEqual(dispatched, ['a-1'],
            "launching mission A must not start mission B's card — B's member sorts first in workspace order, so a workspace-wide pop fails here");
    });

    await check('the same board WITHOUT missionId still pops workspace-wide (the unscoped path is unchanged)', async () => {
        const { board, missions, members, memberOf } = twoMissions();
        const { server, dispatched } = makeServer(board, { missions, members, memberOf });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatched, ['b-1'],
            'the Run queue / schedule / queue/next path selects from every STAGING card, exactly as before');
        assert.strictEqual(out.payload.reason, undefined,
            'a successful unscoped pop carries a dispatch, not a reason');
    });

    await check('one launch never hands the same member twice', async () => {
        const { board, missions, members, memberOf } = twoMissions();
        const { server, dispatched } = makeServer(board, { missions, members, memberOf });
        // Two streams, same mission: two pops, as launchMission issues them.
        const first = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Head A', missionId: 'mission-a' });
        const second = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Head B', missionId: 'mission-a' });
        assert.strictEqual(first.status, 200);
        assert.strictEqual(second.status, 200);
        assert.deepStrictEqual(dispatched, ['a-1', 'a-2'],
            'the second pop re-reads the board, so the member the first delivered is gone from STAGING — no member twice, no foreign card');
    });

    await check('a drained mission says so, naming the mission — never the bare "queue empty"', async () => {
        const { board, missions, members, memberOf } = twoMissions();
        board.forEach(p => { if (p.planId.startsWith('a-')) { p.kanbanColumn = 'LEAD CODED'; } });
        const { server, dispatched } = makeServer(board, { missions, members, memberOf });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding', missionId: 'mission-a' });
        assert.strictEqual(out.status, 200, 'a drained mission is not an error');
        assert.strictEqual(out.payload.dispatched, null);
        assert.strictEqual(out.payload.missionId, 'mission-a', 'the scoped empty result must name the mission');
        assert.notStrictEqual(out.payload.reason, 'queue empty',
            '"this mission is drained" and "the board queue is drained" must never render the same string');
        assert.ok(/queue empty for mission mission-a/.test(String(out.payload.reason)),
            `expected the reason to name the mission, got '${out.payload.reason}'`);
        assert.deepStrictEqual(dispatched, [],
            "a drained mission must not fall through to another mission's staged cards");
    });

    await check('a mission whose members are all dependency-blocked names the blocker AND the mission', async () => {
        const board = [
            card('b-1', 'STAGING', { columnOrder: 0 }),
            card('a-1', 'STAGING', { columnOrder: 5 }),
            card('predecessor', 'PLAN REVIEWED', { columnOrder: 9 }),
        ];
        const { server, dispatched } = makeServer(board, {
            missions: { 'mission-a': { id: 'mission-a', workspaceId: 'ws1' }, 'mission-b': { id: 'mission-b', workspaceId: 'ws1' } },
            members: { 'mission-a': ['a-1'], 'mission-b': ['b-1'] },
            memberOf: { 'a-1': ['mission-a'], 'b-1': ['mission-b'] },
            db: {
                getPlanDependencies: async (planId) => (planId === 'a-1' ? ['predecessor'] : []),
            },
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding', missionId: 'mission-a' });
        assert.strictEqual(out.status, 200);
        assert.strictEqual(out.payload.dispatched, null);
        assert.strictEqual(out.payload.missionId, 'mission-a', 'the blocked diagnosis must name the mission too');
        assert.ok(out.payload.dependencyBlocked && out.payload.dependencyBlocked.planId === 'a-1',
            "the blocker named must be THIS mission's blocked member, never a foreign mission's");
        assert.deepStrictEqual(dispatched, []);
    });

    await check('an unknown missionId is refused, not treated as an unscoped pop', async () => {
        const { board, missions, members, memberOf } = twoMissions();
        const { server, dispatched } = makeServer(board, { missions, members, memberOf });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding', missionId: 'mission-does-not-exist' });
        assert.strictEqual(out.status, 400, 'an unknown mission must refuse loudly — degrading to a workspace-wide pop is the leak');
        assert.deepStrictEqual(dispatched, []);
    });

    await check("a missionId from another workspace cannot scope a pop in this one", async () => {
        const { board, members, memberOf } = twoMissions();
        const { server, dispatched } = makeServer(board, {
            missions: { 'mission-elsewhere': { id: 'mission-elsewhere', workspaceId: 'ws-other' } },
            members: { ...members, 'mission-elsewhere': ['b-1'] },
            memberOf,
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding', missionId: 'mission-elsewhere' });
        assert.strictEqual(out.status, 400);
        assert.ok(/workspace/.test(String(out.payload.error)), `expected a workspace mismatch error, got '${out.payload.error}'`);
        assert.deepStrictEqual(dispatched, []);
    });

    await check('the seat-paced release pops the completing card\'s OWN mission', async () => {
        // The one unattended release path: a seat finishes a member of mission
        // A while mission B's card sorts first. The release must pop A's next
        // member, not B's card.
        const board = [
            card('b-1', 'STAGING', { columnOrder: 0 }),
            card('a-2', 'STAGING', { columnOrder: 5 }),
            card('a-1', 'LEAD CODED', {
                columnOrder: 1, ownerSeat: 'Coder 1', ownerSince: '2026-09-20T00:00:00Z',
                planFile: '/tmp/a-1.md', workspaceId: 'ws1',
            }),
        ];
        const { server, dispatched } = makeServer(board, {
            missions: { 'mission-a': { id: 'mission-a', workspaceId: 'ws1' }, 'mission-b': { id: 'mission-b', workspaceId: 'ws1' } },
            members: { 'mission-a': ['a-1', 'a-2'], 'mission-b': ['b-1'] },
            memberOf: { 'a-1': ['mission-a'], 'a-2': ['mission-a'], 'b-1': ['mission-b'] },
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
            getRegisteredTerminals: () => ['Coder 1'],
            db: {
                clearOwnerStamp: async () => true,
            },
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'Coder 1', planId: 'a-1' });
        assert.strictEqual(out.status, 200, `expected 200, got ${out.status}: ${out.payload.error || ''}`);
        assert.strictEqual(out.payload.released, 'a-1');
        assert.deepStrictEqual(dispatched, ['a-2'],
            "the release pop is scoped to the completing card's mission — mission B's first-sorting card must not be picked");
    });

    await check('a seat releasing a card on NO mission still pops workspace-wide', async () => {
        const board = [
            card('loose', 'STAGING', { columnOrder: 0 }),
            card('standalone-1', 'CODER CODED', {
                columnOrder: 1, ownerSeat: 'Coder 1', ownerSince: '2026-09-20T00:00:00Z',
                planFile: '/tmp/standalone-1.md', workspaceId: 'ws1',
            }),
        ];
        const { server, dispatched } = makeServer(board, {
            missions: {}, members: {}, memberOf: {},
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['Coder 1'],
            db: { clearOwnerStamp: async () => true },
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'Coder 1', planId: 'standalone-1' });
        assert.strictEqual(out.status, 200, `expected 200, got ${out.status}: ${out.payload.error || ''}`);
        assert.deepStrictEqual(dispatched, ['loose'],
            'the standalone-coder case has no mission to scope to — its pop stays workspace-wide');
    });

    // ── Source-shape: the call sites that must SEND the mission id ─────────

    await check('launchMission scopes every pop to the mission it is launching', () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const start = src.indexOf('public async launchMission(');
        assert.notStrictEqual(start, -1, 'launchMission must exist');
        const body = src.slice(start, src.indexOf('\n    /**', start));
        assert.ok(/dispatchNextFromQueue\(\{\s*workspaceRoot,\s*from:\s*head,\s*missionId:\s*mission\.id\s*\}\)/.test(body),
            'launchMission must pass missionId: mission.id — the member list scoping the stream count must also scope the pop');
    });

    await check('the webview LAUNCH MISSION sends the mission id it is launching', () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'command.js'), 'utf8');
        const start = src.indexOf('async function launchActiveMission(');
        assert.notStrictEqual(start, -1, 'launchActiveMission must exist');
        const body = src.slice(start, src.indexOf('\n    function setMissionChip(', start));
        assert.ok(/missionId/.test(body),
            'the LAUNCH MISSION body must carry missionId, or the button launches workspace-wide');
        assert.ok(/\/kanban\/queue\/next/.test(body), 'the launch posts to the queue pop route');
    });

    await check('the HTTP queue/next route accepts missionId', () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const start = src.indexOf('private async _handleKanbanQueueNext(');
        assert.notStrictEqual(start, -1, '_handleKanbanQueueNext must exist');
        const body = src.slice(start, src.indexOf('\n    /**', start));
        assert.ok(/missionId/.test(body),
            'the route must read missionId off the body — the webview launch cannot scope the pop without it');
    });

    if (failures > 0) {
        console.log(`\n${failures} mission-scoped launch check(s) failed\n`);
        process.exit(1);
    }
    console.log('\nAll mission-scoped launch checks passed\n');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
