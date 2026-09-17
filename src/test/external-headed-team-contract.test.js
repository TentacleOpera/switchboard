'use strict';

/**
 * Verification tests for External-Headed Team Mode (Non-Terminal Agent as Team Lead).
 * Plan: feature_plan_20260818_external-headed-team-mode.md
 *
 * Tests:
 * 1. wireSpawnedTeam with externalHead: true installs no team-head scoped order.
 * 2. The callback instruction points to .switchboard/teams/<teamId>/reports/.
 * 3. The group members array excludes the head name.
 * 4. resolveTeamMembersForHead resolves the group by the external agent's name.
 * 5. resolveTeamScopedRoleTerminal finds workers by role on the external-headed team.
 * 6. dispatchNextFromQueue handles from = external agent name: skips targetTerminalOverride,
 *    moves the card to complexity-routed coding column, and returns card info (no terminal dispatch).
 *    In-flight refusal still applies.
 * 7. No dispatch path can target the external head: the callback instruction never
 *    names ptySendPrompt, and role resolution never returns the head's own name
 *    (so a worker cannot be told to dead-click at a terminal that does not exist).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    wireSpawnedTeam,
    resolveTeamMembersForHead,
    resolveTeamScopedRoleTerminal,
} = require('../../out/services/teamWiring');
const {
    STANDING_ORDER_FRAGMENT_IDS,
    getStandingOrderFragment,
} = require('../../out/services/standingOrderFragments');
const { LocalApiServer } = require('../../out/services/LocalApiServer');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (e) {
        console.error(`  FAIL ${name}`);
        console.error(`     ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e}`);
        failed++;
    }
}

const normalizeRole = (r) => (r || '')
    .toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

function makeMockDb(initialState = {}) {
    const store = new Map();
    if (initialState.standingOrders) {
        store.set('terminals.standingOrders', JSON.stringify(initialState.standingOrders));
    }
    if (initialState.groups) {
        store.set('terminals.groups', JSON.stringify(initialState.groups));
    }

    return {
        getConfigJson: async (key, defaultVal) => {
            if (store.has(key)) {
                return JSON.parse(store.get(key));
            }
            return defaultVal;
        },
        setConfigJson: async (key, val) => {
            store.set(key, JSON.stringify(val));
        },
        getRawStore: () => store,
    };
}

(async function run() {
    console.log('--- External-Headed Team Mode Contract Tests ---');

    await test('1. wireSpawnedTeam with externalHead: true installs no team-head scoped order', async () => {
        const db = makeMockDb();
        const result = await wireSpawnedTeam({
            db,
            headName: 'Antigravity-Lead',
            children: [{ friendlyName: 'Antigravity-Lead-coder-1' }, { friendlyName: 'Antigravity-Lead-coder-2' }],
            // An operator-authored team prompt is what installs the team-scoped
            // row — system protocol (incl. the head instructions) is composed
            // at delivery by selectOrders and persists no row.
            prompt: 'You lead this team. Pull next card.',
            headPrompt: 'You lead this team. Pull next card.',
            externalHead: true,
        });

        assert.ok(result.ok, 'wireSpawnedTeam should succeed');
        const orders = await db.getConfigJson('terminals.standingOrders', []);
        assert.ok(orders.length > 0, 'An authored team prompt installs the team-scoped order');
        const headOrder = orders.find(o => o.scope === 'team-head');
        assert.strictEqual(headOrder, undefined, 'No team-head scoped order should be installed for external head');
    });

    await test('2. The callback instruction points to .switchboard/teams/<teamId>/reports/', async () => {
        const headName = 'Antigravity-Lead';
        const expectedTeamId = 'team_' + encodeURIComponent(headName).replace(/[^a-zA-Z0-9_]/g, '_');

        // The callback instruction is no longer a persisted standing order —
        // wireSpawnedTeam only writes rows for operator-authored prompts now.
        // It is composed at delivery from the fragment library
        // (external-member-callback), so the contract is pinned on the
        // fragment body: it must still name the reports dir and filename
        // pattern for the spawned team's id.
        const fragment = getStandingOrderFragment(STANDING_ORDER_FRAGMENT_IDS.externalMemberCallback);
        assert.ok(fragment, 'external-member-callback fragment must exist');
        const body = typeof fragment.body === 'function'
            ? fragment.body({ teamId: expectedTeamId, headName, inTeam: true, isHead: false, externalHead: true })
            : '';
        assert.ok(
            body.includes(`.switchboard/teams/${expectedTeamId}/reports/`),
            `Callback instruction must contain reports directory path: ${body.slice(0, 200)}`
        );
        assert.ok(
            body.includes('report-<UTC-compact>-<kind>-<5 digits>.md'),
            'Callback instruction must name report filename pattern'
        );
    });

    await test('3. Group members array excludes head name for external-headed team', async () => {
        const db = makeMockDb();
        await wireSpawnedTeam({
            db,
            headName: 'ExternalLead',
            children: [{ friendlyName: 'worker-1' }, { friendlyName: 'worker-2' }],
            externalHead: true,
        });

        // The registration key is the scoped one — `terminals.groups` is the legacy
        // key readers merge in, and nothing has written it since wireSpawnedTeam existed.
        const groups = await db.getConfigJson('switchboard.prompts.terminals.groups', []);
        assert.strictEqual(groups.length, 1, 'One group should be registered');
        const group = groups[0];
        assert.strictEqual(group.name, 'ExternalLead', 'Group name should match headName');
        assert.deepStrictEqual(group.members, ['worker-1', 'worker-2'], 'members should contain only workers (no head name)');
        assert.deepStrictEqual(group.order, ['worker-1', 'worker-2'], 'order should contain only workers (no head name)');
    });

    await test('4. resolveTeamMembersForHead resolves the group by the external agent name', async () => {
        const db = makeMockDb();
        const headName = 'ExternalLead';
        await wireSpawnedTeam({
            db,
            headName,
            children: [{ friendlyName: 'worker-1' }, { friendlyName: 'worker-2' }],
            externalHead: true,
        });

        const roster = await resolveTeamMembersForHead({ db, originName: headName });
        assert.ok(roster, 'Roster should resolve for head name');
        assert.deepStrictEqual(roster, ['worker-1', 'worker-2'], 'Roster should return worker names');
    });

    await test('5. resolveTeamScopedRoleTerminal finds workers by role on the external-headed team', async () => {
        const db = makeMockDb();
        const headName = 'ExternalLead';
        await wireSpawnedTeam({
            db,
            headName,
            children: [{ friendlyName: 'ExternalLead-coder-1' }, { friendlyName: 'ExternalLead-reviewer-1' }],
            externalHead: true,
        });

        const liveTerminals = [
            { name: 'ExternalLead-coder-1', role: 'coder' },
            { name: 'ExternalLead-reviewer-1', role: 'reviewer' },
            { name: 'other-reviewer', role: 'reviewer' },
        ];

        const resolvedReviewer = await resolveTeamScopedRoleTerminal({
            db,
            originName: headName,
            role: 'reviewer',
            liveTerminals,
            normalizeRole,
        });
        assert.strictEqual(resolvedReviewer, 'ExternalLead-reviewer-1', 'Should resolve team-scoped reviewer');

        const resolvedCoder = await resolveTeamScopedRoleTerminal({
            db,
            originName: headName,
            role: 'coder',
            liveTerminals,
            normalizeRole,
        });
        assert.strictEqual(resolvedCoder, 'ExternalLead-coder-1', 'Should resolve team-scoped coder');
    });

    await test('6. dispatchNextFromQueue handles from = external agent name and never refuses', async () => {
        const WS = '/tmp/ext-team-ws';
        let planInDb = {
            planId: 'plan-123',
            sessionId: 'plan-123',
            topic: 'Build Feature',
            kanbanColumn: 'STAGING',
            featureId: '',
            ownerSeat: '',
            ownerSince: null,
            columnOrder: 1,
            complexity: 5,
        };

        // The dispatch verify reads the append-only plan_events row, not
        // owner_since — the mock kanbanVerb simulates the real arm's
        // `dispatched` event append by bumping this counter.
        let dispatchEventSeq = 0;
        const mockKanbanDb = {
            getWorkspaceId: async () => 'ws-1',
            getDominantWorkspaceId: async () => 'ws-1',
            getBoard: async () => [planInDb],
            getPlanByPlanId: async () => planInDb,
            getLatestDispatchOutcomeByPlanId: async () => dispatchEventSeq > 0
                ? { eventId: dispatchEventSeq, eventType: 'dispatched', timestamp: '', seat: '', agent: '', ide: '', error: '' }
                : null,
        };

        let lastTriggerAction = null;

        const server = new LocalApiServer({
            workspaceRoot: WS,
            clickupMetadataPath: '',
            linearMetadataPath: '',
            getClickUpService: () => null,
            getLinearService: () => null,
            getNotionService: () => null,
            getAuthToken: async () => '',
            allRoots: [WS],
            getKanbanDatabase: async () => mockKanbanDb,
            getRegisteredTerminals: () => ['worker-coder-1', 'worker-reviewer-1'],
            resolveTeamMembers: async (wsRoot, headName) => {
                if (headName === 'ExternalLead') {
                    return ['worker-coder-1', 'worker-reviewer-1'];
                }
                return null;
            },
            resolveAutoDispatchColumn: async () => ({ targetColumn: 'CODER CODED', reason: 'complexity 5' }),
            resolveKanbanDispatch: async () => ({
                role: 'coder',
                boardMoveCliTriggersEnabled: true,
                dragDropMode: 'terminal',
                source: null,
            }),
            resolveTeamRoleTerminal: async (wsRoot, origin, role) => {
                if (role === 'coder') return 'worker-coder-1';
                return null;
            },
            kanbanVerb: async (verb, payload) => {
                if (verb === 'triggerAction') {
                    lastTriggerAction = payload;
                    planInDb.kanbanColumn = payload.targetColumn;
                    planInDb.ownerSince = new Date().toISOString();
                    planInDb.ownerSeat = payload.targetTerminalOverride || 'worker-coder-1';
                    dispatchEventSeq++;
                    return { success: true };
                }
                return { success: true };
            },
        });

        // Pop for external lead
        const res = await server.dispatchNextFromQueue({
            workspaceRoot: WS,
            from: 'ExternalLead',
        });

        assert.strictEqual(res.status, 200, 'dispatchNextFromQueue should return 200');
        assert.ok(res.payload.success, 'Pop should succeed');
        assert.strictEqual(res.payload.dispatched.planId, 'plan-123', 'Dispatched card planId must match');
        assert.strictEqual(planInDb.kanbanColumn, 'CODER CODED', 'Card moved to complexity routed column');
        assert.ok(lastTriggerAction, 'triggerAction must have fired');
        assert.notStrictEqual(
            lastTriggerAction.targetTerminalOverride, 'ExternalLead',
            'targetTerminalOverride must NOT be the external head — it is not a terminal');
        assert.strictEqual(
            planInDb.ownerSeat, 'worker-coder-1',
            'The card must land on a worker of the external head\'s own team');

        // Second call while the card sits in CODER CODED: STAGING is now empty,
        // so the pop reports "queue empty" — ownership never refuses (V81).
        const secondRes = await server.dispatchNextFromQueue({
            workspaceRoot: WS,
            from: 'ExternalLead',
        });

        assert.strictEqual(secondRes.status, 200, 'the pop never refuses — a drained STAGING is a 200');
        assert.strictEqual(secondRes.payload.dispatched, null, 'nothing is staged to hand out');
    });

    await test('6b. A TERMINAL head keeps targetTerminalOverride even when the live-terminal list is stale', async () => {
        // Regression guard. The VS Code host's getRegisteredTerminals carries PTY
        // names from the LAST FLEET SNAPSHOT, not a live query — a freshly spawned
        // head is briefly absent from it. If that list can override a roster that
        // already names `from`, a real lead silently loses the override and hands
        // its own card to a coder. The roster is the authority; the live list is
        // consulted only when there is no roster resolver at all.
        const WS = '/tmp/ext-team-ws-2';
        const planInDb = {
            planId: 'plan-777', sessionId: 'plan-777', topic: 'Terminal lead card',
            kanbanColumn: 'STAGING', featureId: '', ownerSeat: '',
            ownerSince: null, columnOrder: 1, complexity: 5,
        };
        let lastTriggerAction = null;
        let dispatchEventSeq = 0;
        const server = new LocalApiServer({
            workspaceRoot: WS,
            getAuthToken: async () => '',
            allRoots: [WS],
            getKanbanDatabase: async () => ({
                getWorkspaceId: async () => 'ws-1',
                getDominantWorkspaceId: async () => 'ws-1',
                getBoard: async () => [planInDb],
                getPlanByPlanId: async () => planInDb,
                getLatestDispatchOutcomeByPlanId: async () => dispatchEventSeq > 0
                    ? { eventId: dispatchEventSeq, eventType: 'dispatched', timestamp: '', seat: '', agent: '', ide: '', error: '' }
                    : null,
            }),
            // Stale snapshot: the head terminal is live but not listed yet.
            getRegisteredTerminals: () => ['TerminalLead-coder-1'],
            resolveTeamMembers: async (_ws, headName) =>
                headName === 'TerminalLead' ? ['TerminalLead', 'TerminalLead-coder-1'] : null,
            resolveAutoDispatchColumn: async () => ({ targetColumn: 'CODER CODED', reason: 'complexity 5' }),
            resolveKanbanDispatch: async () => ({ role: 'coder', boardMoveCliTriggersEnabled: true, dragDropMode: 'terminal', source: null }),
            resolveTeamRoleTerminal: async () => 'TerminalLead-coder-1',
            kanbanVerb: async (verb, payload) => {
                if (verb === 'triggerAction') {
                    lastTriggerAction = payload;
                    planInDb.kanbanColumn = payload.targetColumn;
                    planInDb.ownerSince = new Date().toISOString();
                    planInDb.ownerSeat = payload.targetTerminalOverride || 'TerminalLead-coder-1';
                    dispatchEventSeq++;
                }
                return { success: true };
            },
        });

        const res = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'TerminalLead' });
        assert.strictEqual(res.status, 200, 'Terminal-headed pop should succeed');
        assert.strictEqual(
            lastTriggerAction.targetTerminalOverride, 'TerminalLead',
            'A terminal head must still receive its own card (the lead asked, the lead receives)');
    });

    await test('6c. External head with no seat for the routed role falls back workspace-wide, tagged', async () => {
        // V81: a role miss is no longer a refusal — the board never refuses a
        // dispatch. Team-scoped resolution falls back to workspace-wide, and the
        // miss is TAGGED in `teamRouting` so "no seat on this team" is
        // distinguishable from "resolved" (AGENTS.md: tag it, do not fail quietly).
        const WS = '/tmp/ext-team-ws-3';
        const planInDb = {
            planId: 'plan-888', sessionId: 'plan-888', topic: 'Needs a lead',
            kanbanColumn: 'STAGING', featureId: '', ownerSeat: '',
            ownerSince: null, columnOrder: 1, complexity: 9,
        };
        let triggered = false;
        let dispatchEventSeq = 0;
        const server = new LocalApiServer({
            workspaceRoot: WS,
            getAuthToken: async () => '',
            allRoots: [WS],
            getKanbanDatabase: async () => ({
                getWorkspaceId: async () => 'ws-1',
                getDominantWorkspaceId: async () => 'ws-1',
                getBoard: async () => [planInDb],
                getPlanByPlanId: async () => planInDb,
                getLatestDispatchOutcomeByPlanId: async () => dispatchEventSeq > 0
                    ? { eventId: dispatchEventSeq, eventType: 'dispatched', timestamp: '', seat: '', agent: '', ide: '', error: '' }
                    : null,
            }),
            getRegisteredTerminals: () => ['ExternalLead-coder-1'],
            resolveTeamMembers: async (_ws, headName) =>
                headName === 'ExternalLead' ? ['ExternalLead-coder-1'] : null,
            resolveAutoDispatchColumn: async () => ({ targetColumn: 'LEAD CODED', reason: 'complexity 9' }),
            resolveKanbanDispatch: async () => ({ role: 'lead', boardMoveCliTriggersEnabled: true, dragDropMode: 'terminal', source: null }),
            // No `lead` seat on this team.
            resolveTeamRoleTerminal: async (_ws, _origin, role) => (role === 'lead' ? null : 'ExternalLead-coder-1'),
            kanbanVerb: async (verb, payload) => {
                if (verb === 'triggerAction') {
                    triggered = true;
                    planInDb.kanbanColumn = payload.targetColumn;
                    planInDb.ownerSince = new Date().toISOString();
                    planInDb.ownerSeat = payload.targetTerminalOverride || 'workspace-lead';
                    dispatchEventSeq++;
                }
                return { success: true };
            },
        });

        const res = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'ExternalLead' });
        assert.strictEqual(res.status, 200, 'a role miss is a tagged fallback, not a refusal');
        assert.strictEqual(triggered, true, 'the card is dispatched');
        assert.strictEqual(planInDb.kanbanColumn, 'LEAD CODED', 'the card moves to the routed column');
        const routing = String(res.payload.teamRouting || res.payload.dispatched?.teamRouting || '');
        assert.ok(/fell back to workspace-wide/.test(routing),
            `the workspace-wide fallback must be tagged in teamRouting (got: ${routing})`);
    });

    await test('7. No dispatch path can target the external head', async () => {
        // The external-member-callback fragment body must never name ptySendPrompt:
        // a worker that is told to report to a terminal which does not exist
        // gets a dead click (both hosts answer `No such terminal: <name>`), and
        // the report is lost. The fragment is composed at delivery from the
        // fragment library — the body is an inline function in
        // STANDING_ORDER_FRAGMENTS.
        const extCallbackFragment = getStandingOrderFragment(STANDING_ORDER_FRAGMENT_IDS.externalMemberCallback);
        assert.ok(extCallbackFragment, 'external-member-callback fragment must exist in the fragment library');
        const sampleBody = typeof extCallbackFragment.body === 'function'
            ? extCallbackFragment.body({ teamId: 'team_test', headName: 'ExternalLead', inTeam: true, isHead: false, externalHead: true } )
            : '';
        assert.ok(
            !/ptySendPrompt/i.test(sampleBody),
            'External-head callback fragment body must not route reports through ptySendPrompt');

        // And role resolution must never hand back the head's own name, even when a
        // live terminal happens to carry it — the roster is what resolvers read.
        const db = makeMockDb();
        const headName = 'ExternalLead';
        await wireSpawnedTeam({
            db,
            headName,
            children: [{ friendlyName: 'ExternalLead-coder-1' }],
            externalHead: true,
        });
        const liveTerminals = [
            { name: 'ExternalLead', role: 'lead' },
            { name: 'ExternalLead-coder-1', role: 'coder' },
        ];
        for (const role of ['lead', 'coder', 'reviewer']) {
            const hit = await resolveTeamScopedRoleTerminal({
                db, originName: headName, role, liveTerminals, normalizeRole,
            });
            assert.notStrictEqual(hit, headName, `role '${role}' must never resolve to the external head`);
        }
    });

    // 8. The generated head-prompt.md is a team-head standing order like any
    // other, so it carries the same card-movement rules as the terminal Coding
    // head. It used to say "Advancing & Review" and "advance cards" — the exact
    // wording that taught leads to move cards backwards through the pipeline.
    // Source-level: the file is a template literal, so pin the generator.
    await test('8. writeHeadPromptFile carries the card-movement rules and no "advance" language', async () => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'services', 'agentGroupInstantiation.ts'), 'utf8');
        const start = src.indexOf('export async function writeHeadPromptFile');
        assert.ok(start !== -1, 'writeHeadPromptFile not found in agentGroupInstantiation.ts');
        const body = src.slice(start, src.indexOf('writeFile(filePath', start));
        assert.ok(body.includes('Never move a card backwards to an earlier pipeline stage'),
            'the external head prompt must prohibit backwards movement');
        assert.ok(/[Yy]our ONLY card action is the POST \/kanban\/dispatch/.test(body),
            'the external head prompt must name /kanban/dispatch as the one permitted card action');
        // The prompt now PROHIBITS advancing ("You do not advance any card.",
        // "Advancing a card you were not given a reviewer for puts it in a
        // column no one is watching") — so the pin is the old imperative
        // phrase, not the word itself.
        assert.ok(!/\badvance cards\b|\bAdvancing & Review\b/.test(body),
            'the external head prompt must not instruct the head to "advance cards"');
    });

    console.log(`\nExternal-Headed Team contract tests: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
})();
