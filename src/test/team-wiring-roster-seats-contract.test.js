'use strict';

/**
 * Unit tests for the pure team-wiring helpers the plan
 * `memo-team-wiring-carries-frozen-strings-silent-fallbacks-and-unaddressable-teams.md`
 * names in change 8: `resolveTeamSeats`, `filterByProject` (command.js),
 * `rosterOf`/`rosterOfGroup`, and `terminalsShareTeam` (teamWiring.ts).
 *
 * Covers object-member resolution, object-roster vs string-roster behaviour,
 * and read-failure behaviour — the regression guards for changes 4, 5, and 7.
 *
 * These tests require `out/services/teamWiring` (compiled) and `command.js`
 * (source — command.js exports its pure functions via a Node guard).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    rosterOfGroup,
    terminalsShareTeam,
    resolveHeadForTerminal,
    resolveLiveGroupHeads,
    wireSpawnedTeam,
    migrateCodingTeamOrders,
    CONTEXT_AWARE_COMPLETION_ORDER_VERSION,
    TERMINALS_GROUPS_KEY,
} = require('../../out/services/teamWiring');
const { STANDING_ORDERS_CONFIG_KEY } = require('../../out/services/standingOrders');
const { resolveTeamSeats, filterByProjectFor } = require('../webview/command');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try { fn(); console.log(`  ok — ${name}`); passed++; }
    catch (e) { console.error(`  FAIL — ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

const _asyncCases = [];
function testAsync(name, fn) { _asyncCases.push([name, fn]); }
async function _drainAsyncCases() {
    for (const [name, fn] of _asyncCases) {
        try { await fn(); console.log(`  ok — ${name}`); passed++; }
        catch (e) { console.error(`  FAIL — ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
    }
}

function fakeDbGroups(groups) {
    return {
        async getConfigJson(key, _default) {
            if (key === 'switchboard.prompts.terminals.groups') return groups;
            if (key === 'terminals.groups') return [];
            return _default;
        },
    };
}

// ── rosterOfGroup ────────────────────────────────────────────────────────

test('rosterOfGroup: string roster (order) returns the names', () => {
    const g = { order: ['lead-1', 'coder-1', 'coder-2'] };
    assert.deepStrictEqual(rosterOfGroup(g), ['lead-1', 'coder-1', 'coder-2']);
});

test('rosterOfGroup: string roster (members fallback) returns the names', () => {
    const g = { members: ['lead-1', 'coder-1'] };
    assert.deepStrictEqual(rosterOfGroup(g), ['lead-1', 'coder-1']);
});

test('rosterOfGroup: object members resolve to friendlyName', () => {
    const g = { members: [
        { friendlyName: 'lead-1', role: 'lead' },
        { friendlyName: 'coder-1', role: 'coder' },
    ] };
    assert.deepStrictEqual(rosterOfGroup(g), ['lead-1', 'coder-1']);
});

test('rosterOfGroup: object members fall back to name when friendlyName absent', () => {
    const g = { members: [
        { name: 'lead-1', role: 'lead' },
        { name: 'coder-1', role: 'coder' },
    ] };
    assert.deepStrictEqual(rosterOfGroup(g), ['lead-1', 'coder-1']);
});

test('rosterOfGroup: mixed string + object roster resolves all', () => {
    const g = { order: ['lead-1', { friendlyName: 'coder-1' }, { name: 'coder-2' }] };
    assert.deepStrictEqual(rosterOfGroup(g), ['lead-1', 'coder-1', 'coder-2']);
});

test('rosterOfGroup: object member with no friendlyName or name is dropped', () => {
    const g = { members: [{ role: 'lead' }, { friendlyName: 'coder-1' }] };
    assert.deepStrictEqual(rosterOfGroup(g), ['coder-1']);
});

test('rosterOfGroup: empty/absent arrays return []', () => {
    assert.deepStrictEqual(rosterOfGroup({}), []);
    assert.deepStrictEqual(rosterOfGroup(null), []);
    assert.deepStrictEqual(rosterOfGroup({ members: [] }), []);
});

// ── terminalsShareTeam: object-roster vs string-roster ───────────────────

testAsync('terminalsShareTeam: string roster — same team returns true', async () => {
    const db = fakeDbGroups([{ id: 'team_lead_1', order: ['lead-1', 'coder-1'] }]);
    const out = await terminalsShareTeam({ db, a: 'lead-1', b: 'coder-1' });
    assert.strictEqual(out, true, 'both on the same string-roster team');
});

testAsync('terminalsShareTeam: object roster — same team returns true (change 4 guard)', async () => {
    const db = fakeDbGroups([{ id: 'team_lead_1', members: [
        { friendlyName: 'lead-1' },
        { friendlyName: 'coder-1' },
    ] }]);
    const out = await terminalsShareTeam({ db, a: 'lead-1', b: 'coder-1' });
    assert.strictEqual(out, true, 'object roster must resolve to the same answer as the string roster');
});

testAsync('terminalsShareTeam: object roster — different teams returns false', async () => {
    const db = fakeDbGroups([
        { id: 'team_lead_1', members: [{ friendlyName: 'lead-1' }] },
        { id: 'team_lead_2', members: [{ friendlyName: 'coder-1' }] },
    ]);
    const out = await terminalsShareTeam({ db, a: 'lead-1', b: 'coder-1' });
    assert.strictEqual(out, false, 'two terminals on different object-roster teams are not same-team');
});

testAsync('terminalsShareTeam: object roster matches equivalent string roster answer', async () => {
    const stringDb = fakeDbGroups([{ id: 'team_lead_1', order: ['lead-1', 'coder-1', 'reviewer-1'] }]);
    const objectDb = fakeDbGroups([{ id: 'team_lead_1', members: [
        { friendlyName: 'lead-1' },
        { friendlyName: 'coder-1' },
        { friendlyName: 'reviewer-1' },
    ] }]);
    const stringAnswer = await terminalsShareTeam({ db: stringDb, a: 'coder-1', b: 'reviewer-1' });
    const objectAnswer = await terminalsShareTeam({ db: objectDb, a: 'coder-1', b: 'reviewer-1' });
    assert.strictEqual(objectAnswer, stringAnswer, 'object roster must produce the same delegation answer as the equivalent string roster');
});

// ── terminalsShareTeam: read-failure (conservative return true) ───────────

testAsync('terminalsShareTeam: read failure returns true (conservative same-team)', async () => {
    const db = {
        async getConfigJson() { throw new Error('disk read failed'); },
    };
    const out = await terminalsShareTeam({ db, a: 'lead-1', b: 'coder-1' });
    assert.strictEqual(out, true, 'a read failure is uncertainty — the conservative direction is same-team');
});

testAsync('terminalsShareTeam: no groups returns true (conservative same-team)', async () => {
    const db = fakeDbGroups([]);
    const out = await terminalsShareTeam({ db, a: 'lead-1', b: 'coder-1' });
    assert.strictEqual(out, true, 'no team data is uncertainty — the conservative direction is same-team');
});

testAsync('terminalsShareTeam: a === b returns true', async () => {
    const db = fakeDbGroups([{ id: 'team_lead_1', order: ['lead-1'] }]);
    const out = await terminalsShareTeam({ db, a: 'lead-1', b: 'lead-1' });
    assert.strictEqual(out, true, 'a terminal trivially shares a team with itself');
});

testAsync('terminalsShareTeam: no db returns true (conservative)', async () => {
    const out = await terminalsShareTeam({ a: 'lead-1', b: 'coder-1' });
    assert.strictEqual(out, true, 'no db is uncertainty — conservative same-team');
});

// ── resolveHeadForTerminal ───────────────────────────────────────────────

testAsync('resolveHeadForTerminal: returns the head of the team containing the terminal', async () => {
    const db = fakeDbGroups([{ id: 'team_lead_1', head: 'lead-1', members: ['lead-1', 'coder-1'] }]);
    const out = await resolveHeadForTerminal({ db, terminal: 'coder-1' });
    assert.strictEqual(out, 'lead-1', 'the coder\'s lead is the team head');
});

testAsync('resolveHeadForTerminal: object roster resolves member then head', async () => {
    const db = fakeDbGroups([{ id: 'team_lead_1', head: 'lead-1', members: [
        { friendlyName: 'lead-1' },
        { friendlyName: 'coder-1' },
    ] }]);
    const out = await resolveHeadForTerminal({ db, terminal: 'coder-1' });
    assert.strictEqual(out, 'lead-1', 'object roster member resolves, then head is returned');
});

testAsync('resolveHeadForTerminal: terminal on no team returns null', async () => {
    const db = fakeDbGroups([{ id: 'team_lead_1', head: 'lead-1', members: ['lead-1', 'coder-1'] }]);
    const out = await resolveHeadForTerminal({ db, terminal: 'reviewer-1' });
    assert.strictEqual(out, null, 'a terminal on no registered team has no head');
});

testAsync('resolveHeadForTerminal: group with no head field returns null', async () => {
    const db = fakeDbGroups([{ id: 'team_lead_1', members: ['lead-1', 'coder-1'] }]);
    const out = await resolveHeadForTerminal({ db, terminal: 'coder-1' });
    assert.strictEqual(out, null, 'a group with no head cannot delegate');
});

// ── resolveLiveGroupHeads ─────────────────────────────────────────────────

testAsync('resolveLiveGroupHeads: maps definitionId and id to head', async () => {
    const db = fakeDbGroups([
        { id: 'team_lead_1', head: 'lead-1', definitionId: 'def-1', members: ['lead-1'] },
        { id: 'team_lead_2', head: 'lead-2', definitionId: 'def-2', members: ['lead-2'] },
    ]);
    const out = await resolveLiveGroupHeads({ db });
    assert.strictEqual(out.get('def-1'), 'lead-1');
    assert.strictEqual(out.get('def-2'), 'lead-2');
    assert.strictEqual(out.get('team_lead_1'), 'lead-1');
    assert.strictEqual(out.get('team_lead_2'), 'lead-2');
});

testAsync('resolveLiveGroupHeads: group with no head is skipped', async () => {
    const db = fakeDbGroups([{ id: 'team_lead_1', definitionId: 'def-1', members: ['lead-1'] }]);
    const out = await resolveLiveGroupHeads({ db });
    assert.strictEqual(out.size, 0, 'a group with no head contributes nothing');
});

testAsync('resolveLiveGroupHeads: empty groups returns empty map', async () => {
    const db = fakeDbGroups([]);
    const out = await resolveLiveGroupHeads({ db });
    assert.strictEqual(out.size, 0);
});

// ── resolveTeamSeats (command.js) ─────────────────────────────────────────

test('resolveTeamSeats: head by explicit team.head name (arm 1)', () => {
    const teams = [{ id: 't1', headRole: 'lead', head: 'lead-1' }];
    const fleet = [{ friendlyName: 'lead-1', role: 'lead', agentInstanceId: 'a1', status: 'active' }];
    const out = resolveTeamSeats(teams, fleet);
    assert.strictEqual(out.get('t1').head.friendlyName, 'lead-1');
    assert.deepStrictEqual(out.get('t1').members, []);
});

test('resolveTeamSeats: head by role when no team.head (arm 2)', () => {
    const teams = [{ id: 't1', headRole: 'lead' }];
    const fleet = [{ friendlyName: 'lead-1', role: 'lead', agentInstanceId: 'a1', status: 'active' }];
    const out = resolveTeamSeats(teams, fleet);
    assert.strictEqual(out.get('t1').head.friendlyName, 'lead-1');
});

test('resolveTeamSeats: two teams sharing headRole — claim order, no double-claim', () => {
    const teams = [
        { id: 't1', headRole: 'lead' },
        { id: 't2', headRole: 'lead' },
    ];
    const fleet = [
        { friendlyName: 'lead-1', role: 'lead', agentInstanceId: 'a1', status: 'active' },
        { friendlyName: 'lead-2', role: 'lead', agentInstanceId: 'a2', status: 'active' },
    ];
    const out = resolveTeamSeats(teams, fleet);
    assert.strictEqual(out.get('t1').head.friendlyName, 'lead-1', 'first team claims first lead');
    assert.strictEqual(out.get('t2').head.friendlyName, 'lead-2', 'second team gets the remaining lead');
});

test('resolveTeamSeats: explicit head disambiguates two teams sharing headRole', () => {
    const teams = [
        { id: 't1', headRole: 'lead', head: 'lead-2' },
        { id: 't2', headRole: 'lead', head: 'lead-1' },
    ];
    const fleet = [
        { friendlyName: 'lead-1', role: 'lead', agentInstanceId: 'a1', status: 'active' },
        { friendlyName: 'lead-2', role: 'lead', agentInstanceId: 'a2', status: 'active' },
    ];
    const out = resolveTeamSeats(teams, fleet);
    assert.strictEqual(out.get('t1').head.friendlyName, 'lead-2', 'arm 1 matches by explicit head name');
    assert.strictEqual(out.get('t2').head.friendlyName, 'lead-1');
});

test('resolveTeamSeats: members by parentInstanceId', () => {
    const teams = [{ id: 't1', headRole: 'lead', head: 'lead-1' }];
    const fleet = [
        { friendlyName: 'lead-1', role: 'lead', agentInstanceId: 'a1', status: 'active' },
        { friendlyName: 'coder-1', role: 'coder', agentInstanceId: 'c1', parentInstanceId: 'a1', status: 'active' },
        { friendlyName: 'coder-2', role: 'coder', agentInstanceId: 'c2', parentInstanceId: 'a1', status: 'active' },
        { friendlyName: 'coder-3', role: 'coder', agentInstanceId: 'c3', parentInstanceId: 'other', status: 'active' },
    ];
    const out = resolveTeamSeats(teams, fleet);
    assert.strictEqual(out.get('t1').members.length, 2, 'only children of the head');
    assert.deepStrictEqual(out.get('t1').members.map(m => m.friendlyName), ['coder-1', 'coder-2']);
});

test('resolveTeamSeats: exited seats are not claimed', () => {
    const teams = [{ id: 't1', headRole: 'lead' }];
    const fleet = [
        { friendlyName: 'lead-1', role: 'lead', agentInstanceId: 'a1', status: 'exited' },
        { friendlyName: 'lead-2', role: 'lead', agentInstanceId: 'a2', status: 'active' },
    ];
    const out = resolveTeamSeats(teams, fleet);
    assert.strictEqual(out.get('t1').head.friendlyName, 'lead-2', 'exited seats are filtered from the pool');
});

test('resolveTeamSeats: no matching head returns null head', () => {
    const teams = [{ id: 't1', headRole: 'reviewer' }];
    const fleet = [{ friendlyName: 'lead-1', role: 'lead', agentInstanceId: 'a1', status: 'active' }];
    const out = resolveTeamSeats(teams, fleet);
    assert.strictEqual(out.get('t1').head, null, 'no matching seat yields null head');
    assert.deepStrictEqual(out.get('t1').members, []);
});

// ── filterByProjectFor (command.js) ───────────────────────────────────────

test('filterByProjectFor: __all__ returns all cards', () => {
    const cards = [{ project: 'a' }, { project: 'b' }];
    assert.deepStrictEqual(filterByProjectFor(cards, '__all__'), cards);
});

test('filterByProjectFor: undefined project returns all cards', () => {
    const cards = [{ project: 'a' }, { project: 'b' }];
    assert.deepStrictEqual(filterByProjectFor(cards, undefined), cards);
});

test('filterByProjectFor: __unassigned__ matches empty/null/undefined/__unassigned__', () => {
    const cards = [
        { project: 'a' },
        { project: '' },
        { project: null },
        { project: undefined },
        { project: '__unassigned__' },
    ];
    const out = filterByProjectFor(cards, '__unassigned__');
    assert.strictEqual(out.length, 4, 'four project-less cards match __unassigned__');
});

test('filterByProjectFor: exact project match', () => {
    const cards = [{ project: 'a' }, { project: 'b' }, { project: 'a' }];
    const out = filterByProjectFor(cards, 'a');
    assert.strictEqual(out.length, 2);
    assert.ok(out.every(c => c.project === 'a'));
});

test('filterByProjectFor: no matching project returns empty', () => {
    const cards = [{ project: 'a' }, { project: 'b' }];
    assert.deepStrictEqual(filterByProjectFor(cards, 'c'), []);
});

// ── no team without delegates (subtask 3's named regression guard) ────────
//
// `wireSpawnedTeam` self-guards member-less starts out of group registration at
// its entry (`if (!headName || children.length === 0) return { ok: true }`),
// BEFORE the groupId derivation and the group write. That guard is the single
// chokepoint both composition roots pass through — the standalone host's
// duplicate `children.length > 0` call-site guard was removed on its authority —
// so it is the thing that must not silently rot. Neither host has a second
// guard to catch it if it does.

function makeGroupsDb(seed) {
    const store = Object.assign({}, seed || {});
    return {
        getConfigJson: async (key, fallback) =>
            (key in store ? JSON.parse(JSON.stringify(store[key])) : fallback),
        setConfigJson: async (key, value) => { store[key] = JSON.parse(JSON.stringify(value)); return true; },
        ensureReady: async () => true,
        _store: store,
    };
}

testAsync('no team without delegates: members: [] registers NO team_ row', async () => {
    const db = makeGroupsDb();
    const result = await wireSpawnedTeam({
        db, headName: 'planner-1', children: [], members: [],
    });
    assert.strictEqual(result.ok, true, result.error);
    const scoped = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
    assert.deepStrictEqual(scoped, [],
        'a head-only start must add no row to switchboard.prompts.terminals.groups');
    assert.ok(!result.groupId,
        'a member-less start must not report a groupId — the standalone broadcast gates on it');
});

testAsync('no team without delegates: one delegate registers EXACTLY one team_ row', async () => {
    const db = makeGroupsDb();
    const result = await wireSpawnedTeam({
        db, headName: 'lead-1', children: [{ friendlyName: 'lead-1-coder-1', role: 'coder' }],
        members: [{ role: 'coder', count: 1 }],
    });
    assert.strictEqual(result.ok, true, result.error);
    const scoped = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
    const teamRows = scoped.filter(g => g && typeof g.id === 'string' && g.id.startsWith('team_'));
    assert.strictEqual(teamRows.length, 1, 'exactly one team_ row for a team with one delegate');
    assert.strictEqual(teamRows[0].id, result.groupId);
    assert.ok(teamRows[0].members.length >= 2,
        'every team_ row carries at least two members (head + delegate)');
});

testAsync('no team without delegates: a head-only start is a no-op even on a board that already has teams', async () => {
    const db = makeGroupsDb();
    await wireSpawnedTeam({
        db, headName: 'lead-1', children: [{ friendlyName: 'lead-1-coder-1', role: 'coder' }],
        members: [{ role: 'coder', count: 1 }],
    });
    const before = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
    await wireSpawnedTeam({ db, headName: 'planner-1', children: [], members: [] });
    const after = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
    assert.deepStrictEqual(after, before,
        'a member-less start must leave the registered groups byte-identical');
});

// ── the version stamp must not become a licence to overwrite ─────────────
//
// The frozen-body recognisers were deleted in favour of a `version` stamp. The
// trap that replaces them: an OPERATOR-authored team prompt (a definition's
// `prompt`) is persisted under the SAME `context-aware-completion:<gid>:team`
// id, with its text in `instruction`. Keying the rewrite on "has an instruction
// and is not at the current version" therefore clobbers the operator's words —
// which is exactly why the retired matchers compared exact bodies. The stamp is
// written only on the system-default install, and the migrator rewrites only
// what carries it.

testAsync('a definition-authored team prompt is installed UNSTAMPED and survives migration', async () => {
    const db = makeGroupsDb();
    await wireSpawnedTeam({
        db, headName: 'lead-1', children: [{ friendlyName: 'lead-1-coder-1', role: 'coder' }],
        members: [{ role: 'coder', count: 1 }],
        prompt: 'OPERATOR TEAM PROMPT for {child} — do not rewrite me',
    });
    const orders = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []);
    const teamOrder = orders.find(o => o.scope === 'team');
    assert.ok(teamOrder, 'a team-scoped order must be installed');
    assert.ok(typeof teamOrder.instruction === 'string' && teamOrder.instruction.includes('OPERATOR TEAM PROMPT'),
        'the definition prompt is carried as the order instruction');
    assert.strictEqual(teamOrder.version, undefined,
        'an operator-authored row must NOT carry the system version stamp');

    const migrated = migrateCodingTeamOrders(orders);
    const after = migrated.find(o => o.scope === 'team');
    assert.strictEqual(after.instruction, teamOrder.instruction,
        'migrateCodingTeamOrders must never rewrite an operator-authored team prompt');
});

testAsync('the system default install IS stamped, so a future body revision can migrate it', async () => {
    const db = makeGroupsDb();
    await wireSpawnedTeam({
        db, headName: 'lead-2', children: [{ friendlyName: 'lead-2-coder-1', role: 'coder' }],
        members: [{ role: 'coder', count: 1 }],
    });
    const orders = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []);
    const teamOrder = orders.find(o => o.scope === 'team');
    assert.strictEqual(teamOrder.version, CONTEXT_AWARE_COMPLETION_ORDER_VERSION,
        'the default install carries the current version stamp');
});

test('an unstamped legacy body that names the port file still heals', () => {
    const legacy = {
        id: 'context-aware-completion:team_x:team',
        parent: 'lead-1', child: '', scope: 'team', teamId: 'team_x',
        instruction: 'Route your report. Read the port in .switchboard/api-server-port.txt and POST there.',
    };
    const out = migrateCodingTeamOrders([legacy]);
    assert.ok(!out[0].instruction.includes('api-server-port.txt'),
        'the port-file body is the one legacy shape that must still be rewritten');
    assert.strictEqual(out[0].version, CONTEXT_AWARE_COMPLETION_ORDER_VERSION,
        'a healed row is stamped so the next read is a no-op');
    assert.deepStrictEqual(migrateCodingTeamOrders(out), out,
        'second pass must return the input by reference (idempotent)');
});

// ── a head seat is never named after its definition ──────────────────────
//
// `result.terminal?.friendlyName || group?.name` is how a definition name became
// a terminal name: starting `feature-implementation` ("Lead team") produced a
// seat called "Lead team" and a group id derived from it. The head's name comes
// from its ROLE. Source-level because `instantiateAgentGroupCore` takes six host
// callbacks and the defect is in what it PASSES, not in what it returns.

test('instantiateAgentGroupCore never passes the definition name as the head seat name', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'agentGroupInstantiation.ts'), 'utf8');
    const start = src.indexOf('const result = await createHeadWithDelegates({');
    assert.ok(start > 0, 'the createHeadWithDelegates call was not found');
    const spec = src.slice(start, src.indexOf('});', start));
    assert.ok(!/\bname:\s*group\?\.name/.test(spec),
        'the head spec must not pass group?.name — that names the seat after the team');
    assert.ok(/teamName:\s*group\?\.name/.test(spec),
        'the definition name belongs on teamName, where it is a team name');

    const fallbackIdx = src.indexOf('const headName =');
    assert.ok(fallbackIdx > 0, 'the headName binding was not found');
    const fallback = src.slice(fallbackIdx, src.indexOf('\n', fallbackIdx));
    assert.ok(!/group\?\.name/.test(fallback),
        'the headName fallback must not be the definition name');
    assert.ok(/headRole/.test(fallback),
        'the headName fallback must derive from the head ROLE (e.g. `${headRole}-1`)');
});

// ── runner ────────────────────────────────────────────────────────────────

(async () => {
    await _drainAsyncCases();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exitCode = 1; }
})();
