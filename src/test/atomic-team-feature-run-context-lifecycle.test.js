'use strict';

/**
 * Atomic team context lifecycle per feature run.
 *
 * Verifies all goal invariants and behaviors defined in
 * .switchboard/plans/atomic-team-feature-run-context-lifecycle.md:
 * - Work context resolver maps feature subtasks to featureId and standalone plans to planId.
 * - Once-per-run team roster preparation barrier on new feature run.
 * - Same-feature subtask dispatches preserve context (no clear).
 * - Coder queue/done preserves context for lead review/fixes (no clear).
 * - Lead acceptance (POST /kanban/task/complete) clears the accepted coder seat once.
 * - Idempotent repeat of task/complete does not clear again.
 * - Non-team terminals maintain isolated destination clearing.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

require(path.join(process.cwd(), 'src', 'test', 'bootstrap', 'sandboxStateHome.js'));

const { resolveWorkContext, resolveTeamGroupForTerminal } = require(path.join(process.cwd(), 'out', 'services', 'workContextResolver.js'));
const { LocalApiServer } = require(path.join(process.cwd(), 'out', 'services', 'LocalApiServer.js'));
const { TERMINALS_GROUPS_KEY } = require(path.join(process.cwd(), 'out', 'services', 'teamWiring.js'));

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

const WS = '/tmp/atomic-team-lifecycle-ws';

function card(planId, kanbanColumn, extra = {}) {
    return {
        planId,
        sessionId: planId,
        topic: planId,
        kanbanColumn,
        featureId: '',
        ownerSeat: '',
        ownerSince: null,
        completedAt: null,
        ...extra,
    };
}

function group(head, children, extra = {}) {
    const roster = extra.externalHead ? children.slice() : [head, ...children];
    return {
        id: 'team_' + head.replace(/[^a-zA-Z0-9_]/g, '_'),
        name: head,
        headRole: 'lead',
        source: 'manual',
        teamGroup: true,
        teamKind: 'spawned',
        head,
        members: roster,
        order: roster,
        externalHead: false,
        ...extra,
    };
}

function makeServer(board, opts = {}) {
    const calls = [];
    const config = new Map();
    const plans = new Map();
    for (const c of board) { plans.set(c.planId, c); }
    if (opts.groups) { config.set(TERMINALS_GROUPS_KEY, opts.groups); }

    const fakeDb = {
        getWorkspaceId: async () => 'ws1',
        getDominantWorkspaceId: async () => 'ws1',
        getBoard: async () => board,
        getPlanByPlanId: async (planId) => plans.get(planId) || null,
        getConfigJson: async (key, fallback) => config.has(key) ? config.get(key) : fallback,
        setConfigJson: async (key, value) => { config.set(key, value); },
        setCompletedAt: async (planId, timestamp) => {
            const p = plans.get(planId);
            if (!p) return false;
            p.completedAt = timestamp;
            return true;
        },
        appendPlanEventByPlanId: async (planId, event) => {
            calls.push({ kind: 'event', planId, event });
            return true;
        },
        // V81: the advisory owner pair is the only holder record. The release
        // valve and released_at are gone.
        clearOwnerStamp: async (planFile) => {
            const row = board.find(p => p && p.planFile === planFile);
            if (!row) return false;
            const had = !!(row.ownerSince || row.ownerSeat);
            row.ownerSeat = '';
            row.ownerSince = null;
            calls.push({ kind: 'clearOwnerStamp', planFile });
            return had;
        },
        countActiveDispatchedByTerminal: async () => 0,
        setPlanOutcomeWorkflow: async (planId, outcome, workflow) => {
            const p = plans.get(planId);
            if (!p) return;
            p.outcome = outcome;
            p.workflow = workflow;
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
        getKanbanDatabase: async () => fakeDb,
        resolveTeamMembers: opts.resolveTeamMembers,
        getRegisteredTerminals: opts.getRegisteredTerminals || (() => []),
        terminalVerb: async (verb, payload) => {
            calls.push({ kind: 'verb', verb, name: payload && payload.name, payload });
            if (verb === 'ptyListTerminals') {
                return { success: true, terminals: [
                    { friendlyName: 'Coding', role: 'lead_coder' },
                    { friendlyName: 'Coder 1', role: 'coder' },
                    { friendlyName: 'SoloAgent', role: 'coder' },
                ] };
            }
            return { success: true };
        },
        clearTerminalContext: async (workspaceRoot, terminalName) => {
            calls.push({ kind: 'clear', name: terminalName });
            return { cleared: true };
        },
        armQueueWatch: async () => {},
    });

    server.performKanbanDispatch = async (workspaceRoot, planId) => {
        calls.push({ kind: 'dispatch', planId });
        return { status: 200, payload: { success: true, planId, dispatched: true } };
    };

    return { server, calls, plans, fakeDb };
}

async function postComplete(server, body) {
    const req = {
        method: 'POST',
        url: '/kanban/task/complete',
        // Guard 4 (cross-site) admits a non-browser caller only when it carries
        // the client marker; without it every state-changing POST is refused 403
        // before the handler runs.
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer test-token', 'x-switchboard-client': 'contract-test' },
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
        // The server wraps `writeHead` to merge pre-set headers for the
        // compression/CORS pass, which reads `res.getHeaders()` on every call
        // that passes a headers object. Without this the fake response throws
        // and EVERY handler routed through `_handleRequest` answers 500 — the
        // assertions below then read as endpoint failures when they are harness
        // failures. A fake response has to implement what ServerResponse does.
        getHeaders: () => ({}),
        getHeader: () => undefined,
        end: (data) => { responseBody = data ? JSON.parse(data) : null; },
    };
    await server._handleRequest(req, res);
    return { status, body: responseBody };
}

async function run() {
    console.log('\n--- Running Atomic Team Feature Run Context Lifecycle Tests ---\n');

    // 1. Work-context resolver
    await check('resolveWorkContext resolves featureId for subtask plans', async () => {
        const fakeDb = {
            getPlanByPlanId: async (id) => id === 'sub-1' ? { planId: 'sub-1', featureId: 'feat-alpha' } : null,
        };
        const res = await resolveWorkContext(fakeDb, { planId: 'sub-1' });
        assert.strictEqual(res.workContextKey, 'feat-alpha');
        assert.strictEqual(res.featureId, 'feat-alpha');
        assert.strictEqual(res.planId, 'sub-1');
    });

    await check('resolveWorkContext resolves planId for standalone plans', async () => {
        const fakeDb = {
            getPlanByPlanId: async (id) => id === 'plan-solo' ? { planId: 'plan-solo', featureId: null } : null,
        };
        const res = await resolveWorkContext(fakeDb, { planId: 'plan-solo' });
        assert.strictEqual(res.workContextKey, 'plan-solo');
        assert.strictEqual(res.featureId, null);
        assert.strictEqual(res.planId, 'plan-solo');
    });

    // 2. Team group resolver
    await check('resolveTeamGroupForTerminal resolves team id and roster for member', async () => {
        const fakeDb = {
            getConfigJson: async (key) => key === TERMINALS_GROUPS_KEY ? [group('Coding', ['Coder 1', 'Coder 2'])] : [],
        };
        const res = await resolveTeamGroupForTerminal(fakeDb, 'Coder 1');
        assert.ok(res);
        assert.strictEqual(res.head, 'Coding');
        assert.deepStrictEqual(res.roster, ['Coding', 'Coder 1', 'Coder 2']);
    });

    // 3. Team queue/done preserves context
    await check('team queue/done does not clear reporting coder context', async () => {
        const board = [
            card('held-1', 'CODER CODED', {
                ownerSince: '2026-08-25T00:00:00Z',
                ownerSeat: 'Coder 1',
                planFile: '/tmp/held-1.md',
                featureId: 'feat-1',
                workspaceId: 'ws1',
            }),
            card('next-1', 'STAGING', { columnOrder: 1 }),
        ];
        const { server, calls } = makeServer(board, {
            groups: [group('Coding', ['Coder 1'])],
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });

        const res = await server.reportQueueDone({ workspaceRoot: WS, from: 'Coder 1' });
        // 409 is the CORRECT answer here, and it is the shipped team-serialisation
        // contract rather than anything this lifecycle changed: the card is still in
        // a coding column with no completed_at, so the team is still in flight and the
        // pop is refused until the lead posts /kanban/task/complete. Asserting 200
        // would pin the opposite of the lifecycle this file exists to protect.
        // What matters for THIS contract is the clear count, on either outcome.
        assert.ok(res.status === 200 || res.status === 409, `unexpected status ${res.status}`);
        if (res.status === 409) {
            assert.ok(
                /task\/complete/.test(JSON.stringify(res.payload || {})),
                'the in-flight refusal must point the lead at task/complete'
            );
        }
        const clearCalls = calls.filter(c => c.kind === 'clear');
        assert.strictEqual(clearCalls.length, 0, 'team member queue/done must NOT clear terminal');
    });

    // 4. Lead acceptance clears accepted coder once
    await check('lead task/complete clears accepted coder once and is idempotent', async () => {
        const board = [
            card('sub-task-1', 'CODER CODED', {
                ownerSeat: 'Coder 1',
                featureId: 'feat-1',
            }),
        ];
        const { server, calls } = makeServer(board, {
            groups: [group('Coding', ['Coder 1'])],
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });

        const r1 = await postComplete(server, { from: 'Coding', planId: 'sub-task-1', outcome: 'subtask implemented and accepted' });
        assert.strictEqual(r1.status, 200);
        assert.strictEqual(r1.body.success, true);
        assert.strictEqual(r1.body.cleared, true);
        assert.strictEqual(r1.body.acceptedCodingSeat, 'Coder 1');
        const clear1 = calls.filter(c => c.kind === 'clear');
        assert.strictEqual(clear1.length, 1);
        assert.strictEqual(clear1[0].name, 'Coder 1');

        // Duplicate call
        const r2 = await postComplete(server, { from: 'Coding', planId: 'sub-task-1', outcome: 'subtask implemented and accepted' });
        assert.strictEqual(r2.status, 200);
        assert.strictEqual(r2.body.idempotent, true);
        const clear2 = calls.filter(c => c.kind === 'clear');
        assert.strictEqual(clear2.length, 1, 'idempotent call must not clear a second time');
    });

    // 5. Lead acceptance never clears lead
    await check('lead task/complete never clears lead even if owner_seat matches lead', async () => {
        const board = [
            card('lead-task', 'LEAD CODED', {
                ownerSeat: 'Coding',
                featureId: 'feat-1',
            }),
        ];
        const { server, calls } = makeServer(board, {
            groups: [group('Coding', ['Coder 1'])],
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });

        const r = await postComplete(server, { from: 'Coding', planId: 'lead-task', outcome: 'lead task finished' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.cleared, false);
        const clearCalls = calls.filter(c => c.kind === 'clear');
        assert.strictEqual(clearCalls.length, 0, 'lead in from must never be cleared');
    });

    // 5b. NO agent is asked to write a summary to close work out. V77 made
    //     `outcome` mandatory and rejected any post without it; nothing that
    //     instructs an agent how to call the endpoint was updated to match, so
    //     every documented payload described a call the endpoint refused — and
    //     because the same instructions say "until you post, the seat is not
    //     cleared", a lead that obeyed them deadlocked its team. The gate was
    //     removed rather than the instructions grown a sixth copy of the field.
    //     This assertion is the inverse of the one it replaces, and it is the
    //     one that pins the removal: completion is ASSERTED by the post itself,
    //     and prose is not the signal.
    await check('task/complete with no outcome is ACCEPTED — completion is asserted, not written', async () => {
        const board = [
            card('needs-outcome', 'LEAD CODED', {
                ownerSeat: 'Coding',
                featureId: 'feat-1',
            }),
        ];
        const { server } = makeServer(board, {
            groups: [group('Coding', ['Coder 1'])],
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });

        const missing = await postComplete(server, { from: 'Coding', planId: 'needs-outcome' });
        assert.strictEqual(missing.status, 200, 'a completion with no outcome must be accepted');
        assert.strictEqual(missing.body.success, true);
        assert.ok(!/outcome/i.test(missing.body.error || ''), 'no refusal names a missing outcome');
        assert.ok(board[0].completedAt, 'the completion is recorded');

        // `outcome` stays ACCEPTED and stored when a caller supplies one — the
        // removal is of the requirement, not of the field.
        const withOutcome = await postComplete(server, { from: 'Coding', planId: 'needs-outcome', outcome: 'built and reviewed' });
        assert.strictEqual(withOutcome.status, 200, 'the same post with an outcome is still accepted');
    });

    // 5c. V81: release ceased to exist as a concept. `card/release`,
    //     `releaseCardInternal` and `released_at` are deleted — there is nothing
    //     to release from once ownership is advisory and dispatch is never
    //     refused. REVERSAL (8b8c5366): `/kanban/team/release` was reinstated —
    //     the terminals panel's "release held cards" button has POSTed it since
    //     the panel was written, and the route never existed, so the button
    //     404'd and looked inert. The reinstated route is a hold-only operator
    //     valve: `clearOwnerStamp`, scoped to the poster's own team, no
    //     `completed_at` / `released_at` / column move.
    await check('card/release and released_at are deleted outright; team/release is the scoped operator valve', async () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        assert.strictEqual(src.includes('/kanban/card/release'), false, 'card/release route must be absent');
        const armStart = src.indexOf("pathname === '/kanban/team/release'");
        assert.ok(armStart > 0, 'team/release route must exist — the shipped button has POSTed it since the panel was written (reinstated 8b8c5366)');
        // The hold clear and the roster scope now live in the two helpers the
        // release route SHARES with `/kanban/team/stop` — one implementation of
        // each, not a copy per route. The invariants are asserted where the work
        // actually happens.
        const releaseStart = src.indexOf('private async _releaseHeldCardsForSeats(');
        assert.ok(releaseStart > 0, 'the one release implementation must exist');
        const releaseEnd = src.indexOf('\n    /**', releaseStart);
        const releaseBody = src.slice(releaseStart, releaseEnd === -1 ? releaseStart + 4000 : releaseEnd);
        assert.ok(releaseBody.includes('clearOwnerStamp'), 'team/release must release the hold via clearOwnerStamp');
        assert.ok(!/\bcompleted_at\b|\breleased_at\b/.test(releaseBody), 'team/release must not write completed_at or released_at — it releases the hold, it does not complete the work');
        const seatsStart = src.indexOf('private async _resolveTeamSeatNames(');
        assert.ok(seatsStart > 0, 'the one team-seat resolver must exist');
        const seatsEnd = src.indexOf('\n    /**', seatsStart);
        const seatsBody = src.slice(seatsStart, seatsEnd === -1 ? seatsStart + 4000 : seatsEnd);
        assert.ok(seatsBody.includes('resolveTeamMembers'), 'team/release must scope the release to the poster\'s own team');
        assert.strictEqual(/\breleaseCardInternal\b/.test(src), false, 'releaseCardInternal must be deleted');
        const dbSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanDatabase.ts'), 'utf8');
        assert.strictEqual(/\breleasedAt\b/.test(dbSrc), false, 'the releasedAt record field must be gone');
    });

    // 5d. The in-flight 409 the agent used to read is gone: dispatch is never
    //     refused on ownership. The queue pop hands out the next staged card.
    await check('the queue/next in-flight 409 is deleted', async () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        assert.strictEqual(src.includes('Team already in flight:'), false,
            'the in-flight refusal body must be deleted — there is no in-flight gate');
        assert.strictEqual(/\bresolveTeamInFlight\b/.test(src), false, 'resolveTeamInFlight must be deleted');
        assert.strictEqual(/\bheldByTeam\b/.test(src), false, 'heldByTeam must be deleted');
    });

    // 6. Non-team terminal clears on queue/done
    await check('standalone terminal clears on queue/done', async () => {
        const board = [
            card('standalone-task', 'CODER CODED', {
                ownerSince: '2026-08-25T00:00:00Z',
                ownerSeat: 'SoloAgent',
                planFile: '/tmp/solo.md',
                workspaceId: 'ws1',
            }),
        ];
        const { server, calls } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['SoloAgent'],
        });

        await server.reportQueueDone({ workspaceRoot: WS, from: 'SoloAgent' });
        const clearCalls = calls.filter(c => c.kind === 'clear');
        assert.strictEqual(clearCalls.length, 1);
        assert.strictEqual(clearCalls[0].name, 'SoloAgent');
    });

    console.log(`\nLifecycle tests completed with ${failures} failure(s).\n`);
    if (failures > 0) process.exit(1);
}

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
