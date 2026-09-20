'use strict';

/**
 * Mission 08 — one mission per card, and no card skips a stage.
 *
 * Two rules, both pinned here end to end:
 *
 *  1. **One mission per card.** `mission_members` carries `UNIQUE(member_id)`
 *     (V65), so a card can belong to exactly one mission — and `addMissionMember`
 *     is `INSERT OR IGNORE`, which used to DROP a second claim silently. The
 *     operator moved a card into another mission, the board said nothing, and the
 *     card stayed put. `claimIntoMission` replaces that with a transfer: the prior
 *     membership is removed, the card joins the new mission, and the removal is
 *     recorded on BOTH as a `plan_events` row — so "why did mission A lose this
 *     card?" is answerable after the fact.
 *
 *  2. **No stage skipping.** A mission releases a card only when the card sits in
 *     the stage immediately before the mission's own. A review mission may not
 *     pull a card out of CREATED — that jumps planning and coding at once. Such a
 *     member is HELD, with a reason that names both the card's column and the
 *     column the mission releases from, and the pop reports the hold instead of
 *     dispatching it.
 *
 * The stage ranking is `DEFAULT_KANBAN_COLUMNS`' own `order` with the coded lane
 * collapsed (`missionStage.ts`), and the coded lane is ONE stage — LEAD / CODER /
 * INTERN CODED are parallel seats, not three stages. A second ranking is the
 * defect `_PIPELINE_POSITION`'s own comment records, so a source-text assertion
 * pins that there is exactly one.
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
const {
    PIPELINE_POSITION,
    PIPELINE_STAGES,
    isParallelCodedLane,
    resolveStageForColumn,
    resolveStageForHeadRole,
    stageBefore,
    releaseVerdict,
} = require('../../out/services/missionStage');

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

const WS = '/tmp/mission-stage-claim-ws';

/**
 * Source with its comments removed. A gate that greps raw source cannot tell a
 * DECLARATION from a comment ABOUT it, and this suite has already been fooled
 * once that way (a comment recording the retired `_PIPELINE_POSITION`, and a
 * comment saying a hold is "not the run is over"). Strip first, then assert.
 */
function code(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

/** The team definitions the pop resolves a mission's team through. */
const DEFINITIONS = [
    { id: 'feature-implementation', name: 'Feature team', headRole: 'lead', enabled: true, automatedDispatch: 'pool', members: [{ role: 'coder', count: 2 }] },
    { id: 'coding-team', name: 'Coding', headRole: 'coder', enabled: true, automatedDispatch: 'pool', members: [{ role: 'intern', count: 1 }] },
    { id: 'planning-team', name: 'Planning', headRole: 'planner', enabled: true, automatedDispatch: 'pool', members: [{ role: 'planner', count: 2 }] },
    { id: 'review-team', name: 'Review', headRole: 'reviewer', enabled: true, automatedDispatch: 'pool', members: [{ role: 'reviewer', count: 2 }] },
];

function card(planId, kanbanColumn, extra = {}) {
    return {
        planId, sessionId: planId, topic: planId, kanbanColumn,
        featureId: '', ownerSince: null, ownerSeat: '', columnOrder: null, completedAt: null,
        ...extra,
    };
}

/** A LocalApiServer wired for the mission-scoped pop, recording every dispatch. */
function makePopServer(board, mission) {
    const dispatched = [];
    const config = new Map();
    const db = {
        getWorkspaceId: async () => 'ws1',
        getDominantWorkspaceId: async () => 'ws1',
        getBoard: async () => board,
        getConfigJson: async (key, fallback) => {
            if (key === 'terminals.agentGroups') { return DEFINITIONS; }
            return config.has(key) ? config.get(key) : fallback;
        },
        setConfigJson: async (key, value) => { config.set(key, value); },
        getMissionById: async (id) => (mission && mission.id === id ? mission : null),
        getMissionMembers: async () => (mission.plans || []).map(memberId => ({ memberId, kind: 'plan' })),
    };
    const server = new LocalApiServer({
        clickupMetadataPath: '', linearMetadataPath: '',
        getClickUpService: () => null, getLinearService: () => null, getNotionService: () => null,
        getAuthToken: async () => '',
        allRoots: [WS], workspaceRoot: WS,
        getKanbanDatabase: async () => db,
        armQueueWatch: async () => { /* not under test */ },
    });
    server.performKanbanDispatch = async (workspaceRoot, planId) => {
        dispatched.push(planId);
        return { status: 200, payload: { success: true, planId, moved: true, dispatched: true } };
    };
    return { server, dispatched };
}

async function run() {
    console.log('\nmission stage + claim contract\n');

    // ── 1. The ranking: one list, one lane ─────────────────────────────────

    await test('the coded lane is ONE stage, whichever coded column a card sits in', () => {
        const lead = resolveStageForColumn('LEAD CODED');
        const coder = resolveStageForColumn('CODER CODED');
        const intern = resolveStageForColumn('INTERN CODED');
        assert.ok(lead && coder && intern, 'every coded column must resolve a stage');
        assert.strictEqual(lead.key, coder.key, 'LEAD/CODER/INTERN CODED are parallel seats of one stage');
        assert.strictEqual(coder.key, intern.key);
        assert.strictEqual(lead.key, resolveStageForHeadRole('coder').key,
            'a coder-headed team and a lead-headed team work the SAME stage');
        assert.ok(isParallelCodedLane('CODER CODED') && !isParallelCodedLane('CODE REVIEWED'));
    });

    await test('a stage is ranked by the column table, and the release stage is the one before it', () => {
        // Coding's stage is the lane; the stage before it is STAGING.
        const coding = resolveStageForHeadRole('coder');
        assert.strictEqual(stageBefore(coding).key, 'STAGING',
            'a coding mission releases from STAGING — which is why an undelivered member is the normal case');
        // Review's stage is CODE REVIEWED; the stage before it is the coded lane.
        const review = resolveStageForHeadRole('reviewer');
        assert.strictEqual(review.key, 'CODE REVIEWED');
        assert.strictEqual(stageBefore(review).key, resolveStageForColumn('CODER CODED').key,
            'a review mission releases from the coded lane');
        // Planning's stage is PLAN REVIEWED; the stage before it is CREATED.
        assert.strictEqual(resolveStageForHeadRole('planner').key, 'PLAN REVIEWED');
        assert.strictEqual(stageBefore(resolveStageForHeadRole('planner')).key, 'CREATED');
        // The ranking itself is the column table's own order.
        assert.strictEqual(PIPELINE_POSITION['LEAD CODED'], 180);
        assert.ok(PIPELINE_STAGES.length > 0 && PIPELINE_STAGES.every((s, i) => i === 0 || s.rank > PIPELINE_STAGES[i - 1].rank),
            'stages are ordered by rank, so "immediately before" is well defined');
    });

    await test('no second stage ranking exists in the tree', () => {
        const provider = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const providerCode = code(provider);
        // The symbol may be MENTIONED (the comment recording what it replaced);
        // what must not exist is a second DECLARATION. Grep the code, not the file.
        assert.ok(!/_PIPELINE_POSITION\s*[:=]/.test(providerCode),
            'KanbanProvider must not declare a second ranking — the hand-kept list is what shipped RESEARCHER before PLAN REVIEWED');
        assert.ok(!/\b(?:const|let|var|static\s+readonly)\s+_PIPELINE_POSITION\b/.test(providerCode),
            'and must not keep a private copy of it either');
        assert.ok(/import\s*\{[^}]*\bPIPELINE_POSITION\b[^}]*\}\s*from\s*'\.\/missionStage'/.test(providerCode),
            'the provider must import PIPELINE_POSITION from missionStage');
        const stageSrc = code(fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'missionStage.ts'), 'utf8'));
        const definitions = (stageSrc.match(/export const PIPELINE_POSITION\b/g) || []).length;
        assert.strictEqual(definitions, 1, 'exactly one ranking definition');
        assert.ok(/DEFAULT_KANBAN_COLUMNS/.test(stageSrc),
            'and it is derived from the column table, never hand-kept');
        for (const file of ['src/services/LocalApiServer.ts', 'src/services/KanbanDatabase.ts']) {
            const src = code(fs.readFileSync(path.join(process.cwd(), file), 'utf8'));
            assert.ok(!/PIPELINE_POSITION\s*[:=]\s*\{/.test(src), `${file} must not define a second ranking`);
        }
    });

    await test('the gate says releasable / held / delivered, and never conflates them', () => {
        const coding = resolveStageForHeadRole('coder');
        assert.strictEqual(releaseVerdict(coding, 'STAGING').verdict, 'releasable',
            'an undelivered member is the normal release');
        assert.strictEqual(releaseVerdict(coding, 'LEAD CODED').verdict, 'delivered',
            "a card at the mission's own stage is delivered, NOT held");
        assert.strictEqual(releaseVerdict(coding, 'COMPLETED').verdict, 'delivered',
            'and a card past it is not re-delivered');
        const review = resolveStageForHeadRole('reviewer');
        assert.strictEqual(releaseVerdict(review, 'CODER CODED').verdict, 'releasable',
            'a review mission releases a coded card');
        const held = releaseVerdict(review, 'CREATED');
        assert.strictEqual(held.verdict, 'held', 'and may not pull one out of CREATED — that skips planning and coding');
        assert.ok(/CREATED/.test(held.reason) && /CODER CODED/.test(held.reason),
            `the held reason must name the card's column and the release column: ${held.reason}`);
        assert.strictEqual(releaseVerdict(coding, 'custom_agent_thing').verdict, 'held',
            'a column with no pipeline rank is HELD — the gate fails closed, never open');
    });

    // ── 2. One mission per card: the transfer ──────────────────────────────

    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mstage-')));
    fs.mkdirSync(path.join(tmpRoot, '.switchboard', 'plans'), { recursive: true });
    const db = KanbanDatabase.forWorkspace(tmpRoot);
    {
        const dbDir = path.dirname(db.dbPath);
        if (!fs.existsSync(dbDir)) { fs.mkdirSync(dbDir, { recursive: true }); }
        if (!fs.existsSync(db.dbPath)) { fs.writeFileSync(db.dbPath, Buffer.alloc(0)); }
        assert.ok(await db.ensureReady(), 'seeded kanban.db must initialise');
    }
    const wsId = (await db.getWorkspaceId()) || (await db.getDominantWorkspaceId()) || 'mstage-ws';

    async function seedPlan(slug) {
        const rel = `.switchboard/plans/${slug}.md`;
        fs.writeFileSync(path.join(tmpRoot, rel), `# ${slug}\n\n## Goal\n${slug}\n`, 'utf8');
        const now = new Date().toISOString();
        assert.ok(await db.insertFileDerivedPlan({
            planId: slug, sessionId: slug, topic: slug, planFile: rel,
            status: 'active', complexity: '3', tags: '', project: '', workspaceId: wsId,
            createdAt: now, updatedAt: now, sourceType: 'local', workspaceName: 'mstage', isFeature: 0,
        }), `seedPlan(${slug}) must insert`);
        return slug;
    }

    await test('claiming a card into a second mission removes it from the first, recorded on both', async () => {
        const planId = await seedPlan('ms-transfer');
        const first = await db.createMission({ workspaceId: wsId, name: 'First', ready: true });
        const second = await db.createMission({ workspaceId: wsId, name: 'Second', ready: true });

        const initial = await db.claimIntoMission(first.id, planId, 'plan', { workspaceId: wsId, by: 'test' });
        assert.strictEqual(initial.claimed, true, initial.error || '');
        assert.strictEqual(initial.transferredFrom, undefined, 'the first claim transfers nothing');

        const moved = await db.claimIntoMission(second.id, planId, 'plan', { workspaceId: wsId, by: 'test' });
        assert.strictEqual(moved.claimed, true, moved.error || '');
        assert.strictEqual(moved.transferredFrom, first.id, 'the claim reports the mission it took the card from');

        const owned = await db.getMissionsForMember(planId);
        assert.deepStrictEqual(owned, [second.id], 'exactly one membership row, on the NEW mission');
        assert.ok(!(await db.getMissionMembers(first.id)).some(m => m.memberId === planId),
            'and the first mission no longer lists it');

        const events = await db.getPlanEventsByPlanId(planId, wsId);
        const removed = events.filter(e => e.event_type === 'mission_member_removed');
        const claimed = events.filter(e => e.event_type === 'mission_member_claimed');
        assert.strictEqual(removed.length, 1, 'the mission that LOST the card has a recorded removal');
        assert.strictEqual(claimed.length, 2, 'every claim is recorded (the first, then the transfer)');
        const removalPayload = JSON.parse(removed[0].payload || '{}');
        assert.strictEqual(removalPayload.missionId, first.id, 'the removal names the mission that lost the card');
        assert.strictEqual(removalPayload.transferredTo, second.id, 'and where it went');
        const claimPayload = JSON.parse(claimed[1].payload || '{}');
        assert.strictEqual(claimPayload.transferredFrom, first.id, 'the later claim records where it came from');
    });

    await test('a claim into the mission the card is already in is a no-op', async () => {
        const planId = await seedPlan('ms-noop');
        const mission = await db.createMission({ workspaceId: wsId, name: 'Idempotent', ready: true });
        await db.claimIntoMission(mission.id, planId, 'plan', { workspaceId: wsId, by: 'test' });
        const before = (await db.getPlanEventsByPlanId(planId, wsId)).length;
        const again = await db.claimIntoMission(mission.id, planId, 'plan', { workspaceId: wsId, by: 'test' });
        assert.strictEqual(again.claimed, true);
        assert.strictEqual(again.transferredFrom, undefined, 're-claiming into the same mission moves nothing');
        assert.strictEqual((await db.getPlanEventsByPlanId(planId, wsId)).length, before,
            'and records nothing — a no-op is not history');
    });

    await test('a card is never a member of two missions, whatever sequence of claims runs', async () => {
        const planId = await seedPlan('ms-single');
        const a = await db.createMission({ workspaceId: wsId, name: 'A', ready: true });
        const b = await db.createMission({ workspaceId: wsId, name: 'B', ready: true });
        const c = await db.createMission({ workspaceId: wsId, name: 'C', ready: true });
        for (const m of [a, b, c, a, b]) {
            const res = await db.claimIntoMission(m.id, planId, 'plan', { workspaceId: wsId, by: 'test' });
            assert.strictEqual(res.claimed, true, res.error || '');
            const owned = await db.getMissionsForMember(planId);
            assert.ok(owned.length <= 1, `a card is a member of at most one mission, got ${JSON.stringify(owned)}`);
        }
        assert.deepStrictEqual(await db.getMissionsForMember(planId), [b.id], 'the LAST claim wins');
        // The invariant is the schema's, not the code's: a bare second row is refused.
        assert.ok(db._db, 'the database must be open for this check');
        let refused = false;
        try {
            db._db.run('INSERT INTO mission_members (mission_id, member_id, member_kind) VALUES (?, ?, ?)', [c.id, planId, 'plan']);
        } catch { refused = true; }
        assert.strictEqual(refused, true, 'UNIQUE(member_id) is what holds one-mission-per-card, and it must still be there');
    });

    await test('a claim into a mission in another workspace is refused', async () => {
        const planId = await seedPlan('ms-ws');
        const mission = await db.createMission({ workspaceId: 'some-other-workspace', name: 'Elsewhere', ready: true });
        const res = await db.claimIntoMission(mission.id, planId, 'plan', { workspaceId: wsId, by: 'test' });
        assert.strictEqual(res.claimed, false, 'a mission id from another workspace must not receive this workspace\'s card');
        assert.ok(/workspace/.test(res.error || ''), res.error);
    });

    await test('every caller claims through the transfer, never the bare insert', () => {
        const provider = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const api = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        assert.ok(/claimIntoMission\(/.test(provider), 'the provider must claim through claimIntoMission');
        assert.ok(/claimIntoMission\(/.test(api), 'the mission/member/add route must claim through it too');
        // stageForQueue and the batch claim are the two the plan names.
        const stageForQueue = provider.slice(provider.indexOf('public async stageForQueue('), provider.indexOf('public async reorderQueue('));
        assert.ok(/claimIntoMission\(/.test(stageForQueue) && !/addMissionMember\(/.test(stageForQueue),
            'stageForQueue must claim, not INSERT OR IGNORE');
        const batchClaim = provider.slice(provider.indexOf('public async claimBatchAsMission('), provider.indexOf('private async _discardEmptyMission('));
        assert.ok(/claimIntoMission\(/.test(batchClaim) && !/addMissionMember\(/.test(batchClaim),
            'the batch claim must transfer too — the operator\'s latest claim is the one that counts');
    });

    // ── 3. The release gate, through the pop ───────────────────────────────

    await test('a review mission holding a card in CREATED delivers nothing, and says why', async () => {
        const board = [card('ms-held', 'CREATED', { columnOrder: 1 })];
        const mission = { id: 'mission-review', team: 'review-team', workspaceId: 'ws1', plans: ['ms-held'] };
        const { server, dispatched } = makePopServer(board, mission);
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Review Lead', missionId: mission.id });
        assert.strictEqual(out.status, 200, `expected 200, got ${out.status}: ${out.payload.error || ''}`);
        assert.strictEqual(out.payload.dispatched, null, 'a card that would skip a stage is not delivered');
        assert.deepStrictEqual(dispatched, [], 'and nothing was dispatched');
        assert.ok(/^held:/.test(String(out.payload.reason)), `expected a held reason, got '${out.payload.reason}'`);
        assert.notStrictEqual(out.payload.reason, `queue empty for mission ${mission.id}`,
            '"held" and "this mission is drained" must not render the same string');
        assert.strictEqual(out.payload.missionId, mission.id);
        const held = out.payload.heldMembers || [];
        assert.strictEqual(held.length, 1, 'the held member is NAMED');
        assert.strictEqual(held[0].planId, 'ms-held');
        assert.ok(/CREATED/.test(held[0].reason), `the reason must name the card's column: ${held[0].reason}`);
    });

    await test('the same card in a coded column DELIVERS — that is the stage before review', async () => {
        const board = [card('ms-coded', 'CODER CODED', { columnOrder: 1 })];
        const mission = { id: 'mission-review', team: 'review-team', workspaceId: 'ws1', plans: ['ms-coded'] };
        const { server, dispatched } = makePopServer(board, mission);
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Review Lead', missionId: mission.id });
        assert.strictEqual(out.status, 200, `expected 200, got ${out.status}: ${out.payload.error || ''}`);
        assert.deepStrictEqual(dispatched, ['ms-coded'],
            'a review mission releases the card the coders just finished');
        assert.ok(!out.payload.heldMembers || out.payload.heldMembers.length === 0);
    });

    await test('a coding mission releases its own STAGING queue (the normal case)', async () => {
        const board = [card('ms-staged', 'STAGING', { columnOrder: 1 })];
        const mission = { id: 'mission-coding', team: 'coding-team', workspaceId: 'ws1', plans: ['ms-staged'] };
        const { server, dispatched } = makePopServer(board, mission);
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding Coder', missionId: mission.id });
        assert.strictEqual(out.status, 200, out.payload.error || '');
        assert.deepStrictEqual(dispatched, ['ms-staged'], 'an undelivered member is released from its own queue');
    });

    await test('a member already at the mission\'s own stage is DELIVERED, not held', async () => {
        const board = [card('ms-inflight', 'LEAD CODED', { columnOrder: 1, ownerSeat: 'Lead 1', ownerSince: '2026-09-20T00:00:00Z' })];
        const mission = { id: 'mission-feature', team: 'feature-implementation', workspaceId: 'ws1', plans: ['ms-inflight'] };
        const { server, dispatched } = makePopServer(board, mission);
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Feature Lead', missionId: mission.id });
        assert.strictEqual(out.status, 200, out.payload.error || '');
        assert.strictEqual(out.payload.dispatched, null, 'a card being worked is not re-released');
        assert.deepStrictEqual(dispatched, []);
        assert.ok(!/^held:/.test(String(out.payload.reason || '')),
            'in flight is not HELD — the two must never render the same');
        assert.ok(!out.payload.heldMembers || out.payload.heldMembers.length === 0,
            'and the card must not be listed as held on the mission card');
    });

    await test('an unresolvable mission team refuses to release, loudly, and holds every member', async () => {
        // A NON-EMPTY team that cannot be placed — a hand-added team, or one
        // deleted after the mission was created. The empty team is a different
        // case entirely (the pre-batch STAGING-assembled mission, covered below):
        // "never configured" must not read like "could not be resolved", and only
        // the second one refuses.
        const team = 'team-that-does-not-exist';
        const board = [card('ms-unknown', 'STAGING', { columnOrder: 1 })];
        const mission = { id: 'mission-unknown', team, workspaceId: 'ws1', plans: ['ms-unknown'] };
        const { server, dispatched } = makePopServer(board, mission);
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Someone', missionId: mission.id });
        assert.strictEqual(out.status, 200, out.payload.error || '');
        assert.strictEqual(out.payload.dispatched, null,
            `team '${team}': a mission nobody can place must deliver NOTHING — defaulting to no gate delivers everything`);
        assert.deepStrictEqual(dispatched, []);
        assert.ok(/^held:/.test(String(out.payload.reason)), `team '${team}': expected a held reason, got '${out.payload.reason}'`);
        assert.strictEqual((out.payload.heldMembers || []).length, 1, 'the held member is named');
        assert.ok(/could not be resolved|stage could not be derived/.test(out.payload.heldMembers[0].reason),
            `the reason must name the stage failure: ${out.payload.heldMembers[0].reason}`);
    });

    await test('a mission with NO team keeps the shipped STAGING behaviour — no gate, no holds', async () => {
        const board = [card('ms-staged', 'STAGING', { columnOrder: 1 })];
        const mission = { id: 'mission-staged', team: '', workspaceId: 'ws1', plans: ['ms-staged'] };
        const { server, dispatched } = makePopServer(board, mission);
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding', missionId: mission.id });
        assert.strictEqual(out.status, 200, out.payload.error || '');
        assert.deepStrictEqual(dispatched, ['ms-staged'],
            'a STAGING-assembled mission releases from STAGING exactly as it always has');
        assert.ok(!out.payload.heldMembers,
            'and nothing is held — an absent team is "never configured", which must not read like a team that could not be resolved');
    });

    await test('a team-less mission never reaches outside STAGING', async () => {
        // The widened candidate source belongs to a mission WITH a stage. Without
        // one, reading the members wherever they sit would re-dispatch a card that
        // was already delivered — the shipped staging flow's worst regression.
        const board = [card('ms-delivered', 'LEAD CODED', { columnOrder: 1 })];
        const mission = { id: 'mission-staged', team: '', workspaceId: 'ws1', plans: ['ms-delivered'] };
        const { server, dispatched } = makePopServer(board, mission);
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding', missionId: mission.id });
        assert.strictEqual(out.status, 200, out.payload.error || '');
        assert.deepStrictEqual(dispatched, [], 'a delivered card is not re-dispatched by a team-less mission');
        assert.strictEqual(out.payload.reason, `queue empty for mission ${mission.id}`,
            'and the answer is the M01 one, unchanged');
    });

    await test('the unscoped pop is untouched — a STAGING card still pops with no mission named', async () => {
        const board = [
            card('ms-loose', 'STAGING', { columnOrder: 1 }),
            card('ms-held', 'CREATED', { columnOrder: 2 }),
        ];
        const mission = { id: 'mission-review', team: 'review-team', workspaceId: 'ws1', plans: ['ms-held'] };
        const { server, dispatched } = makePopServer(board, mission);
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Standalone' });
        assert.strictEqual(out.status, 200, out.payload.error || '');
        assert.deepStrictEqual(dispatched, ['ms-loose'],
            'the workspace queue reads STAGING and nothing else — the gate is a mission-scoped rule');
    });

    // ── 4. The held reason on the card ─────────────────────────────────────

    await test('the mission card renders a held member\'s reason without a second card element', () => {
        const html = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'kanban.html'), 'utf8');
        const cardFn = html.slice(html.indexOf('function createMissionCardHtml('), html.indexOf('function renderRoundIndicator('));
        assert.ok(/mission\.held/.test(cardFn), 'the mission card must read the held list');
        assert.ok(/mission-held/.test(cardFn), 'and render it');
        assert.ok(/data-tooltip="\$\{escapeAttr\(heldTip\)\}"/.test(cardFn),
            'the REASON rides in the tooltip — a held member must say why, not just that it is held');
        const cardElements = (cardFn.match(/class="kanban-card mission-card/g) || []).length;
        assert.strictEqual(cardElements, 1, 'one card element, as before — no second card');
        assert.ok(/\.kanban-card\.mission-card \.mission-held\s*\{/.test(html), 'and it is styled distinctly from the status badge');
    });

    await test('every mission push attaches the held list, from the ONE enumeration', () => {
        const providerSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const apiSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const stageSrc = code(fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'missionStage.ts'), 'utf8'));

        // ONE definition of "which members are held, and why"...
        assert.strictEqual((stageSrc.match(/export function heldMembers\(/g) || []).length, 1,
            'missionStage.ts holds the one enumeration');
        // ...and both surfaces CALL it rather than re-deriving it: the pop refuses
        // to dispatch by it, the board payload renders it on the mission card.
        assert.ok(/heldMembers\(/.test(code(apiSrc)), 'the pop must enumerate holds through the shared function');
        assert.ok(/heldMembers\(/.test(code(providerSrc)), 'the board payload must too');
        assert.ok(!/_heldMembersOf/.test(code(providerSrc)),
            'and no second enumeration may exist beside it — two sites is the drift the feature forbids for the ranking');

        const calls = (providerSrc.match(/_attachMissionHeld\(/g) || []).length;
        assert.ok(calls >= 4, `the board pushes and the panel must all attach it (found ${calls} references)`);
        assert.ok(/private async _attachMissionHeld\(/.test(providerSrc), 'one attach site');
        assert.ok(/public async resolveMissionStage\(/.test(providerSrc),
            'and the stage derivation is a public seam: Mission 06 consumes it for the release column');
    });

    // ── 5. The seat-facing rendering ───────────────────────────────────────

    await test('the CLI reports a held release instead of printing nothing', () => {
        const cli = fs.readFileSync(path.join(process.cwd(), 'src', 'standalone', 'cli.ts'), 'utf8');
        const i = cli.indexOf("startsWith('held:')");
        assert.notStrictEqual(i, -1, 'cmdDone must recognise the held reason');
        // The CODE of the branch, not the comment about it: the comment says a
        // hold is "not the run is over", and a raw grep cannot tell the two apart.
        const branch = code(cli.slice(i, i + 700));
        assert.ok(/heldMembers/.test(branch), 'and name the held members from the payload');
        assert.ok(/data\.reason/.test(branch), 'and print the server\'s reason — a hold must say WHY');
        assert.ok(!/Queue empty — the run is over/.test(branch), 'a hold is not "the run is over"');
    });

    db.dispose();
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });

    console.log(`\n${failed === 0 ? `all ${passed} mission-stage/claim checks passed` : `${failed} of ${passed + failed} check(s) FAILED`}\n`);
    process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
