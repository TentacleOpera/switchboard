'use strict';

/**
 * Contract: wireSpawnedTeam persists headRole into the live group object, and
 * the read-path cross-reference fills it in for pre-fix groups.
 * Plan: .switchboard/plans/fix-headrole-missing-from-live-terminal-groups.md
 *
 * The defect this pins: `wireSpawnedTeam` wrote the group object persisted to
 * TERMINALS_GROUPS_KEY without a `headRole` field. Both
 * `resolveCodingRolesFromGroups` and `_resolveTeamRosterForPrompt` filter on
 * `g.headRole === 'lead'` — every group was skipped, both resolvers returned
 * empty/null, and six downstream consumers (Run-queue button, runQueue
 * handler, queue watch arming, extension.ts queue head resolver,
 * TaskViewerProvider autoban dispatch, drive-mode enriched prompt) were
 * silently broken since the V60 migration.
 *
 * Covers the plan's `### Automated Tests` list (items 1-8):
 *  1. wireSpawnedTeam persists headRole in the live group
 *  2. wireSpawnedTeam defaults headRole to 'lead' when not passed
 *  3. Persisted group literal is field-for-field complete
 *  4. External-headed team excludes head from members but persists headRole
 *  5. Re-wire (upsert) preserves headRole in the merged group
 *  6. resolveCodingRolesFromGroups finds a lead when headRole is missing from
 *     the live group (cross-reference against terminals.agentGroups)
 *  7. resolveCodingRolesFromGroups defaults to 'lead' when agentGroups is also
 *     missing
 *  8. _resolveTeamRosterForPrompt finds the team when headRole is missing from
 *     the live group
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js \
 *     src/test/terminal-groups-headrole-contract.test.js
 * Requires `npm run compile-tests` (loads compiled output from out/).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Module = require('module');

// Map `vscode` to the compiled standalone shim — same aliasing webpack applies
// when bundling the npx host, so KanbanProvider constructed here takes the
// exact code path src/standalone/bootstrap.ts takes.
const shimPath = path.join(__dirname, '..', '..', 'out', 'standalone', 'vscodeShim.js');
{
    const originalLoad = Module._load;
    Module._load = function (request) {
        if (request === 'vscode') return require(shimPath);
        return originalLoad.apply(this, arguments);
    };
}

const {
    TERMINALS_GROUPS_KEY,
    wireSpawnedTeam,
} = require('../../out/services/teamWiring');
const { KanbanProvider } = require('../../out/services/KanbanProvider');

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

/** Minimal async config store, same shape KanbanDatabase exposes to teamWiring. */
function makeInMemoryDb(seed) {
    const store = Object.assign({}, seed);
    return {
        getConfigJson: async (key, fallback) =>
            (key in store ? JSON.parse(JSON.stringify(store[key])) : fallback),
        setConfigJson: async (key, value) => { store[key] = JSON.parse(JSON.stringify(value)); return true; },
        ensureReady: async () => true,
        _store: store,
    };
}

/** Build a config-compatible DB seeded with the given rows. */
async function makeSeededKanbanDb(configSeed) {
    return makeInMemoryDb(configSeed);
}

/** Construct a KanbanProvider over a temp workspace, with a mocked fleet liveness source. */
async function makeProvider(tmpRoot, fleetLiveness, db) {
    const kp = Object.create(KanbanProvider.prototype);
    kp._getKanbanDb = () => db;
    kp._hostSeams = undefined;
    kp._currentWorkspaceRoot = tmpRoot;
    // Mock the fleet liveness source the resolvers read via
    // `this._taskViewerProvider?.getFleetLiveness()`.
    kp._taskViewerProvider = {
        getFleetLiveness: () => fleetLiveness,
    };
    kp.dispose = () => {};
    return kp;
}

(async () => {
    console.log('Terminal groups headRole contract');

    // ── 1. wireSpawnedTeam persists headRole in the live group ───────────────

    await test('1. wireSpawnedTeam persists headRole in the live group', async () => {
        const db = makeInMemoryDb();
        const result = await wireSpawnedTeam({
            db, headName: 'lead-1', children: [{ friendlyName: 'lead-1-coder-1' }],
            members: [{ role: 'coder', count: 1 }], headRole: 'lead',
        });
        assert.strictEqual(result.ok, true, result.error);
        const groups = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
        assert.strictEqual(groups.length, 1);
        assert.strictEqual(groups[0].headRole, 'lead',
            'the persisted live group must carry headRole');
    });

    // ── 2. wireSpawnedTeam defaults headRole to 'lead' when not passed ───────

    await test('2. wireSpawnedTeam defaults headRole to \'lead\' when not passed', async () => {
        const db = makeInMemoryDb();
        const result = await wireSpawnedTeam({
            db, headName: 'lead-2', children: [{ friendlyName: 'lead-2-coder-1' }],
            members: [{ role: 'coder', count: 1 }],
        });
        assert.strictEqual(result.ok, true, result.error);
        const groups = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
        assert.strictEqual(groups[0].headRole, 'lead',
            'omitted headRole must default to \'lead\' — wireSpawnedTeam is only called for team groups');
    });

    // ── 3. Persisted group literal is field-for-field complete ───────────────

    await test('3. Persisted group literal is field-for-field complete', async () => {
        const db = makeInMemoryDb();
        await wireSpawnedTeam({
            db, headName: 'lead-3', children: [{ friendlyName: 'lead-3-coder-1' }],
            members: [{ role: 'coder', count: 1 }], headRole: 'lead',
        });
        const groups = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
        const g = groups[0];
        const keys = Object.keys(g).sort();
        assert.deepStrictEqual(
            keys,
            // `head` and `teamKind` are the identity pair wireSpawnedTeam always
            // writes: `head` is the DECLARED head name (never inferred from
            // order[0], which the operator can reorder), and `teamKind:'spawned'`
            // is the positive marker isSpawnedTeamGroup reads first. `teamGroup`
            // is the legacy flag migrateTeamGroupFlags backfills on older rows.
            ['externalHead', 'head', 'headRole', 'id', 'layout', 'members', 'name',
                'order', 'source', 'teamGroup', 'teamKind'].sort(),
            `persisted group must carry exactly these keys (got ${JSON.stringify(keys)}); a future writer that adds or drops a field must update this gate`);
    });

    // ── 4. External-headed team excludes head from members but persists headRole

    await test('4. External-headed team excludes head from members but persists headRole', async () => {
        const db = makeInMemoryDb();
        await wireSpawnedTeam({
            db, headName: 'ExtLead', children: [{ friendlyName: 'worker-1' }, { friendlyName: 'worker-2' }],
            externalHead: true, headRole: 'lead',
        });
        const groups = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
        const g = groups[0];
        assert.strictEqual(g.headRole, 'lead', 'external-headed team must persist headRole');
        assert.deepStrictEqual(g.members, ['worker-1', 'worker-2'],
            'members must exclude the head name for an external-headed team');
        assert.strictEqual(g.externalHead, true);
    });

    // ── 5. Re-wire (upsert) preserves headRole in the merged group ───────────

    await test('5. Re-wire (upsert) preserves headRole in the merged group', async () => {
        // Pre-populate with a pre-fix group that has NO headRole.
        const teamId = 'team_' + encodeURIComponent('lead-5').replace(/[^a-zA-Z0-9_]/g, '_');
        const db = makeInMemoryDb({
            [TERMINALS_GROUPS_KEY]: [{
                id: teamId, name: 'lead-5', source: 'manual', teamGroup: true,
                layout: '1x2', members: ['lead-5', 'old-coder'], order: ['lead-5', 'old-coder'],
                externalHead: false,
                // NOTE: no headRole — simulating a pre-fix install
            }],
        });
        // Re-wire the same team — the upsert merge path must write headRole.
        const result = await wireSpawnedTeam({
            db, headName: 'lead-5', children: [{ friendlyName: 'lead-5-coder-1' }],
            members: [{ role: 'coder', count: 1 }], headRole: 'lead',
        });
        assert.strictEqual(result.ok, true, result.error);
        const groups = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
        const g = groups.find(x => x.id === teamId);
        assert.ok(g, 're-wired group must still be present');
        assert.strictEqual(g.headRole, 'lead',
            'the upsert merge path must write headRole permanently, not just the initial create path');
    });

    // ── 6. resolveCodingRolesFromGroups finds a lead when headRole is missing ─

    await test('6. resolveCodingRolesFromGroups finds a lead when headRole is missing from the live group', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-headrole-6-'));
        try {
            const teamId = 'team_' + encodeURIComponent('live-lead').replace(/[^a-zA-Z0-9_]/g, '_');
            const db = await makeSeededKanbanDb({
                [TERMINALS_GROUPS_KEY]: [{
                    id: teamId, name: 'live-lead', source: 'manual', teamGroup: true,
                    layout: '1x2', members: ['live-lead', 'live-lead-coder-1'],
                    order: ['live-lead', 'live-lead-coder-1'], externalHead: false,
                    // no headRole — pre-fix group
                }, {
                    id: 'grp_manual', name: 'manual-terminal', source: 'manual',
                    layout: '1x1', members: ['manual-terminal'], order: ['manual-terminal'],
                }],
                'terminals.agentGroups': [{
                    id: teamId, name: 'live-lead', headRole: 'lead',
                    members: [{ role: 'coder', count: 1 }],
                }],
            });
            const fleetLiveness = [
                { friendlyName: 'live-lead', status: 'live' },
                { friendlyName: 'live-lead-coder-1', status: 'live' },
                { friendlyName: 'manual-terminal', status: 'live' },
            ];
            const kp = await makeProvider(tmpRoot, fleetLiveness, db);
            try {
                const { leads, coders } = await kp.resolveCodingRolesFromGroups(tmpRoot);
                assert.ok(leads.length > 0,
                    `cross-reference must fill headRole so the lead is found (got leads=${JSON.stringify(leads)})`);
                assert.ok(leads.includes('live-lead'),
                    'the live lead terminal name must be resolved');
                assert.ok(!leads.includes('manual-terminal'),
                    'a non-team group without headRole must not be defaulted to lead');
            } finally {
                kp.dispose();
            }
        } finally {
            await fs.promises.rm(tmpRoot, { recursive: true, force: true });
        }
    });

    // ── 7. resolveCodingRolesFromGroups defaults to 'lead' when agentGroups missing

    await test('7. resolveCodingRolesFromGroups defaults to \'lead\' when agentGroups is also missing', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-headrole-7-'));
        try {
            const teamId = 'team_' + encodeURIComponent('orphan-lead').replace(/[^a-zA-Z0-9_]/g, '_');
            // Seed the live group with no headRole AND no terminals.agentGroups entry.
            const db = await makeSeededKanbanDb({
                [TERMINALS_GROUPS_KEY]: [{
                    id: teamId, name: 'orphan-lead', source: 'manual', teamGroup: true,
                    layout: '1x2', members: ['orphan-lead', 'orphan-lead-coder-1'],
                    order: ['orphan-lead', 'orphan-lead-coder-1'], externalHead: false,
                }],
            });
            const fleetLiveness = [
                { friendlyName: 'orphan-lead', status: 'live' },
            ];
            const kp = await makeProvider(tmpRoot, fleetLiveness, db);
            try {
                const { leads } = await kp.resolveCodingRolesFromGroups(tmpRoot);
                assert.ok(leads.length > 0,
                    `a team group with no headRole and no agentGroups entry must default to 'lead' (got leads=${JSON.stringify(leads)})`);
                assert.ok(leads.includes('orphan-lead'));
            } finally {
                kp.dispose();
            }
        } finally {
            await fs.promises.rm(tmpRoot, { recursive: true, force: true });
        }
    });

    // ── 8. _resolveTeamRosterForPrompt finds the team when headRole is missing ─

    await test('8. _resolveTeamRosterForPrompt finds the team when headRole is missing from the live group', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-headrole-8-'));
        try {
            const teamId = 'team_' + encodeURIComponent('roster-lead').replace(/[^a-zA-Z0-9_]/g, '_');
            const db = await makeSeededKanbanDb({
                [TERMINALS_GROUPS_KEY]: [{
                    id: teamId, name: 'roster-lead', source: 'manual', teamGroup: true,
                    layout: '1x2', members: ['roster-lead', 'roster-lead-coder-1', 'roster-lead-coder-2'],
                    order: ['roster-lead', 'roster-lead-coder-1', 'roster-lead-coder-2'],
                    externalHead: false,
                    // no headRole — pre-fix group
                }],
                'terminals.agentGroups': [{
                    id: teamId, name: 'roster-lead', headRole: 'lead',
                    members: [{ role: 'coder', count: 2 }],
                }],
            });
            const fleetLiveness = [
                { friendlyName: 'roster-lead', status: 'live' },
                { friendlyName: 'roster-lead-coder-1', status: 'live' },
                { friendlyName: 'roster-lead-coder-2', status: 'live' },
            ];
            const kp = await makeProvider(tmpRoot, fleetLiveness, db);
            try {
                // _resolveTeamRosterForPrompt is private — access via bracket notation.
                const roster = await kp['_resolveTeamRosterForPrompt'](tmpRoot);
                assert.ok(roster && Array.isArray(roster.members) && roster.members.length > 0,
                    `the roster must resolve when headRole is filled by cross-reference (got ${JSON.stringify(roster)})`);
                assert.strictEqual(roster.head, 'roster-lead', 'the head must match target group name');
                const names = roster.members.map(r => r.name);
                assert.ok(!names.includes('roster-lead'),
                    'the head must be excluded from the roster (members[0] skipped)');
                assert.ok(names.includes('roster-lead-coder-1') && names.includes('roster-lead-coder-2'),
                    'both workers must appear in the roster');
            } finally {
                kp.dispose();
            }
        } finally {
            await fs.promises.rm(tmpRoot, { recursive: true, force: true });
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
