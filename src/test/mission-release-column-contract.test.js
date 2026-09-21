'use strict';

/**
 * Mission 06 — a mission owns its members' columns; a single plan still routes.
 *
 * Complexity routing decides the SEAT for one plan and stops deciding for a
 * batch. A cx-2 card dispatched on its own still goes to the Coding team's
 * intern — that is what makes a cheap seat worth having — but once a batch's
 * plans are a mission's members, the MISSION decides where each goes as it
 * releases it. Routing members individually scatters one mission across three
 * columns and contradicts the seat the team was going to give each one
 * (`LocalApiServer.ts`'s own note records the failure: "a cx-2 subtask resolved
 * INTERN CODED while the card sat at LEAD CODED … the move was refused").
 *
 * The mechanism is the pop's EXISTING explicit-column channel — the one the
 * escalation override already uses — so an explicit column keeps winning over
 * auto-routing whoever supplied it, and there is no second precedence rule (no
 * `skipAutoRoute` flag). The column itself comes from Mission 08's stage
 * derivation; a second team→column mapping is the drift this pins against.
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

const { KanbanProvider } = require('../../out/services/KanbanProvider');
const { LocalApiServer } = require('../../out/services/LocalApiServer');
const { BroadcastHub } = require('../../out/services/broadcastHub');
const { resolveStageForHeadRole } = require('../../out/services/missionStage');

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

/** Source with comments removed — a gate must not be fooled by prose. */
function code(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

const WS = '/tmp/mission-release-column-ws';

const DEFINITIONS = [
    { id: 'feature-implementation', name: 'Feature team', headRole: 'lead', enabled: true, automatedDispatch: 'pool', members: [{ role: 'coder', count: 2 }] },
    { id: 'coding-team', name: 'Coding', headRole: 'coder', enabled: true, automatedDispatch: 'pool', members: [{ role: 'intern', count: 1 }] },
    { id: 'planning-team', name: 'Planning', headRole: 'planner', enabled: true, automatedDispatch: 'pool', members: [{ role: 'planner', count: 2 }] },
];

function card(planId, kanbanColumn, extra = {}) {
    return {
        planId, sessionId: planId, topic: planId, kanbanColumn,
        featureId: '', ownerSince: null, ownerSeat: '', columnOrder: null, completedAt: null,
        complexity: '5', ...extra,
    };
}

/**
 * The pop's harness. `performKanbanDispatch` records the COLUMN the pop passed
 * and moves the card, so successive pops advance through the member set exactly
 * as a real release does.
 */
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
    server.performKanbanDispatch = async (workspaceRoot, planId, targetColumn) => {
        dispatched.push({ planId, targetColumn });
        const row = board.find(p => p && p.planId === planId);
        if (row && targetColumn) { row.kanbanColumn = targetColumn; }
        return { status: 200, payload: { success: true, planId, moved: true, dispatched: true } };
    };
    return { server, dispatched };
}

/** A real provider, for the single-plan router (`resolveAutoDispatchColumn`). */
function makeProvider(overrides = {}) {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-m06-')));
    const memento = () => {
        const m = new Map();
        return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); }, keys: () => Array.from(m.keys()) };
    };
    const provider = new KanbanProvider({ fsPath: tmpRoot }, {
        globalState: memento(), workspaceState: memento(),
        secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
        extensionUri: { fsPath: tmpRoot }, extensionPath: tmpRoot, subscriptions: [],
    }, undefined, undefined);
    provider._hostSeams = undefined;
    provider._broadcaster = new BroadcastHub({ webview: null, apiServer: null });
    provider._currentWorkspaceRoot = tmpRoot;
    // The TaskViewerProvider seam. `resolveAutoDispatchColumn` (and the
    // `resolveRoutedRole` it calls) ask it for the visible agents and for the
    // LIVE coding roles; a MISSING method is a TypeError at the call site, not a
    // silent pass — which is how this harness first failed. An empty live-roles
    // map is the honest "no live pool to degrade against" answer, so the band is
    // decided by complexity alone, which is what this suite is asserting.
    provider.setTaskViewerProvider({
        _resolveWorkspaceRoot: () => tmpRoot,
        getVisibleAgents: async () => ({ lead: true, coder: true, intern: true }),
        getCustomAgents: async () => ({}),
        getFleetLiveness: () => [],
        getAliveCodingRolesWithTerminals: () => new Map(),
    });
    Object.assign(provider, overrides);
    return { provider, tmpRoot };
}

async function run() {
    console.log('\nmission release column contract\n');

    // ── 1. The unit rule: one plan still routes by complexity ──────────────

    await test('a single plan still routes by complexity — cx-2 to the intern, cx-7 to the lead', async () => {
        const { provider, tmpRoot } = makeProvider();
        const intern = await provider.resolveAutoDispatchColumn(tmpRoot, '2', false);
        assert.strictEqual(intern.targetColumn, 'INTERN CODED', `cx-2 alone must reach the intern: ${intern.reason}`);
        const coder = await provider.resolveAutoDispatchColumn(tmpRoot, '5', false);
        assert.strictEqual(coder.targetColumn, 'CODER CODED', `cx-5 alone must reach the coder: ${coder.reason}`);
        const lead = await provider.resolveAutoDispatchColumn(tmpRoot, '8', false);
        assert.strictEqual(lead.targetColumn, 'LEAD CODED', `cx-8 alone must reach the lead: ${lead.reason}`);
        const unknown = await provider.resolveAutoDispatchColumn(tmpRoot, 'Unknown', false);
        assert.strictEqual(unknown.targetColumn, 'LEAD CODED', 'an unscored plan waits on the lead, never on a cheap seat');
        provider.dispose();
    });

    await test('a feature still ignores complexity entirely', async () => {
        const { provider, tmpRoot } = makeProvider();
        const routed = await provider.resolveAutoDispatchColumn(tmpRoot, '2', true);
        assert.strictEqual(routed.targetColumn, 'LEAD CODED',
            `a feature is never complexity-routed, whatever its score: ${routed.reason}`);
        assert.ok(/feature/.test(routed.reason), routed.reason);
        provider.dispose();
    });

    await test('with dynamic routing off, a plan goes to the lead', async () => {
        const { provider, tmpRoot } = makeProvider();
        provider._dynamicComplexityRoutingEnabled = false;
        const routed = await provider.resolveAutoDispatchColumn(tmpRoot, '2', false);
        assert.strictEqual(routed.targetColumn, 'LEAD CODED');
        assert.ok(/routing off/.test(routed.reason), routed.reason);
        provider.dispose();
    });

    // ── 2. The mission rule: the mission owns the column ───────────────────

    await test('a Coding mission releases EVERY member into the one column its team works at', async () => {
        // Mixed complexity on purpose: under the old behaviour these three cards
        // would scatter to INTERN CODED / CODER CODED / LEAD CODED.
        const board = [
            card('m6-cx2', 'STAGING', { columnOrder: 1, complexity: '2' }),
            card('m6-cx5', 'STAGING', { columnOrder: 2, complexity: '5' }),
            card('m6-cx8', 'STAGING', { columnOrder: 3, complexity: '8' }),
        ];
        const mission = { id: 'mission-coding', team: 'coding-team', workspaceId: 'ws1', plans: ['m6-cx2', 'm6-cx5', 'm6-cx8'] };
        const { server, dispatched } = makePopServer(board, mission);
        // Coding's cadence is ONE (Mission 04): the mission releases nothing while
        // a member it already released has not asserted completion, so the next
        // release is earned by the previous card completing — not by asking twice.
        // Walking the member set therefore means completing as we go, which is
        // also the only shape that proves all THREE landed in one column rather
        // than the first one having.
        const pop = () => server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding Coder', missionId: mission.id });
        for (let i = 0; i < 3; i++) {
            const out = await pop();
            assert.strictEqual(out.status, 200, `release ${i + 1}: ${out.payload.error || ''}`);
            assert.ok(out.payload.dispatched, `release ${i + 1} must dispatch a member (${out.payload.reason || ''})`);
            if (i === 0) {
                // The cadence is real, and it is checked here rather than after the
                // loop: once every member is delivered the pop reports an empty
                // queue and never reaches the in-flight gate at all.
                const holds = await pop();
                assert.strictEqual(holds.payload.dispatched, null,
                    'Coding releases ONE: a member still out holds the next release');
                assert.ok(/in flight/.test(holds.payload.reason || ''), holds.payload.reason);
            }
            const row = board.find(p => p && p.planId === dispatched[dispatched.length - 1].planId);
            row.completedAt = new Date().toISOString();
        }
        assert.strictEqual(dispatched.length, 3, 'every member was released');
        const columns = [...new Set(dispatched.map(d => d.targetColumn))];
        assert.strictEqual(columns.length, 1,
            `a mission's members must not be re-routed card by card — got ${JSON.stringify(dispatched)}`);
        assert.strictEqual(columns[0], 'CODER CODED', "the column is the mission's team's stage column");
        assert.strictEqual(columns[0], resolveStageForHeadRole('coder').column,
            'and it is Mission 08\'s derivation, not a second mapping');
    });

    await test('a Feature-team mission releases into LEAD CODED, a Planning mission into PLAN REVIEWED', async () => {
        for (const [team, expected] of [
            ['feature-implementation', 'LEAD CODED'],
            ['planning-team', 'PLAN REVIEWED'],
        ]) {
            const board = [card(`m6-${team}`, 'STAGING', { columnOrder: 1 })];
            const mission = { id: `mission-${team}`, team, workspaceId: 'ws1', plans: [`m6-${team}`] };
            const { server, dispatched } = makePopServer(board, mission);
            const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Head', missionId: mission.id });
            assert.strictEqual(out.status, 200, out.payload.error || '');
            assert.strictEqual(dispatched[0] && dispatched[0].targetColumn, expected,
                `team '${team}' works at '${expected}'`);
            assert.strictEqual(expected, resolveStageForHeadRole(team === 'planning-team' ? 'planner' : 'lead').column);
        }
    });

    await test('a mission-scoped release names NO column for a member the auto-route could re-decide', async () => {
        // The negative half of the same rule: the pop never passes an EMPTY column
        // for a mission member, because an empty column is exactly what sends the
        // card to `resolveAutoDispatchColumn`.
        const board = [card('m6-never-auto', 'STAGING', { columnOrder: 1, complexity: '2' })];
        const mission = { id: 'mission-coding', team: 'coding-team', workspaceId: 'ws1', plans: ['m6-never-auto'] };
        const { server, dispatched } = makePopServer(board, mission);
        await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding Coder', missionId: mission.id });
        assert.strictEqual(dispatched.length, 1);
        assert.ok(dispatched[0].targetColumn && dispatched[0].targetColumn !== 'auto',
            `a mission release must pass an explicit column, got '${dispatched[0].targetColumn}'`);
        assert.notStrictEqual(dispatched[0].targetColumn, 'INTERN CODED',
            'and NOT what complexity alone would have chosen for a cx-2 card');
    });

    await test('a non-mission pop still routes by complexity — it names no column at all', async () => {
        const board = [card('m6-plain', 'STAGING', { columnOrder: 1, complexity: '2' })];
        const { server, dispatched } = makePopServer(board, null);
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Standalone' });
        assert.strictEqual(out.status, 200, out.payload.error || '');
        assert.strictEqual(dispatched.length, 1);
        assert.strictEqual(dispatched[0].targetColumn, undefined,
            'the plain queue passes no column, so the pre-delivery auto-route decides the seat — byte-for-byte today\'s behaviour');
    });

    await test('an unresolvable mission team fails loudly instead of falling back to auto-routing', async () => {
        const board = [card('m6-unplaceable', 'STAGING', { columnOrder: 1, complexity: '2' })];
        const mission = { id: 'mission-unknown', team: 'team-that-does-not-exist', workspaceId: 'ws1', plans: ['m6-unplaceable'] };
        const { server, dispatched } = makePopServer(board, mission);
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Someone', missionId: mission.id });
        assert.strictEqual(out.status, 200, out.payload.error || '');
        assert.deepStrictEqual(dispatched, [],
            'a mission nobody can place must NOT fall back to auto-routing — a silent fallback scatters the mission exactly as before, invisibly');
        assert.ok(/^held:/.test(String(out.payload.reason)), out.payload.reason);
    });

    // ── 3. Precedence: explicit column, then the mission, then auto ─────────

    await test('the escalation override still wins over the mission\'s stage column', async () => {
        // A failed release re-stages the card to a STRONGER seat and passes that
        // seat's column explicitly. The mission's column must not clobber it.
        const board = [
            card('m6-failed', 'CODER CODED', {
                columnOrder: 1, ownerSeat: 'Coding Coder', ownerSince: '2026-09-20T00:00:00Z',
                planFile: '/tmp/m6-failed.md', workspaceId: 'ws1',
            }),
        ];
        const mission = { id: 'mission-coding', team: 'coding-team', workspaceId: 'ws1', plans: ['m6-failed'] };
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
            getMissionById: async (id) => (mission.id === id ? mission : null),
            getMissionMembers: async () => (mission.plans || []).map(memberId => ({ memberId, kind: 'plan' })),
            getMissionsForMember: async (planId) => (planId === 'm6-failed' ? [mission.id] : []),
            getPlanByPlanId: async (planId) => board.find(p => p && p.planId === planId) || null,
            clearOwnerStamp: async () => true,
            updateColumnByPlanFile: async (planFile, wsId, column) => {
                const row = board.find(p => p && p.planFile === planFile);
                if (row) { row.kanbanColumn = column; }
                return true;
            },
            setColumnOrders: async () => true,
        };
        const server = new LocalApiServer({
            clickupMetadataPath: '', linearMetadataPath: '',
            getClickUpService: () => null, getLinearService: () => null, getNotionService: () => null,
            getAuthToken: async () => '',
            allRoots: [WS], workspaceRoot: WS,
            getKanbanDatabase: async () => db,
            resolveTeamMembers: async () => ['Coding', 'Coding Coder'],
            getRegisteredTerminals: () => ['Coding Coder'],
            resolveKanbanDispatch: async () => ({ role: 'coder' }),
            clearTerminalContext: async () => ({ cleared: true }),
            armQueueWatch: async () => { /* not under test */ },
        });
        server.performKanbanDispatch = async (workspaceRoot, planId, targetColumn) => {
            dispatched.push({ planId, targetColumn });
            return { status: 200, payload: { success: true, planId, moved: true, dispatched: true } };
        };

        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'Coding Coder', planId: 'm6-failed', outcome: 'failed' });
        assert.strictEqual(out.status, 200, `expected 200, got ${out.status}: ${out.payload.error || ''}`);
        assert.strictEqual(out.payload.escalated, 'restaged', `the failed card must step up a rung: ${JSON.stringify(out.payload)}`);
        assert.strictEqual(dispatched.length, 1, 'the re-staged card is dispatched to the stronger seat');
        assert.strictEqual(dispatched[0].targetColumn, 'LEAD CODED',
            "the escalation override's column wins over the mission's stage column ('CODER CODED')");
    });

    await test('an explicit column still wins over auto-routing (the drag rule is one rule)', () => {
        const api = code(fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8'));
        const i = api.indexOf('let targetColumn: string | null;');
        assert.notStrictEqual(i, -1, 'the pre-delivery resolver must exist');
        const window = api.slice(i, i + 900);
        assert.ok(/if \(!rawColumn \|\| rawColumn\.toLowerCase\(\) === 'auto'\)/.test(window),
            'auto-routing is the branch taken when NO column is named');
        assert.ok(/targetColumn = await this\._canonicalColumnId\(rawColumn, workspaceRoot\)/.test(window),
            'a named column is canonicalised and used — an operator drag and a mission release share this one precedence');
        assert.ok(!/skipAutoRoute/.test(api),
            'and there is no second switch that means the same thing — that is how the two paths drift');
    });

    // ── 4. Source-shape: one derivation, one channel ───────────────────────

    await test('the release column comes from Mission 08\'s ONE derivation, not a second mapping', () => {
        const stageSrc = code(fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'missionStage.ts'), 'utf8'));
        assert.strictEqual((stageSrc.match(/export function resolveStageForHeadRole\(/g) || []).length, 1,
            'exactly one team-head-role → stage resolver exists');
        const api = code(fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8'));
        assert.ok(/import\s*\{[^}]*\bresolveMissionStageFromTeam\b[^}]*\}\s*from\s*'\.\/missionStage'/.test(api),
            'the pop consumes the shared derivation');
        assert.ok(/missionStage \? missionStage\.column : undefined/.test(api),
            "and passes that derivation's column — not a hand-kept team→column map");
        // The pop never calls the auto-route itself: the auto-route lives behind
        // the pre-delivery resolver, which the explicit column bypasses.
        const pop = api.slice(api.indexOf('private async _runQueuePop('), api.indexOf('private async _handleKanbanQueueNext('));
        assert.ok(!/resolveAutoDispatchColumn/.test(pop),
            'a mission-scoped release must not reach the auto-route path');
        assert.ok(/overrideRole\s*\n?\s*\? roleToCodingColumn\(overrideRole\)\s*\n?\s*: \(missionStage \? missionStage\.column : undefined\)/.test(pop),
            'and the precedence is written down in one place: the escalation override first, the mission stage second, nothing otherwise');
    });

    console.log(`\n${failed === 0 ? `all ${passed} mission-release-column checks passed` : `${failed} of ${passed + failed} check(s) FAILED`}\n`);
    process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
