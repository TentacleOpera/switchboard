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
const {
    rosterOfGroup,
    terminalsShareTeam,
    resolveHeadForTerminal,
    resolveLiveGroupHeads,
} = require('../../out/services/teamWiring');
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

// ── runner ────────────────────────────────────────────────────────────────

(async () => {
    await _drainAsyncCases();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exitCode = 1; }
})();
