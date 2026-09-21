'use strict';

/**
 * Mission 03 — a batch move to a team creates a mission and launches it.
 *
 * A batch moved to a team's own column used to go straight down the dispatch
 * path: one uncapped prompt for Coding, the drive contract for the Feature team,
 * a fan-out for Planning/Review, and nothing declared about the batch at all.
 * This pins the new shape:
 *
 *  - `resolveBatchTeam` is the ONE resolver that decides whether a batch belongs
 *    to a team, and which shape that team takes (mission vs round fan-out vs
 *    today's plain path). Both composition roots run this same method, because
 *    the batch arms it is called from live in the shared KanbanProvider.
 *  - `claimBatchAsMission` creates a NEW team-bound mission, claims the cards
 *    into STAGING (the mission's home) and launches it — no operator gesture.
 *  - `launchMission` resolves its head from `missions.team`, so a Coding mission
 *    launches into the Coding team's coder, never into the Feature team's lead.
 *
 * Harness notes (mirrored from feature-file-subtask-link-contract.test.js — do
 * not "simplify" these):
 *  - `vscode` → the standalone shim, installed BEFORE any out/services require.
 *  - KanbanDatabase NEVER auto-creates kanban.db, so the file must be touched on
 *    disk before ensureReady() will initialise it. ONE temp workspace and ONE
 *    database for the whole suite (per-test workspaces exhaust the shared sql.js
 *    WASM heap, presenting as "disk I/O error" everywhere).
 *  - Team liveness comes from `getFleetLiveness()` on the TaskViewerProvider, so
 *    a bare provider has NO live team and every batch would resolve 'plain'. The
 *    stub below is the liveness view, and it is set per test.
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
const { KanbanProvider } = require('../../out/services/KanbanProvider');
const { BroadcastHub } = require('../../out/services/broadcastHub');

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

/** The five shipped team definitions, with only the fields this contract reads. */
function definitions() {
    return [
        {
            id: 'feature-implementation', name: 'Feature team', headRole: 'lead',
            enabled: true, enabledSource: 'config',
            automatedDispatch: 'pool', automatedDispatchSource: 'config',
            members: [{ role: 'coder', count: 2 }, { role: 'intern', count: 1 }],
        },
        {
            id: 'coding-team', name: 'Coding', headRole: 'coder',
            enabled: true, enabledSource: 'config',
            automatedDispatch: 'pool', automatedDispatchSource: 'config',
            members: [{ role: 'intern', count: 1 }],
        },
        {
            id: 'planning-team', name: 'Planning', headRole: 'planner',
            enabled: true, enabledSource: 'config',
            automatedDispatch: 'pool', automatedDispatchSource: 'config',
            members: [{ role: 'planner', count: 2 }, { role: 'researcher', count: 1 }],
        },
        {
            id: 'multi-agent-planning', name: 'Multi-agent planning', headRole: 'planner',
            enabled: true, enabledSource: 'config',
            automatedDispatch: 'head-only-when-sole', automatedDispatchSource: 'config',
            members: [{ role: 'planner', count: 3 }],
        },
        {
            id: 'review-team', name: 'Review', headRole: 'reviewer',
            enabled: true, enabledSource: 'config',
            automatedDispatch: 'pool', automatedDispatchSource: 'config',
            members: [{ role: 'reviewer', count: 2 }],
        },
    ];
}

/** A live team row as `wireSpawnedTeam` writes it. */
function liveTeam(definitionId, head, headRole, members) {
    return {
        id: 'team_' + head.replace(/[^a-zA-Z0-9]/g, '_'),
        name: head,
        head,
        headRole,
        teamKind: 'spawned',
        teamGroup: true,
        definitionId,
        members,
        order: [head, ...members],
    };
}

const memento = () => {
    const m = new Map();
    return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); }, keys: () => Array.from(m.keys()) };
};

async function run() {
    console.log('\nbatch → mission launch contract\n');

    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-batchmission-')));
    fs.mkdirSync(path.join(tmpRoot, '.switchboard', 'plans'), { recursive: true });

    const db = KanbanDatabase.forWorkspace(tmpRoot);
    {
        const dbDir = path.dirname(db.dbPath);
        if (!fs.existsSync(dbDir)) { fs.mkdirSync(dbDir, { recursive: true }); }
        if (!fs.existsSync(db.dbPath)) { fs.writeFileSync(db.dbPath, Buffer.alloc(0)); }
        assert.ok(await db.ensureReady(), 'seeded kanban.db must initialise');
    }
    const wsId = (await db.getWorkspaceId()) || (await db.getDominantWorkspaceId()) || 'batch-mission-ws';

    await db.setConfigJson(AGENT_GROUPS_KEY, definitions());

    /** The liveness view the provider reads. Replaced per test. */
    let live = [];
    const provider = new KanbanProvider({ fsPath: tmpRoot }, {
        globalState: memento(), workspaceState: memento(),
        secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
        extensionUri: { fsPath: tmpRoot }, extensionPath: tmpRoot, subscriptions: [],
    }, undefined, undefined);
    provider._hostSeams = undefined;
    provider._broadcaster = new BroadcastHub({ webview: null, apiServer: null });
    provider._currentWorkspaceRoot = tmpRoot;
    // The TaskViewerProvider seam. The provider calls these on it in the paths
    // this suite drives — `setTaskViewerProvider` immediately runs
    // `_loadOverrideFlags`, which calls `_resolveWorkspaceRoot()`, and
    // `_getScopedSetting` does the same on every scoped read. A MISSING method
    // here is a TypeError at the call site, not a silent pass, which is how this
    // harness first failed. Everything else the provider may ask a real
    // TaskViewerProvider for is deliberately absent: nothing this suite drives
    // reaches it, and a stub that answers everything is a stub that hides a
    // mis-wire.
    provider.setTaskViewerProvider({
        _resolveWorkspaceRoot: () => tmpRoot,
        getFleetLiveness: () => live,
        getAliveCodingTerminalNames: () => live.filter(t => t && t.status !== 'exited').map(t => t.friendlyName),
        getCustomAgents: async () => ({}),
        getVisibleAgents: async () => ({ lead: true, coder: true, intern: true, planner: true, reviewer: true }),
        recordRunSheetForColumnMove: async () => undefined,
    });

    /** Every pop the launch made, in order. */
    const pops = [];
    provider.setApiServer({
        dispatchNextFromQueue: async (args) => {
            pops.push({ from: args.from, missionId: args.missionId, workspaceRoot: args.workspaceRoot });
            // The REAL pop hands the card to a seat and stamps its owner. That
            // stamp is what derives the mission's runState to 'in-flight', which
            // is what makes its team read HELD in the command view — so the stub
            // stamps it too rather than leaving the mission looking untouched.
            if (args.missionId) {
                const mission = await db.getMissionById(args.missionId);
                const first = mission && (mission.plans || [])[0];
                const row = first ? await db.getPlanByPlanId(first) : null;
                if (row && row.planFile) {
                    await db.updateDispatchInfoByPlanFile(row.planFile, row.workspaceId || wsId, {
                        ownerSeat: args.from,
                        dispatchedAgent: 'coder',
                    });
                }
            }
            return { status: 200, payload: { success: true, dispatched: { planId: 'popped', title: 'popped' } } };
        },
    });

    /** Write a plan file + row. insertFileDerivedPlan always lands it in CREATED. */
    async function seedPlan(slug) {
        const rel = `.switchboard/plans/${slug}.md`;
        fs.writeFileSync(path.join(tmpRoot, rel), `# ${slug}\n\n## Goal\n${slug}\n`, 'utf8');
        const now = new Date().toISOString();
        assert.ok(await db.insertFileDerivedPlan({
            planId: slug, sessionId: slug, topic: slug, planFile: rel,
            status: 'active', complexity: '3', tags: '', project: '', workspaceId: wsId,
            createdAt: now, updatedAt: now, sourceType: 'local', workspaceName: 'batchmission',
            isFeature: 0,
        }), `seedPlan(${slug}) must insert`);
        return slug;
    }

    async function setLiveTeams(teams) {
        await db.setConfigJson(TEAM_GROUPS_KEY, teams);
        live = [];
        for (const t of teams) {
            for (const name of t.order || [t.head]) {
                live.push({ friendlyName: name, status: 'active', role: t.headRole });
            }
        }
    }

    const FEATURE = liveTeam('feature-implementation', 'Feature Lead', 'lead', ['Coder 1', 'Intern 1']);
    const CODING = liveTeam('coding-team', 'Coding Coder', 'coder', ['Coding Intern']);
    const PLANNING = liveTeam('planning-team', 'Planning Lead', 'planner', ['Planner 1', 'Planner 2', 'Researcher']);
    const MULTI = liveTeam('multi-agent-planning', 'Multi Lead', 'planner', ['Peer 1', 'Peer 2', 'Peer 3']);
    const REVIEW = liveTeam('review-team', 'Review Lead', 'reviewer', ['Reviewer 1', 'Reviewer 2']);

    // ── 1. The resolver: which team receives this batch, and how? ──────────

    await test('a Feature-team batch resolves to a mission, on the Feature team', async () => {
        await setLiveTeams([FEATURE]);
        const shape = await provider.resolveBatchTeam(tmpRoot, 'LEAD CODED', 3);
        assert.strictEqual(shape.kind, 'mission', `expected a mission, got '${shape.kind}' (${shape.reason})`);
        assert.strictEqual(shape.teamId, 'feature-implementation');
        assert.strictEqual(shape.headTerminal, 'Feature Lead');
    });

    await test('a Coding-team batch resolves to a mission, on the Coding team', async () => {
        await setLiveTeams([CODING]);
        const shape = await provider.resolveBatchTeam(tmpRoot, 'CODER CODED', 3);
        assert.strictEqual(shape.kind, 'mission', shape.reason);
        assert.strictEqual(shape.teamId, 'coding-team');
        assert.strictEqual(shape.headTerminal, 'Coding Coder');
    });

    await test('a PLAN REVIEWED batch with the pooled Planning team live is a FAN-OUT, not a mission', async () => {
        await setLiveTeams([PLANNING, MULTI]);
        const shape = await provider.resolveBatchTeam(tmpRoot, 'PLAN REVIEWED', 4);
        assert.strictEqual(shape.kind, 'fanout',
            `a pooled planner team takes one plan per seat — Mission 05's rounds branch, got '${shape.kind}' (${shape.reason})`);
    });

    await test('a PLAN REVIEWED batch with ONLY Multi-agent planning live is a MISSION', async () => {
        await setLiveTeams([MULTI]);
        const shape = await provider.resolveBatchTeam(tmpRoot, 'PLAN REVIEWED', 4);
        assert.strictEqual(shape.kind, 'mission', shape.reason);
        assert.strictEqual(shape.teamId, 'multi-agent-planning');
        assert.strictEqual(shape.headTerminal, 'Multi Lead');
    });

    await test('a CODE REVIEWED batch is a FAN-OUT (Review reads, its seats take their own cards)', async () => {
        await setLiveTeams([REVIEW]);
        const shape = await provider.resolveBatchTeam(tmpRoot, 'CODE REVIEWED', 3);
        assert.strictEqual(shape.kind, 'fanout', shape.reason);
    });

    await test('no live team heads the column → plain, and no mission is ever created', async () => {
        await setLiveTeams([]);
        const ids = [await seedPlan('bm-not-a'), await seedPlan('bm-not-b')];
        const before = (await db.getMissions(wsId)).length;
        const shape = await provider.resolveBatchTeam(tmpRoot, 'CODER CODED', ids.length);
        assert.strictEqual(shape.kind, 'plain', `expected plain with no live team, got '${shape.kind}' (${shape.reason})`);
        // The claim re-checks the shape, so a caller that ignored the resolver
        // still cannot conjure a mission for a team that is not there.
        const claim = await provider.claimBatchAsMission(tmpRoot, ids, 'PLAN REVIEWED', shape);
        assert.strictEqual(claim.created, false, 'a batch no team heads must not create a mission');
        assert.strictEqual((await db.getMissions(wsId)).length, before, 'no mission row may be created');
        const row = await db.getPlanByPlanId(ids[0]);
        assert.notStrictEqual(row.kanbanColumn, 'STAGING', 'and no card may be re-queued into a mission that does not exist');
    });

    await test('a single plan is never a mission — it keeps today\'s routing', async () => {
        await setLiveTeams([FEATURE]);
        const shape = await provider.resolveBatchTeam(tmpRoot, 'LEAD CODED', 1);
        assert.strictEqual(shape.kind, 'plain', shape.reason);
    });

    // ── 2. Create, claim, launch ───────────────────────────────────────────

    await test('a batch to the Feature team creates ONE mission with one member per plan, in STAGING, and launches it', async () => {
        await setLiveTeams([FEATURE]);
        const ids = [await seedPlan('bm-a1'), await seedPlan('bm-a2'), await seedPlan('bm-a3')];
        pops.length = 0;
        const before = (await db.getMissions(wsId)).length;

        const shape = await provider.resolveBatchTeam(tmpRoot, 'LEAD CODED', ids.length);
        const claim = await provider.claimBatchAsMission(tmpRoot, ids, 'PLAN REVIEWED', shape);
        assert.strictEqual(claim.created, true, claim.error || 'the mission must be created');
        assert.strictEqual(claim.launched, true, `the mission must launch without an operator gesture: ${claim.error || ''}`);
        assert.strictEqual(claim.claimed.length, 3, 'every plan must be claimed');
        assert.deepStrictEqual(claim.refused, [], 'nothing may be refused');

        const missions = await db.getMissions(wsId);
        assert.strictEqual(missions.length, before + 1, 'exactly one mission per batch');
        const mission = await db.getMissionById(claim.missionId);
        assert.strictEqual(mission.team, 'feature-implementation',
            'missions.team is the receiving team — the launch head and the stage column both derive from it');
        assert.strictEqual(mission.ready, true, 'the mission is armed: it was launched, not parked');
        assert.strictEqual((mission.plans || []).length, 3, 'one member per plan');

        for (const id of ids) {
            const row = await db.getPlanByPlanId(id);
            assert.strictEqual(row.kanbanColumn, 'STAGING',
                "a member's home is its mission's STAGING — the card the operator sees is the mission card, with members hidden inside it");
            const owned = await db.getMissionsForMember(id);
            assert.deepStrictEqual(owned, [claim.missionId], 'the card belongs to THIS mission and no other');
        }

        assert.strictEqual(pops.length, 1, 'the launch popped exactly once (one team head is one stream)');
        assert.strictEqual(pops[0].missionId, claim.missionId, 'the pop is scoped to the mission just created (Mission 01)');
        assert.strictEqual(pops[0].from, 'Feature Lead', "the launch head is the mission's team head");

        // The command view reads HELD off (active mission is in-flight) AND
        // (its team is this team's id). Both halves are the data this op wrote.
        const after = await db.getMissionById(claim.missionId);
        assert.strictEqual(after.runState, 'in-flight',
            'a dispatched member with no asserted completion makes the mission in-flight — that is what the roster reads as HELD');
        assert.strictEqual(after.team, 'feature-implementation',
            "the held team's id, as the roster compares it");
    });

    await test('the mission renders on the EXISTING card, with its members hidden inside it', async () => {
        await setLiveTeams([FEATURE]);
        const ids = [await seedPlan('bm-render1'), await seedPlan('bm-render2')];
        const shape = await provider.resolveBatchTeam(tmpRoot, 'LEAD CODED', ids.length);
        const claim = await provider.claimBatchAsMission(tmpRoot, ids, 'PLAN REVIEWED', shape);
        assert.strictEqual(claim.created, true, claim.error || '');

        // The mission card is drawn from the board's mission list…
        const listed = (await db.getMissions(wsId)).find(m => m.id === claim.missionId);
        assert.ok(listed, 'the mission must be in the list the mission card is drawn from');
        assert.strictEqual(listed.team, 'feature-implementation');
        assert.strictEqual((listed.plans || []).length, 2, 'the card counts its members');

        // …and its members are HIDDEN inside it rather than drawn as loose
        // cards. The two halves of that predicate are: the card carries a
        // missionId, and it sits in STAGING. Both are asserted here, per member.
        const board = await db.getBoard(wsId);
        for (const id of ids) {
            const row = board.find(r => r && r.planId === id);
            assert.ok(row, `member '${id}' must be on the board`);
            assert.strictEqual(row.kanbanColumn, 'STAGING', "a member's home is its mission's STAGING");
            const owner = await db.getMissionsForMember(id);
            assert.deepStrictEqual(owner, [claim.missionId],
                'so the board build stamps THIS mission id on the card — the containment predicate reads both fields');
        }

        // The card is the EXISTING mission card, not a new element: this plan
        // draws nothing new, and a second card would be a second render site.
        const html = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'kanban.html'), 'utf8');
        assert.ok(/class="kanban-card mission-card/.test(html), 'the existing mission card element must still be the one drawn');
        assert.ok(/mission-badge/.test(html), 'its badge must still be there');
        assert.ok(/!card\.featureId && !\(card\.missionId && card\.column === 'STAGING'\)/.test(html),
            'the containment predicate is what hides a member inside its mission card — a mission member is not a loose column card');
    });

    await test('the roster reads HELD off exactly the two facts the launch writes', () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'command.js'), 'utf8');
        const i = src.indexOf("stateLabel = 'HELD';");
        assert.notStrictEqual(i, -1, 'the command view must have a HELD state');
        const window = src.slice(Math.max(0, i - 1000), i);
        assert.ok(/activeMission\?\.team/.test(window), "HELD reads the active mission's team");
        assert.ok(/isMissionInFlight\(\)/.test(window),
            'and it requires an in-flight mission — the runState a dispatched, unasserted member derives');
        assert.ok(/heldTeam === team\.id \|\| heldTeam === team\.name/.test(window),
            'and the held id must match the team row the roster draws — the definition id this op writes to missions.team');
    });

    await test('a second batch creates a FRESH mission — it never joins the open one', async () => {
        await setLiveTeams([FEATURE]);
        const ids = [await seedPlan('bm-b1'), await seedPlan('bm-b2')];
        const shape = await provider.resolveBatchTeam(tmpRoot, 'LEAD CODED', ids.length);
        const first = await provider.claimBatchAsMission(tmpRoot, ids, 'PLAN REVIEWED', shape);
        const more = [await seedPlan('bm-b3'), await seedPlan('bm-b4')];
        const second = await provider.claimBatchAsMission(tmpRoot, more, 'PLAN REVIEWED', shape);
        assert.strictEqual(first.created, true, first.error || '');
        assert.strictEqual(second.created, true, second.error || '');
        assert.notStrictEqual(second.missionId, first.missionId,
            'a batch is one declared thing: joining an open mission would put two batches on one card');
    });

    await test('a card another mission owns is TRANSFERRED into the batch (Mission 08)', async () => {
        await setLiveTeams([FEATURE]);
        const owned = await seedPlan('bm-c1');
        const other = await db.createMission({ workspaceId: wsId, name: 'Earlier mission', ready: true });
        await db.addMissionMember(other.id, owned, 'plan');

        const shape = await provider.resolveBatchTeam(tmpRoot, 'LEAD CODED', 2);
        const claim = await provider.claimBatchAsMission(tmpRoot, [owned], 'PLAN REVIEWED', shape);
        assert.strictEqual(claim.created, true, claim.error || 'one card, one mission: the latest claim wins');
        assert.deepStrictEqual(claim.claimed, [owned]);
        const now = await db.getMissionsForMember(owned);
        assert.deepStrictEqual(now, [claim.missionId],
            'the card left the earlier mission — a second claim is a TRANSFER, never a silent ignore');
        assert.ok(!(await db.getMissionMembers(other.id)).some(m => m.memberId === owned),
            'and the mission that lost it no longer lists it');
    });

    await test('a card already dispatched out of a stageable column is refused', async () => {
        await setLiveTeams([FEATURE]);
        const coded = await seedPlan('bm-d1');
        // insertFileDerivedPlan always writes CREATED, so the column is set here
        // — the card must genuinely be past the dispatch stage.
        assert.ok(await db.updateColumnByPlanFile(`.switchboard/plans/${coded}.md`, wsId, 'LEAD CODED'),
            'the card must move to a coding column for this case');
        const shape = await provider.resolveBatchTeam(tmpRoot, 'LEAD CODED', 2);
        const claim = await provider.claimBatchAsMission(tmpRoot, [coded], 'PLAN REVIEWED', shape);
        assert.strictEqual(claim.created, false);
        assert.ok(/already dispatched/.test(claim.refused[0].reason), claim.refused[0].reason);
    });

    await test('a STAGING move still waits for a deliberate launch — staging creates no dispatch', async () => {
        await setLiveTeams([FEATURE]);
        const ids = [await seedPlan('bm-e1'), await seedPlan('bm-e2')];
        pops.length = 0;
        const staged = await provider.stageForQueue(tmpRoot, ids);
        assert.strictEqual(staged.success, true, staged.error || '');
        assert.strictEqual(pops.length, 0,
            'STAGING is a parking area: staging must not dispatch, and only launchMission may');
    });

    // ── 3. The launch head comes from the mission's team ───────────────────

    await test('a Coding mission launches into the Coding team\'s coder, not the Feature team\'s lead', async () => {
        await setLiveTeams([FEATURE, CODING]);
        const members = [await seedPlan('bm-f1'), await seedPlan('bm-f2')];
        const mission = await db.createMission({ workspaceId: wsId, team: 'coding-team', ready: true });
        for (const id of members) { await db.addMissionMember(mission.id, id, 'plan'); }
        await db.appendQueuePositions(wsId, members, mission.id);

        pops.length = 0;
        const result = await provider.launchMission(tmpRoot, mission.id);
        assert.strictEqual(result.success, true, result.error || '');
        assert.strictEqual(pops.length, 1, 'one team head is one stream');
        assert.strictEqual(pops[0].from, 'Coding Coder',
            "resolveCodingRolesFromGroups returns leads[0] first — the mission's own team must win");
    });

    await test('a team-bound mission whose team is not seated fails LOUDLY', async () => {
        await setLiveTeams([FEATURE]);
        const members = [await seedPlan('bm-g1'), await seedPlan('bm-g2')];
        const mission = await db.createMission({ workspaceId: wsId, team: 'coding-team', ready: true });
        for (const id of members) { await db.addMissionMember(mission.id, id, 'plan'); }
        await db.appendQueuePositions(wsId, members, mission.id);

        pops.length = 0;
        const result = await provider.launchMission(tmpRoot, mission.id);
        assert.strictEqual(result.success, false, 'a team that is not seated must refuse, never fall back to another team');
        assert.ok(/No coding terminal is live/.test(result.error || ''), result.error);
        assert.ok(/coding-team/.test(result.error || ''), `the refusal must name the team: ${result.error}`);
        assert.strictEqual(pops.length, 0, 'nothing may be dispatched');
    });

    await test('a mission with no team keeps today\'s candidate logic', async () => {
        await setLiveTeams([FEATURE, CODING]);
        const members = [await seedPlan('bm-h1'), await seedPlan('bm-h2')];
        const mission = await db.createMission({ workspaceId: wsId, ready: true });
        for (const id of members) { await db.addMissionMember(mission.id, id, 'plan'); }
        await db.appendQueuePositions(wsId, members, mission.id);

        pops.length = 0;
        const result = await provider.launchMission(tmpRoot, mission.id);
        assert.strictEqual(result.success, true, result.error || '');
        assert.strictEqual(pops[0].from, 'Feature Lead',
            'a STAGING-assembled mission (no team) keeps the pre-mission lead-first candidate order');
    });

    // ── 4. Source-shape: the arms that must call the resolver ──────────────

    await test('the shared batch arms consult resolveBatchTeam before they dispatch', () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const advance = src.slice(
            src.indexOf('private async _advanceCards('),
            src.indexOf('\n    private _isColumnBefore(')
        );
        assert.ok(/_tryBatchMission\(/.test(advance),
            '_advanceCards must route a batch through the mission interception — both composition roots run this method');
        const tryMission = src.slice(
            src.indexOf('private async _tryBatchMission('),
            src.indexOf('\n    public async resolveBatchTeam(')
        );
        assert.ok(/resolveBatchTeam\(/.test(tryMission),
            '_tryBatchMission must ask the ONE resolver rather than re-deriving which team receives the batch');
        assert.ok(/claimBatchAsMission\(/.test(tryMission), '_tryBatchMission must claim through the shared operation');
        // The planner/reviewer arms (a seat-role column) resolve the shape before
        // the round fan-out, so a mission never falls into Mission 05's branch.
        const plannerArms = (src.match(/resolveBatchTeam\(workspaceRoot, nextCol, /g) || []).length;
        assert.ok(plannerArms >= 2,
            `both move arms (moveSelected and moveAll) must resolve the shape before the seat-role fan-out; found ${plannerArms}`);
    });

    // ── 5. The drain must not eat itself ───────────────────────────────────
    // A wave release (Mission 04) is a batch dispatch of N>1 members into the
    // mission's own team column with `bypassTriggerGate: true` — byte-for-byte
    // the shape this suite's interception exists to catch. Un-named, the release
    // is re-read as a fresh batch move: the members are TRANSFERRED out of the
    // mission that just released them into a brand-new one, which is launched,
    // and waves again. Reproduced on the Feature team (cadence 5) before the fix.
    await test('a mission\'s own wave release is not re-read as a new batch move', async () => {
        const claims = [];
        const realResolve = provider.resolveBatchTeam;
        const realClaim = provider.claimBatchAsMission;
        const realPost = provider.postMessage;
        // The board echo needs a live webview/ws target this harness has none of;
        // the claim is what is under test, not the echo.
        provider.postMessage = () => {};
        provider.resolveBatchTeam = async () => ({
            kind: 'mission', teamId: 'feature-implementation', headTerminal: 'Feature Lead', reason: 'stub',
        });
        provider.claimBatchAsMission = async (ws, ids) => {
            claims.push([...ids]);
            return { created: true, missionId: 'SPAWNED', missionName: 'spawned', claimed: [...ids], refused: [], launched: true };
        };
        const waveShape = {
            target: 'LEAD CODED', sourceColumn: 'STAGING', bypassTriggerGate: true,
            dispatch: true, dispatchRole: 'lead', dispatchTerminal: 'Feature Lead',
        };
        try {
            await provider._advanceCards(tmpRoot, ['w1', 'w2', 'w3', 'w4', 'w5'],
                { ...waveShape, missionRelease: 'mission-feature' });
            assert.strictEqual(claims.length, 0,
                `a release named as one must claim nothing — it spawned ${JSON.stringify(claims)}`);
            // The negative control: without the name, this IS a batch move and the
            // interception must still fire, or the assertion above passes on a
            // branch that is simply dead.
            await provider._advanceCards(tmpRoot, ['w1', 'w2', 'w3', 'w4', 'w5'], waveShape);
            assert.strictEqual(claims.length, 1,
                'an unnamed batch move of the same shape must still become a mission');
        } finally {
            provider.resolveBatchTeam = realResolve;
            provider.claimBatchAsMission = realClaim;
            provider.postMessage = realPost;
        }
    });

    await test('the wave release names the mission it is draining', () => {
        const api = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const wave = api.slice(api.indexOf("kanbanVerb('triggerBatchAction'"));
        assert.ok(/missionRelease:\s*missionId/.test(wave.slice(0, 2000)),
            'the wave release must name its mission, or the batch arm claims its members into a new one');
        const provSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const advance = provSrc.slice(
            provSrc.indexOf('private async _advanceCards('),
            provSrc.indexOf('\n    private _isColumnBefore(')
        );
        const guards = (advance.match(/!options\.missionRelease/g) || []).length;
        assert.strictEqual(guards, 2,
            `both mission branches in _advanceCards must skip a release; found ${guards}`);
    });

    await test('both composition roots instantiate the shared provider the arms live on', () => {
        for (const [file, label] of [
            ['src/extension.ts', 'extension'],
            ['src/standalone/bootstrap.ts', 'standalone'],
        ]) {
            const src = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
            assert.ok(/KanbanProvider/.test(src), `${label} must use the shared KanbanProvider`);
        }
        const standalone = fs.readFileSync(path.join(process.cwd(), 'src', 'standalone', 'bootstrap.ts'), 'utf8');
        assert.ok(/switchboard\.triggerBatchAgentFromKanban/.test(standalone),
            'the standalone host must still bridge the batch command — it is the delivery half of the shared decision');
    });

    provider.dispose();
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });

    console.log(`\n${failed === 0 ? `all ${passed} batch→mission checks passed` : `${failed} of ${passed + failed} batch→mission check(s) FAILED`}\n`);
    process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
