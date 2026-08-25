'use strict';

/**
 * Lead-Paced Pipeline — the behavioural contract of the queue pop, the queue
 * stall watch, and remote queue intake.
 *
 * The feature's plans named a dozen unit tests across subtasks 1, 2, 3 and 7.
 * None were written, and the gap was not theoretical: an interim
 * "fall back to PLAN REVIEWED" branch that subtask 1 documented as temporary
 * ("until subtask 2 lands") survived into the delivered feature, where it turns
 * an empty session queue into an unattended drain of the whole PLAN REVIEWED
 * lane. Every other gate stayed green.
 *
 * These are real behavioural assertions against the shipped modules
 * (`out/services/*.js`), not source-text regexes: `LocalApiServer` and
 * `PlanIngestionEngine` are both host-agnostic by construction (PRD contract
 * #3), so they can be driven with stub seams and no `vscode`.
 */

const assert = require('assert');
const path = require('path');

require(path.join(process.cwd(), 'src', 'test', 'bootstrap', 'sandboxStateHome.js'));

const { LocalApiServer } = require(path.join(process.cwd(), 'out', 'services', 'LocalApiServer.js'));
const { applyStandingOrders } = require(path.join(process.cwd(), 'out', 'services', 'standingOrders.js'));

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

const WS = '/tmp/queue-pipeline-contract-ws';

/** A board row shaped the way `getBoard` returns them. */
function card(planId, kanbanColumn, extra = {}) {
    return {
        planId,
        sessionId: planId,
        topic: planId,
        kanbanColumn,
        featureId: '',
        dispatchedAt: null,
        dispatchedTerminal: '',
        queuePosition: null,
        completedAt: null,
        ...extra,
    };
}

/**
 * A LocalApiServer wired with just enough seams for `dispatchNextFromQueue`.
 * `dispatched` records every planId the pop actually sent, which is the only
 * thing worth asserting — the pop's contract is "which card, if any".
 */
function makeServer(board, opts = {}) {
    const dispatched = [];
    const dispatchOptions = [];
    const config = new Map();
    const server = new LocalApiServer({
        clickupMetadataPath: '',
        linearMetadataPath: '',
        getClickUpService: () => null,
        getLinearService: () => null,
        getNotionService: () => null,
        getAuthToken: async () => '',
        allRoots: [WS],
        workspaceRoot: WS,
        getKanbanDatabase: async () => ({
            getWorkspaceId: async () => 'ws1',
            getDominantWorkspaceId: async () => 'ws1',
            getBoard: async () => board,
            getConfigJson: async (key, fallback) => config.has(key) ? config.get(key) : fallback,
            setConfigJson: async (key, value) => { config.set(key, value); },
            ...(opts.db || {}),
        }),
        resolveTeamMembers: opts.resolveTeamMembers,
        resolveTeamPacing: opts.resolveTeamPacing,
        getRegisteredTerminals: opts.getRegisteredTerminals,
        getFleetOrdersDatabase: opts.getFleetOrdersDatabase,
        onWorkingStateCleared: opts.onWorkingStateCleared,
        onTurnEndNotify: opts.onTurnEndNotify,
        armQueueWatch: opts.armQueueWatch || (async () => { /* recorded separately where it matters */ }),
    });
    // Stub the dispatch machinery: this contract is about SELECTION and
    // REFUSAL, not about what performKanbanDispatch does with the card.
    server.performKanbanDispatch = async (workspaceRoot, planId, targetColumn, options) => {
        dispatched.push(planId);
        dispatchOptions.push({ targetColumn, options });
        return { status: 200, payload: { success: true, planId, moved: true, dispatched: true } };
    };
    return { server, dispatched, dispatchOptions };
}

async function run() {
    console.log('\nqueue-pipeline contract\n');

    // ── Subtask 1: the queue source ────────────────────────────────────────

    await check('the queue is STAGING — an empty queue does NOT drain PLAN REVIEWED', async () => {
        const board = [
            card('pr-1', 'PLAN REVIEWED'),
            card('pr-2', 'PLAN REVIEWED'),
        ];
        const { server, dispatched } = makeServer(board);
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200, 'an empty queue is not an error');
        assert.strictEqual(out.payload.dispatched, null,
            'an empty STAGING queue must report dispatched: null — the interim PLAN REVIEWED fallback would drain the whole lane unattended');
        assert.deepStrictEqual(dispatched, [], 'nothing may be dispatched from an empty queue');
    });

    await check('the pop takes the lowest queue_position, NULLs last', async () => {
        const board = [
            card('c', 'STAGING', { queuePosition: null }),
            card('b', 'STAGING', { queuePosition: 7 }),
            card('a', 'STAGING', { queuePosition: 2 }),
        ];
        const { server, dispatched } = makeServer(board);
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatched, ['a'], 'queue_position 2 must beat 7 and beat NULL');
    });

    await check('subtasks and already-dispatched cards are excluded from the queue', async () => {
        const board = [
            card('sub', 'STAGING', { featureId: 'feat-1', queuePosition: 1 }),
            card('gone', 'STAGING', { dispatchedAt: '2026-08-18T00:00:00Z', queuePosition: 2 }),
            card('real', 'STAGING', { queuePosition: 3 }),
        ];
        const { server, dispatched } = makeServer(board);
        await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.deepStrictEqual(dispatched, ['real'],
            'a subtask (non-empty featureId) and a card already carrying dispatchedAt must both be skipped');
    });

    // ── Subtask 1: the in-flight predicate (the deadlock regression) ───────

    await check('seat pacing ignores resting coded cards and routes the next queued card', async () => {
        // Post anchor plan: the seat-pacing skip is deleted. A resting coded
        // card must have completedAt set to release the team — completion is
        // asserted, not inferred from column position.
        const board = [
            card('resting', 'INTERN CODED', { dispatchedTerminal: 'Intern 1', dispatchedAt: null, completedAt: '2026-08-24T12:00:00Z' }),
            card('next', 'STAGING', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Intern 1'],
            resolveTeamPacing: async () => 'seat',
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatched, ['next']);
    });

    await check('a card in any column with completed_at set releases the team', async () => {
        const board = [
            card('done', 'CODE REVIEWED', { dispatchedAt: '2026-08-18T00:00:00Z', dispatchedTerminal: 'Coder 1', completedAt: '2026-08-24T12:00:00Z' }),
            card('next', 'STAGING', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200, `expected the next card, got ${out.status}: ${out.payload.error || ''}`);
        assert.deepStrictEqual(dispatched, ['next']);
    });

    await check('a card in any column held by a team member with completed_at NULL refuses the pop with 409', async () => {
        const board = [
            card('wip', 'CODE REVIEWED', { dispatchedTerminal: 'Coder 1', completedAt: null }),
            card('next', 'STAGING', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 409, 'a card in any column without completed_at is in flight');
        assert.deepStrictEqual(dispatched, [], 'a refused pop dispatches nothing and consumes no queue position');
    });

    await check('a team holding a card in a coding column with completed_at NULL is refused with 409', async () => {
        const board = [
            card('wip', 'CODER CODED', { dispatchedTerminal: 'Coder 1', completedAt: null }),
            card('next', 'STAGING', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 409, 'a team with a card in a coding column is in flight');
        assert.deepStrictEqual(dispatched, [], 'a refused pop dispatches nothing and consumes no queue position');
    });

    await check('in-flight is derived from holder and completion, not from column position or dispatchedAt', async () => {
        // A POST /kanban/queue/done clears dispatchedAt (clearWorkingState) and
        // the staleness sweep clears it too. Neither may make an actively
        // held card look free if completed_at is NULL.
        const board = [
            card('wip', 'INTERN CODED', { dispatchedTerminal: 'Coder 1', dispatchedAt: null, completedAt: null }),
            card('next', 'STAGING', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 409, 'a cleared dispatchedAt must not release the in-flight flag if completedAt is null');
        assert.deepStrictEqual(dispatched, []);
    });

    await check("another team's coding card does not block this team", async () => {
        const board = [
            card('theirs', 'CODER CODED', { dispatchedTerminal: 'Other Coder' }),
            card('next', 'STAGING', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatched, ['next']);
    });

    await check("a `from` that is not a live terminal is a 400", async () => {
        const board = [card('next', 'STAGING', { queuePosition: 1 })];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['OtherTerminal'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Ghost' });
        assert.strictEqual(out.status, 400, 'a `from` that is not a live terminal must not dispatch');
        assert.deepStrictEqual(dispatched, []);
    });

    await check("a live `from` not on any team dispatches via workspace-wide routing", async () => {
        const board = [card('next', 'STAGING', { queuePosition: 1 })];
        const { server, dispatched, dispatchOptions } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['StandaloneCoder'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'StandaloneCoder' });
        assert.strictEqual(out.status, 200, 'a live terminal not on a team should dispatch via workspace-wide routing');
        assert.deepStrictEqual(dispatched, ['next']);
        assert.deepStrictEqual(dispatchOptions[0].options, { originTerminal: 'StandaloneCoder' },
            'non-team dispatch must not force the requesting terminal or restrict routing to a team');
    });

    await check('non-team dispatch skips the team in-flight refusal', async () => {
        const board = [
            card('wip', 'CODER CODED', { dispatchedTerminal: 'StandaloneCoder' }),
            card('next', 'STAGING', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['StandaloneCoder'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'StandaloneCoder' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatched, ['next']);
    });

    await check('a single-head team keeps head-scoped routing', async () => {
        const board = [card('next', 'STAGING', { queuePosition: 1 })];
        const { server, dispatchOptions } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatchOptions[0].options, {
            originTerminal: 'Coding',
            targetTerminalOverride: 'Coding',
        });
    });

    await check('non-team completion clears its held card and pops the next card', async () => {
        const held = card('held', 'CODER CODED', {
            dispatchedAt: '2026-08-20T00:00:00Z',
            dispatchedTerminal: 'StandaloneCoder',
            planFile: '/tmp/held.md',
            workspaceId: 'ws1',
        });
        const board = [held, card('next', 'STAGING', { queuePosition: 1 })];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['StandaloneCoder'],
            db: {
                clearWorkingState: async () => { held.dispatchedAt = null; return true; },
            },
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'StandaloneCoder', planId: 'held' });
        assert.strictEqual(out.status, 200);
        assert.strictEqual(out.payload.released, 'held');
        assert.deepStrictEqual(dispatched, ['next']);
    });

    await check('_runQueueDone fires onTurnEndNotify and onWorkingStateCleared when clearWorkingState transitions', async () => {
        // The API completion path must fire the same turn-end / working-state
        // callbacks the file-watcher path fires, gated on the SAME
        // `transitioned` boolean — a watcher-first clear returns false and
        // must NOT reach the callbacks (verified by the duplicate case below).
        const held = card('held-cb', 'CODER CODED', {
            dispatchedAt: '2026-08-20T00:00:00Z',
            dispatchedTerminal: 'StandaloneCoder',
            planFile: '/tmp/held-cb.md',
            workspaceId: 'ws1',
        });
        const board = [held, card('next-cb', 'STAGING', { queuePosition: 1 })];
        const clearedCalls = [];
        const notifyCalls = [];
        const { server } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['StandaloneCoder'],
            onWorkingStateCleared: (record, workspaceRoot) => { clearedCalls.push({ record, workspaceRoot }); },
            onTurnEndNotify: (info) => { notifyCalls.push(info); },
            db: {
                clearWorkingState: async () => { held.dispatchedAt = null; return true; },
            },
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'StandaloneCoder', planId: 'held-cb' });
        assert.strictEqual(out.status, 200, `expected 200, got ${out.status}: ${out.payload.error || ''}`);
        assert.strictEqual(clearedCalls.length, 1, 'onWorkingStateCleared must fire exactly once on a real transition');
        assert.strictEqual(clearedCalls[0].workspaceRoot, WS, 'onWorkingStateCleared must receive the workspaceRoot');
        assert.strictEqual(clearedCalls[0].record.planId, 'held-cb', 'onWorkingStateCleared must receive the pre-clear held record');
        assert.strictEqual(notifyCalls.length, 1, 'onTurnEndNotify must fire exactly once on a real transition');
        assert.strictEqual(notifyCalls[0].seatName, 'StandaloneCoder', 'onTurnEndNotify must name the finishing seat');
        assert.strictEqual(notifyCalls[0].planFile, '/tmp/held-cb.md', 'onTurnEndNotify must carry the held plan file');
        assert.strictEqual(notifyCalls[0].outcome, 'completed', 'onTurnEndNotify must report outcome completed');
        assert.strictEqual(notifyCalls[0].workspaceRoot, WS, 'onTurnEndNotify must carry the workspaceRoot');
    });

    await check('_runQueueDone does NOT fire callbacks when clearWorkingState returns false (watcher-first)', async () => {
        // A duplicate report or a watcher-first clear makes clearWorkingState
        // return false (no non-NULL→NULL transition). The callbacks must NOT
        // fire — the single-fire contract is the `transitioned` boolean.
        const held = card('held-dup', 'CODER CODED', {
            dispatchedAt: '2026-08-20T00:00:00Z',
            dispatchedTerminal: 'StandaloneCoder',
            planFile: '/tmp/held-dup.md',
            workspaceId: 'ws1',
        });
        const board = [held, card('next-dup', 'STAGING', { queuePosition: 1 })];
        const clearedCalls = [];
        const notifyCalls = [];
        const { server } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['StandaloneCoder'],
            onWorkingStateCleared: () => { clearedCalls.push('fired'); },
            onTurnEndNotify: () => { notifyCalls.push('fired'); },
            db: {
                clearWorkingState: async () => false,
            },
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'StandaloneCoder', planId: 'held-dup' });
        assert.strictEqual(out.status, 200);
        assert.strictEqual(out.payload.cleared, false, 'a no-transition report must report cleared: false');
        assert.deepStrictEqual(clearedCalls, [], 'onWorkingStateCleared must NOT fire on a no-transition (duplicate) report');
        assert.deepStrictEqual(notifyCalls, [], 'onTurnEndNotify must NOT fire on a no-transition (duplicate) report');
    });

    await check('_runQueueDone does NOT fire the completion callbacks on outcome: failed', async () => {
        // A `failed` report releases the latch and runs the escalation ladder —
        // it is NOT a completion. Firing the callbacks would tell the lead the
        // seat "finished its turn" and mirror a `kind: finished` Mission Control
        // report for work that failed, so the lead accepts and advances a card
        // nobody completed. The standing orders explicitly instruct a seat that
        // cannot finish to call THIS endpoint with {"outcome":"failed"}, so this
        // path is reached by design, not by malformed input.
        const held = card('held-failed', 'CODER CODED', {
            dispatchedAt: '2026-08-20T00:00:00Z',
            dispatchedTerminal: 'Coder 1',
            routedTo: 'coder',
            planFile: '/tmp/held-failed.md',
            workspaceId: 'ws1',
        });
        const board = [held, card('next-failed', 'STAGING', { queuePosition: 2 })];
        const clearedCalls = [];
        const notifyCalls = [];
        const { server } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['Coder 1'],
            onWorkingStateCleared: () => { clearedCalls.push('fired'); },
            onTurnEndNotify: (info) => { notifyCalls.push(info); },
            db: {
                clearWorkingState: async () => { held.dispatchedAt = null; return true; },
                getPlanByPlanId: async (planId) => board.find(p => p.planId === planId),
                updateColumnByPlanFile: async () => { held.kanbanColumn = 'STAGING'; return true; },
                setQueuePositions: async () => true,
            },
        });
        await server.reportQueueDone({ workspaceRoot: WS, from: 'Coder 1', outcome: 'failed', planId: 'held-failed' });
        assert.deepStrictEqual(notifyCalls, [], 'onTurnEndNotify must NOT report a failure as outcome completed');
        assert.deepStrictEqual(clearedCalls, [], 'onWorkingStateCleared must NOT fire for a failed report');
    });

    await check('a team-in-flight 409 on the release pop does NOT arm the queue watch', async () => {
        // The release-arm exists for "popped nothing because the DISPATCH
        // failed → staged queue, idle team". A team-in-flight 409 is the
        // opposite: the team still holds a card in a coding column. It is also
        // the normal pop result for a head-paced team member reporting done,
        // and arming REBINDS the workspace watch's headTerminal to the
        // finishing seat — redirecting later queue-stall nudges from the lead
        // to a coder.
        const held = card('held-inflight', 'CODER CODED', {
            dispatchedAt: '2026-08-20T00:00:00Z',
            dispatchedTerminal: 'Coder 1',
            planFile: '/tmp/held-inflight.md',
            workspaceId: 'ws1',
        });
        const board = [held, card('next-inflight', 'STAGING', { queuePosition: 2 })];
        const arms = [];
        const { server } = makeServer(board, {
            resolveTeamMembers: async () => ['Lead 1', 'Coder 1'],
            resolveTeamPacing: async () => 'head',
            armQueueWatch: async (wsRoot, headTerminal, o) => { arms.push({ wsRoot, headTerminal, o }); },
            db: {
                // The card stays in its coding column with dispatched_terminal
                // set — clearWorkingState only NULLs dispatched_at.
                clearWorkingState: async () => { held.dispatchedAt = null; return true; },
            },
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'Coder 1', planId: 'held-inflight' });
        assert.strictEqual(out.status, 409, 'the in-flight refusal status is passed through');
        assert.ok(out.payload.inFlight, 'the in-flight refusal names the held card');
        assert.strictEqual(out.payload.released, 'held-inflight', 'the release still happened');
        assert.deepStrictEqual(arms, [], 'an in-flight team must not arm (or rebind) the queue watch');
    });

    await check('the global completion order is installed in the fleet orders database and stays idempotent', async () => {
        const board = [card('next', 'STAGING', { queuePosition: 1 })];
        let fleetOrders = [];
        let boardOrderWrites = 0;
        const fleetDb = {
            getConfigJson: async () => fleetOrders,
            setConfigJson: async (_key, value) => { fleetOrders = value; },
        };
        const { server } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['StandaloneCoder'],
            getFleetOrdersDatabase: async () => fleetDb,
            db: {
                getConfigJson: async () => [],
                setConfigJson: async () => { boardOrderWrites++; },
            },
        });
        await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'StandaloneCoder' });
        await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'StandaloneCoder' });
        assert.strictEqual(boardOrderWrites, 0, 'standing orders must not drift into the selected workspace DB');
        assert.strictEqual(fleetOrders.filter(o => o.id === 'global-queue-done:global').length, 1);
        assert.strictEqual(fleetOrders[0].scope, 'global');
        const rendered = applyStandingOrders('task', 'Unrelated Planner', fleetOrders, new Set(), []);
        assert.ok(rendered.includes('POST /kanban/queue/done'), 'global completion order must render for every terminal');
    });

    await check('a failed dispatch is passed through and consumes nothing', async () => {
        const board = [card('next', 'STAGING', { queuePosition: 1 })];
        const { server } = makeServer(board);
        server.performKanbanDispatch = async () => ({ status: 409, payload: { success: false, error: 'No terminal agent is live right now' } });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 409, 'the underlying failure status is passed through unchanged');
        assert.ok(/No terminal agent/.test(out.payload.error || ''), 'the underlying error text is preserved');
    });

    await check('a failed escalated dispatch retains its stronger-seat override for retry', async () => {
        const failed = card('failed', 'CODER CODED', {
            dispatchedAt: '2026-08-20T00:00:00Z',
            dispatchedTerminal: 'Coder 1',
            routedTo: 'coder',
            planFile: '/tmp/failed.md',
            workspaceId: 'ws1',
        });
        const board = [failed, card('next', 'STAGING', { queuePosition: 2 })];
        const { server } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1', 'Lead 1'],
            resolveTeamPacing: async () => 'seat',
            db: {
                clearWorkingState: async () => { failed.dispatchedAt = null; return true; },
                releaseDispatchHolder: async () => { failed.dispatchedTerminal = ''; failed.dispatchedAt = null; return true; },
                getPlanByPlanId: async (planId) => board.find(p => p.planId === planId),
                updateColumnByPlanFile: async () => { failed.kanbanColumn = 'STAGING'; return true; },
                setQueuePositions: async (_wsId, ids) => {
                    ids.forEach((id, index) => { const row = board.find(p => p.planId === id); if (row) row.queuePosition = index + 1; });
                    return true;
                },
            },
        });
        const attemptedColumns = [];
        server.performKanbanDispatch = async (_workspaceRoot, _planId, targetColumn) => {
            attemptedColumns.push(targetColumn);
            return { status: 409, payload: { success: false, error: 'lead unavailable' } };
        };
        const failedAttempt = await server.reportQueueDone({ workspaceRoot: WS, from: 'Coder 1', outcome: 'failed', planId: 'failed' });
        assert.strictEqual(failedAttempt.status, 409);
        server.performKanbanDispatch = async (_workspaceRoot, planId, targetColumn) => {
            attemptedColumns.push(targetColumn);
            const row = board.find(p => p.planId === planId);
            if (row) row.kanbanColumn = targetColumn;
            return { status: 200, payload: { success: true, planId } };
        };
        const retry = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding', pacing: 'seat' });
        assert.strictEqual(retry.status, 200);
        assert.deepStrictEqual(attemptedColumns, ['LEAD CODED', 'LEAD CODED']);
    });

    await check('escalation round trip: fail -> re-stage -> holder released -> pop dispatches without 409', async () => {
        const failed = card('failed-card', 'INTERN CODED', {
            dispatchedAt: '2026-08-20T00:00:00Z',
            dispatchedTerminal: 'Intern 1',
            routedTo: 'intern',
            planFile: '/tmp/failed-card.md',
            workspaceId: 'ws1',
        });
        const board = [failed, card('other', 'STAGING', { queuePosition: 2 })];
        let holderReleased = false;
        const { server, dispatched, dispatchOptions } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Intern 1', 'Coder 1'],
            resolveTeamPacing: async () => 'seat',
            db: {
                clearWorkingState: async () => { failed.dispatchedAt = null; return true; },
                releaseDispatchHolder: async () => {
                    holderReleased = true;
                    failed.dispatchedTerminal = '';
                    failed.dispatchedAt = null;
                    return true;
                },
                getPlanByPlanId: async (planId) => board.find(p => p.planId === planId),
                updateColumnByPlanFile: async () => { failed.kanbanColumn = 'STAGING'; return true; },
                setQueuePositions: async (_wsId, ids) => {
                    ids.forEach((id, index) => { const row = board.find(p => p.planId === id); if (row) row.queuePosition = index + 1; });
                    return true;
                },
            },
        });
        const doneRes = await server.reportQueueDone({ workspaceRoot: WS, from: 'Intern 1', outcome: 'failed', planId: 'failed-card' });
        assert.strictEqual(doneRes.status, 200);
        assert.strictEqual(holderReleased, true, 'releaseDispatchHolder must have been called on failed card');
        assert.strictEqual(failed.kanbanColumn, 'STAGING');
        assert.strictEqual(failed.dispatchedTerminal, '');
        assert.deepStrictEqual(dispatched, ['failed-card'], 'immediately following pop must dispatch the re-staged card');
        assert.deepStrictEqual(dispatchOptions[0].targetColumn, 'CODER CODED', 'stepped up to coder');
    });

    await check('a card re-staged by watch (empty holder) is not re-staged a second time by the ladder', async () => {
        const failed = card('already-restaged', 'STAGING', {
            dispatchedAt: null,
            dispatchedTerminal: '',
            routedTo: 'intern',
            planFile: '/tmp/already-restaged.md',
            workspaceId: 'ws1',
        });
        const board = [failed, card('next-in-line', 'STAGING', { queuePosition: 1 })];
        let columnUpdateCalled = false;
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Intern 1', 'Coder 1'],
            resolveTeamPacing: async () => 'seat',
            db: {
                clearWorkingState: async () => true,
                getPlanByPlanId: async (planId) => board.find(p => p.planId === planId),
                updateColumnByPlanFile: async () => { columnUpdateCalled = true; return true; },
            },
        });
        // held pre-read has empty dispatchedTerminal
        const res = await server.reportQueueDone({ workspaceRoot: WS, from: 'Intern 1', outcome: 'failed', planId: 'already-restaged' });
        // Since held is not found in board with matching terminal or fresh read has empty holder, it does not double re-stage
        assert.strictEqual(columnUpdateCalled, false, 'updateColumnByPlanFile must not be called when holder is already released');
    });

    await check('in-flight predicate in LocalApiServer contains no column comparison', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const i = src.indexOf('if (isTeamDispatch) {');
        assert.notStrictEqual(i, -1, 'isTeamDispatch block must exist');
        const body = src.slice(i, src.indexOf('\n            }', i));
        assert.ok(!/CODING_COLUMNS/.test(body), 'in-flight predicate must not reference CODING_COLUMNS');
        assert.ok(!/kanbanColumn/.test(body) || !body.includes('.has('), 'in-flight predicate must not compare kanbanColumn');
        assert.ok(/!p\.completedAt/.test(body) || /!inFlightCard\.completedAt/.test(body), 'in-flight predicate must check completedAt');
    });

    await check('concurrent pops are serialized — one card, one dispatch', async () => {
        const board = [card('only', 'STAGING', { queuePosition: 1 })];
        const { server, dispatched } = makeServer(board);
        // Drain the card inside the critical section, exactly as a real
        // dispatch does by moving it out of STAGING.
        server.performKanbanDispatch = async (workspaceRoot, planId) => {
            await new Promise(r => setTimeout(r, 10));
            const row = board.find(p => p.planId === planId);
            if (row) { row.kanbanColumn = 'CODER CODED'; row.dispatchedTerminal = 'Coder 1'; }
            dispatched.push(planId);
            return { status: 200, payload: { success: true, planId } };
        };
        const [a, b] = await Promise.all([
            server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Head A' }),
            server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Head B' }),
        ]);
        assert.deepStrictEqual(dispatched, ['only'], 'exactly one dispatch for a one-card queue');
        const nulls = [a, b].filter(r => r.status === 200 && r.payload.dispatched === null);
        assert.strictEqual(nulls.length, 1, 'the loser must see an empty queue, not the same card');
    });

    // ── Subtask 1: one entry point (subtasks 3 and 4 depend on it) ─────────

    await check('the HTTP route delegates to dispatchNextFromQueue and selects nothing itself', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const i = src.indexOf('private async _handleKanbanQueueNext(');
        assert.notStrictEqual(i, -1, '_handleKanbanQueueNext must exist');
        const body = src.slice(i, src.indexOf('\n    }', i));
        assert.ok(/this\.dispatchNextFromQueue\(/.test(body), 'the route must delegate to the method');
        assert.ok(!/kanbanColumn ===/.test(body) && !/getBoard\(/.test(body),
            'the route must contain no card selection of its own — one serialization point, one arming site');
    });

    await check('no caller loops back through localhost to reach the pop', () => {
        const fs = require('fs');
        for (const rel of [
            ['src', 'services', 'TaskViewerProvider.ts'],
            ['src', 'services', 'KanbanProvider.ts'],
        ]) {
            const src = fs.readFileSync(path.join(process.cwd(), ...rel), 'utf8');
            assert.ok(!/127\.0\.0\.1[^\n]*kanban\/queue\/next/.test(src),
                `${rel.join('/')} must call dispatchNextFromQueue in-process, not over localhost HTTP`);
        }
    });

    await check('standalone queue UI and resolver stay wired to live coding terminals', () => {
        const fs = require('fs');
        const provider = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        const resolverStart = provider.indexOf('public getAliveCodingTerminalNames(): string[]');
        const resolver = provider.slice(resolverStart, provider.indexOf('\n    public ', resolverStart + 10));
        assert.ok(/entry\.role/.test(resolver), 'PTY roles must be read from fleet liveness rather than requiring a VS Code-only cache row');
        assert.ok(/_terminalAgentInfo\.delete\(name\)/.test(resolver), 'stale cache rows must be pruned');
        assert.ok(/\[\.\.\.leads\]\.sort\(\)\.concat\(\[\.\.\.coders\]\.sort\(\)\)/.test(resolver),
            'live coding terminals must remain deterministic with leads before coders');
        assert.ok(/role === 'lead'/.test(resolver) && /role === 'coder'/.test(resolver));

        const kanbanProvider = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const runStart = kanbanProvider.indexOf("case 'runQueue':");
        const runQueue = kanbanProvider.slice(runStart, kanbanProvider.indexOf("case '", runStart + 20));
        assert.ok(/getAliveCodingTerminalNames\(\)/.test(runQueue));
        assert.ok(/No coding terminal is live/.test(runQueue));

        const webview = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'kanban.html'), 'utf8');
        assert.ok(/lastCodingHeadLive \|\| lastAnyCodingTerminalLive/.test(webview));
    });

    // ── Subtask 3: the queue watch ────────────────────────────────────────

    await check('the queue watch counts STAGING only, and escalates exactly once', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'PlanIngestionEngine.ts'), 'utf8');
        const i = src.indexOf('private async _runQueueNudgeSweep(');
        assert.notStrictEqual(i, -1, '_runQueueNudgeSweep must exist');
        const body = src.slice(i, src.indexOf('\n    private ', i + 10));
        assert.ok(!/kanbanColumn === 'PLAN REVIEWED'/.test(body),
            "the watch's queue must be STAGING only — counting PLAN REVIEWED means it never reaches 'queue empty' on a real board and nudges forever");
        assert.ok(/watch\.escalatedAt/.test(body),
            'escalatedAt must remain in the body — it bounds the genuine operator alerts (dead-pacer/no-pacer), not the removed stall escalation');
        assert.ok(/nudgeCount >= 1/.test(body),
            'one nudge, then stop — nudgeCount >= 1 keeps the watch silent without escalating');
        assert.ok(/_queueTeamMembersResolver/.test(body) && /teamMembers\.has\(p\.dispatchedTerminal\)/.test(body),
            "a seat-paced watch must select a held card from its own team, not another team's first active card");
        // The head-pacing branch must also use the team resolver for in-flight
        // detection (not just `=== watch.headTerminal`).
        assert.ok(/headTeamSet\.has\(p\.dispatchedTerminal\)/.test(body),
            'the head-pacing branch must use team-wide in-flight detection via the resolver, not head-only');
        // Both sweeps must have a team-liveness suppression gate.
        assert.ok(/nudgeSilenceMs/.test(body),
            'the queue nudge sweep must use nudgeSilenceMs for the pacing floor and team-liveness window');
        // The removed stall-escalation branches must not contain a notifier call.
        // The genuine operator alerts (no-head, dead-head, no-pacer, dead-pacer)
        // still call _turnEndNotifier; the gate-(8) stop-guards must not.
        const gateIdx = body.indexOf('if (watch.nudgeCount >= 1)');
        assert.notStrictEqual(gateIdx, -1, 'gate (8) nudgeCount >= 1 guard must exist');
        // Find all gate-(8) blocks and confirm none contain a notifier call.
        let searchFrom = 0;
        let guardCount = 0;
        while (true) {
            const idx = body.indexOf('if (watch.nudgeCount >= 1)', searchFrom);
            if (idx === -1) break;
            guardCount++;
            const blockEnd = body.indexOf('continue;', idx);
            const block = body.slice(idx, blockEnd);
            assert.ok(!/_turnEndNotifier/.test(block),
                'gate (8) stop-guard must not contain a _turnEndNotifier call — user escalation is removed');
            searchFrom = blockEnd + 1;
        }
        assert.ok(guardCount >= 2, 'both head-pacing and seat-pacing must have a nudgeCount >= 1 stop-guard');
    });

    await check('the feature nudge has nudgeCount and stops after one nudge', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'PlanIngestionEngine.ts'), 'utf8');
        const i = src.indexOf('private async _runFeatureNudgeSweep(');
        assert.notStrictEqual(i, -1, '_runFeatureNudgeSweep must exist');
        const body = src.slice(i, src.indexOf('\n    private ', i + 10));
        assert.ok(/nudgeCount/.test(body),
            'the feature nudge sweep must use nudgeCount to stop after one nudge');
        assert.ok(/nudgeSilenceMs/.test(body),
            'the feature nudge sweep must use nudgeSilenceMs for the pacing floor and team-liveness window');
        assert.ok(/_queueTeamMembersResolver/.test(body),
            'the feature nudge sweep must have a team-liveness suppression gate using the resolver');
    });

    await check('nudgeSilenceMs is read from config in the tick', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'PlanIngestionEngine.ts'), 'utf8');
        assert.ok(/getNumber\('nudgeSilenceMs'/.test(src),
            "the tick must read nudgeSilenceMs from the activityLight config section");
    });

    await check('a dispatch clears the whole stall state, not just the nudge counter', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'PlanIngestionEngine.ts'), 'utf8');
        const i = src.indexOf('public async armQueueWatch(');
        assert.notStrictEqual(i, -1, 'armQueueWatch must exist');
        const body = src.slice(i, src.indexOf('\n    /**', i + 10));
        assert.ok(/delete rearmed\.escalatedAt/.test(body),
            'an onDispatch re-arm must clear escalatedAt so a later stall escalates again');
    });

    await check('every staging path arms the watch, not just the pop', () => {
        const fs = require('fs');
        const kanban = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const stageIdx = kanban.indexOf('public async stageForQueue(');
        assert.notStrictEqual(stageIdx, -1, 'stageForQueue must exist');
        const stageBody = kanban.slice(stageIdx, kanban.indexOf('\n    /**', stageIdx + 10));
        assert.ok(/armQueueWatch\(/.test(stageBody),
            'staging is the EARLIEST moment a silent night becomes possible — dispatch-only arming leaves a staged-but-never-dispatched queue unwatched');
        const api = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        assert.ok(/armQueueWatch\([^)]*onDispatch: true/.test(api),
            'the pop must arm with onDispatch so the stall window restarts from the dispatch');
    });

    // ── Subtask 7: remote intake ──────────────────────────────────────────

    await check('remote queue mode stages only dispatch columns', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'RemoteControlService.ts'), 'utf8');
        assert.ok(/QUEUEABLE_TARGET_COLUMNS/.test(src),
            'queue mode needs a dispatch-column test: stateKeyToColumn maps onto ANY column, so an unguarded branch stages a card the remote user moved to COMPLETED');
        assert.ok(/mode === 'queue' && QUEUEABLE_TARGET_COLUMNS\.has\(targetColumn\)/.test(src),
            'the staging branch must be gated on the target column being a dispatch column');
        assert.ok(/'CODER CODED'/.test(src) && !/QUEUEABLE_TARGET_COLUMNS[\s\S]{0,300}'COMPLETED'/.test(src),
            'the queueable set covers the coding columns and must not include finished columns');
    });

    await check("unknown persisted remote modes normalise to 'ingest', never to 'queue'", () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'RemoteControlService.ts'), 'utf8');
        const i = src.indexOf('private _normalizeMode(');
        assert.notStrictEqual(i, -1, '_normalizeMode must exist — both config ternaries must go through it or `queue` can never be persisted');
        const body = src.slice(i, src.indexOf('\n    }', i));
        assert.ok(/return 'ingest'/.test(body),
            "garbage input must resolve to 'ingest' (move nothing) — normalising to 'queue' would start moving cards on shipped installs");
    });

    // ── Subtask 4: the schedule is one more caller, with no suppression ────

    await check('the schedule pops the queue and owns no in-flight bookkeeping', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        const i = src.indexOf('private async _scheduleQueuePop(): Promise<void>');
        assert.notStrictEqual(i, -1, '_scheduleQueuePop must exist');
        const body = src.slice(i, src.indexOf('\n    }', i));
        assert.ok(/dispatchNextFromQueue\(/.test(body), 'the schedule must dispatch through the pop');
        assert.ok(!/_autobanLaneInFlight/.test(body) && !/whenSchedule.*suppress/i.test(body),
            "the pop's 409 replaces every suppression guard — no lane map, no mutual disabling");
        assert.ok(/resolveCodingHeadFromGroups/.test(body),
            'the schedule must resolve its head the same way Run queue, staging and the watch do — the state.json registry cannot see a pty-fleet team');
    });

    await check('the file-based team queue binds every operation and completion report to the URL group', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const routeStart = src.indexOf('private async _handleTeamQueueRoute(');
        const doneStart = src.indexOf('private _handleTeamQueueDone(');
        assert.ok(routeStart > 0 && doneStart > routeStart);
        const route = src.slice(routeStart, doneStart);
        assert.ok(/_resolveRegisteredTeamGroup\(workspaceRoot, groupId\)/.test(route));
        assert.ok(route.indexOf('_resolveRegisteredTeamGroup(workspaceRoot, groupId)') < route.indexOf('listQueue(workspaceRoot, groupId)'),
            'the registered-group lookup must happen before the first queue filesystem operation');
        assert.ok(/_handleTeamQueueDone\(groupId, group, req, res\)/.test(route));
        const done = src.slice(doneStart, src.indexOf('\n    /**', doneStart + 10));
        assert.ok(/roster\.includes\(from\)/.test(done));
        assert.ok(/teamHeadName\(group\)/.test(done));
        assert.ok(/_teamQueueDoneChains\.get\(groupId\)/.test(done), 'completion chains must be per team');
    });

    await check('the completion-driven queue has no orphaned claim mechanism and manual send deletes only after delivery', () => {
        const fs = require('fs');
        const service = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TeamQueueService.ts'), 'utf8');
        for (const removed of ['claimItem', 'releaseClaim', 'readClaim', 'CLAIM_STALENESS_HOURS', 'QueueClaimResult', 'claimedBy', 'claimedTs']) {
            assert.ok(!service.includes(removed), `${removed} must stay deleted from TeamQueueService`);
        }
        const webview = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'terminals.js'), 'utf8');
        const sendStart = webview.indexOf('async function sendNextQueueItem()');
        const send = webview.slice(sendStart, webview.indexOf('\n    /**', sendStart + 10));
        assert.ok(!send.includes('/claim'));
        assert.ok(send.indexOf("fetch('/terminals/verb/ptySendPrompt'") < send.indexOf("method: 'DELETE'"),
            'manual queue delivery must dispatch before deleting the item');
        assert.ok(/dispatchData\?\.success !== false/.test(send), 'HTTP 200 with success:false is not a successful dispatch');
    });

    await check('auto mode is standing-order state, not an optimistic UI flag', () => {
        const fs = require('fs');
        const webview = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'terminals.js'), 'utf8');
        const modeStart = webview.indexOf('async function setQueueMode(mode)');
        const mode = webview.slice(modeStart, webview.indexOf('\n    /**', modeStart + 10));
        assert.ok(/await loadQueueModeFromOrders\(\)/.test(mode));
        assert.ok(/!res\.ok \|\| !data\?\.success/.test(mode), 'a failed mode write must be surfaced and re-read');
        const wiring = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'teamWiring.ts'), 'utf8');
        assert.ok(/export async function applyTeamQueueOrders/.test(wiring));
        assert.ok(/team-queue-done:/.test(wiring));
    });

    console.log('');
    if (failures > 0) {
        console.error(`${failures} contract(s) failed.`);
        process.exit(1);
    }
    console.log('queue-pipeline contract passed');
}

run().catch(err => {
    console.error('queue-pipeline contract crashed:', err);
    process.exit(1);
});
