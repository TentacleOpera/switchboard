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

const { LocalApiServer, teamHasLiveWork } = require(path.join(process.cwd(), 'out', 'services', 'LocalApiServer.js'));
const { applyStandingOrders } = require(path.join(process.cwd(), 'out', 'services', 'standingOrders.js'));
const { resolveRoleWithDegradation } = require(path.join(process.cwd(), 'out', 'services', 'complexityScale.js'));
const { compareByPrecedence } = require(path.join(process.cwd(), 'out', 'services', 'kanbanOrdering.js'));

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

/** A board row shaped the way `getBoard` returns them (V81: owner_seat /
 *  owner_since are advisory; column_order is the single ordering field). */
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
        resolveTeamBatchSize: opts.resolveTeamBatchSize,
        kanbanVerb: opts.kanbanVerb,
        resolveKanbanDispatch: opts.resolveKanbanDispatch,
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

    await check('the pop takes the lowest column_order, NULLs LAST inside STAGING', async () => {
        // V81 shipped this file contradicting itself: the comparator body carved
        // STAGING out as NULLs-LAST, while the module header and this fixture
        // still said NULLs-first, so the case has been red since the day it
        // landed. The comparator is the intended contract, for two reasons it
        // records itself. (1) The carve-out names the regression that produced
        // it: folding queue_position into column_order "made a card dragged into
        // STAGING the next thing dispatched". (2) The WRITER agrees —
        // `KanbanDatabase.appendQueuePositions` appends from MAX(column_order)+1
        // and documents "NULL positions ... sort last by design ... they keep
        // working and drop to the end". If NULL led, a positionless pre-existing
        // staged card would outrank everything the operator just staged, and
        // appending above the max would be pointless.
        //
        // The meaning: STAGING is a sequence somebody committed to, not a board
        // arrangement. A card arriving without a position joins the END of that
        // sequence; it never jumps the queue.
        const board = [
            card('c', 'STAGING', { columnOrder: null }),
            card('b', 'STAGING', { columnOrder: 7 }),
            card('a', 'STAGING', { columnOrder: 2 }),
        ];
        const { server, dispatched } = makeServer(board);
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatched, ['a'],
            'the lowest real column_order leads; a NULL joins the end of the committed sequence, it does not jump it');
    });

    await check('the STAGING NULL rule is the INVERSE of every other column', async () => {
        // Both halves, as values, because the distinction is the whole point and
        // a single-column test cannot see it. Outside STAGING a NULL is "just
        // arrived / not part of this arrangement" and leads; inside STAGING it
        // joins the end. Deleting the carve-out makes these two agree, which is
        // exactly the regression V81's comparator comment describes.
        const positioned = { planId: 'pos', columnOrder: 2 };
        const unpositioned = { planId: 'none', columnOrder: null };

        assert.ok(
            compareByPrecedence(unpositioned, positioned, 'STAGING', 'manual') > 0,
            'inside STAGING an unpositioned card must sort AFTER a positioned one'
        );
        assert.ok(
            compareByPrecedence(positioned, unpositioned, 'STAGING', 'manual') < 0,
            'inside STAGING a positioned card must sort BEFORE an unpositioned one'
        );
        assert.ok(
            compareByPrecedence(unpositioned, positioned, 'PLAN REVIEWED', 'manual') < 0,
            'outside STAGING an unpositioned card is a new arrival and must sort FIRST'
        );
        assert.ok(
            compareByPrecedence(positioned, unpositioned, 'PLAN REVIEWED', 'manual') > 0,
            'outside STAGING a positioned card must sort AFTER a new arrival'
        );
    });

    await check('subtasks are excluded from the queue; an owner-stamped card is not', async () => {
        // V81: ownership is advisory — an owner-stamped card in STAGING is
        // still eligible work and is handed out again.
        const board = [
            card('sub', 'STAGING', { featureId: 'feat-1', columnOrder: 1 }),
            card('gone', 'STAGING', { ownerSince: '2026-08-18T00:00:00Z', ownerSeat: 'Coder 1', columnOrder: 2 }),
            card('real', 'STAGING', { columnOrder: 3 }),
        ];
        const { server, dispatched } = makeServer(board);
        await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.deepStrictEqual(dispatched, ['gone'],
            'a subtask (non-empty featureId) is skipped; an owner-stamped card is dispatched, not skipped');
    });

    // ── Subtask 1: the in-flight predicate (the deadlock regression) ───────

    await check('seat pacing ignores resting coded cards and routes the next queued card', async () => {
        // Post anchor plan: the seat-pacing skip is deleted. A resting coded
        // card must have completedAt set to release the team — completion is
        // asserted, not inferred from column position.
        const board = [
            card('resting', 'INTERN CODED', { ownerSeat: 'Intern 1', ownerSince: '2026-08-20T00:00:00Z', completedAt: '2026-08-24T12:00:00Z' }),
            card('next', 'STAGING', { columnOrder: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Intern 1'],
            resolveTeamPacing: async () => 'seat',
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatched, ['next']);
    });

    await check('a card in any column with completed_at set is finished work, not a block', async () => {
        const board = [
            card('done', 'CODE REVIEWED', { ownerSince: '2026-08-18T00:00:00Z', ownerSeat: 'Coder 1', completedAt: '2026-08-24T12:00:00Z' }),
            card('next', 'STAGING', { columnOrder: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200, `expected the next card, got ${out.status}: ${out.payload.error || ''}`);
        assert.deepStrictEqual(dispatched, ['next']);
    });

    await check('a card held by a team member with completed_at NULL does NOT refuse the pop', async () => {
        // V81: the board never refuses a dispatch. A held card is advisory
        // display metadata; the pop hands out the next eligible card.
        const board = [
            card('wip', 'CODE REVIEWED', { ownerSeat: 'Coder 1', ownerSince: '2026-08-20T00:00:00Z', completedAt: null }),
            card('next', 'STAGING', { columnOrder: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200, 'a held card must not refuse the pop');
        assert.deepStrictEqual(dispatched, ['next'], 'the next card dispatches even while a seat holds another');
    });

    await check('a team holding a card in a coding column still receives the next card', async () => {
        const board = [
            card('wip', 'CODER CODED', { ownerSeat: 'Coder 1', ownerSince: '2026-08-20T00:00:00Z', completedAt: null }),
            card('next', 'STAGING', { columnOrder: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200, 'a team with a card in flight still gets the next card');
        assert.deepStrictEqual(dispatched, ['next']);
    });

    await check('an owned STAGING card with a cleared stamp is still eligible', async () => {
        // V81: a queue/done or staleness sweep can clear owner_since while the
        // advisory owner_seat stays. Neither field is a gate — the card is
        // still handed out.
        const board = [
            card('wip', 'STAGING', { ownerSeat: 'Coder 1', ownerSince: null, completedAt: null, columnOrder: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatched, ['wip']);
    });

    await check("another team's coding card does not block this team", async () => {
        const board = [
            card('theirs', 'CODER CODED', { ownerSeat: 'Other Coder', ownerSince: '2026-08-20T00:00:00Z' }),
            card('next', 'STAGING', { columnOrder: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatched, ['next']);
    });

    await check("a `from` that is not a live terminal is a 400", async () => {
        const board = [card('next', 'STAGING', { columnOrder: 1 })];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['OtherTerminal'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Ghost' });
        assert.strictEqual(out.status, 400, 'a `from` that is not a live terminal must not dispatch');
        assert.deepStrictEqual(dispatched, []);
    });

    await check("a live `from` not on any team dispatches via workspace-wide routing", async () => {
        const board = [card('next', 'STAGING', { columnOrder: 1 })];
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

    await check('non-team dispatch is unaffected by a held card', async () => {
        const board = [
            card('wip', 'CODER CODED', { ownerSeat: 'StandaloneCoder', ownerSince: '2026-08-20T00:00:00Z' }),
            card('next', 'STAGING', { columnOrder: 1 }),
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
        const board = [card('next', 'STAGING', { columnOrder: 1 })];
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
            ownerSince: '2026-08-20T00:00:00Z',
            ownerSeat: 'StandaloneCoder',
            planFile: '/tmp/held.md',
            workspaceId: 'ws1',
        });
        const board = [held, card('next', 'STAGING', { columnOrder: 1 })];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['StandaloneCoder'],
            db: {
                clearOwnerStamp: async () => { held.ownerSince = null; held.ownerSeat = ''; return true; },
            },
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'StandaloneCoder', planId: 'held' });
        assert.strictEqual(out.status, 200);
        assert.strictEqual(out.payload.released, 'held');
        assert.deepStrictEqual(dispatched, ['next']);
    });

    // ── Column-move orphan release ────────────────────────────────────────
    //
    // A column move clears owner_since and keeps owner_seat, so a card that
    // advanced past its dispatch column is invisible to a release path that
    // required the stamp — but its own seat still holds it by owner_seat.
    // V81's candidates select keys on owner_seat alone, so the orphan is
    // releasable by its seat with no fallback.

    await check('an orphaned holder (owner_since NULL, owner_seat set) is released by its seat', async () => {
        // The load-bearing case: clearOwnerStamp's unconditional WHERE covers
        // the orphan in one write — no live-stamp requirement.
        const held = card('orphan', 'CODE REVIEWED', {
            ownerSince: null,
            ownerSeat: 'seat-1',
            completedAt: null,
            planFile: '/tmp/orphan.md',
            workspaceId: 'ws1',
        });
        const board = [held, card('next', 'STAGING', { columnOrder: 1 })];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['seat-1'],
            db: {
                clearOwnerStamp: async () => { held.ownerSeat = ''; held.ownerSince = null; return true; },
            },
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'seat-1', planId: 'orphan' });
        assert.strictEqual(out.status, 200, `expected 200, got ${out.status}: ${out.payload.error || ''}`);
        assert.strictEqual(out.payload.released, 'orphan', 'the orphaned card must be released by its own seat');
        assert.deepStrictEqual(dispatched, ['next'], 'the next card must pop after the release');
    });

    await check('the release select keys on owner_seat (drift guard)', () => {
        // V81: the done-select matches owner_seat === from (and optionally
        // planId for disambiguation); the advisory teamHasLiveWork reads the
        // same owner fields. Pin the field the select matches on so a rename
        // cannot silently strand held cards.
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const fnIdx = src.indexOf('private _runQueueDone(');
        assert.notStrictEqual(fnIdx, -1, '_runQueueDone must exist');
        const selIdx = src.indexOf('const candidates = board', fnIdx);
        assert.notStrictEqual(selIdx, -1, 'the ordered candidates select must exist in _runQueueDone');
        const selEnd = src.indexOf('held = candidates[0];', selIdx);
        assert.notStrictEqual(selEnd, -1, 'the no-planId fallback must select candidates[0]');
        const selBlock = src.slice(selIdx, selEnd);
        assert.ok(/ownerSeat/.test(selBlock),
            'the release select must match on ownerSeat (the holder)');
        assert.ok(!/p\.ownerSince/.test(selBlock) && !/!!p\.ownerSince/.test(selBlock),
            'the release select must NOT require ownerSince — requiring it made orphaned cards unreleasable');
        // teamHasLiveWork is the advisory read for the same fact: it must read
        // the owner fields and must not read a column.
        const predIdx = src.indexOf('export async function teamHasLiveWork(');
        assert.notStrictEqual(predIdx, -1, 'teamHasLiveWork must exist');
        const predBody = src.slice(predIdx, src.indexOf('\n}', predIdx));
        assert.ok(/ownerSince/.test(predBody) && /ownerSeat/.test(predBody),
            'teamHasLiveWork must read ownerSince + ownerSeat');
        assert.ok(!/kanbanColumn/.test(predBody),
            'teamHasLiveWork must not compare columns — holding is an owner fact, not a position');
    });

    await check('a seat holding one live card and three orphans releases the live card without planId', async () => {
        // Ordering: a live card (owner_since set) wins over an orphaned one
        // (stamp cleared by a column move), so a seat holding exactly one live
        // card behaves exactly as before.
        const live = card('live', 'CODER CODED', {
            ownerSince: '2026-08-30T00:00:00Z',
            ownerSeat: 'seat-1',
            planFile: '/tmp/live.md', workspaceId: 'ws1',
        });
        const orphan1 = card('orphan-1', 'CODE REVIEWED', {
            ownerSince: null, ownerSeat: 'seat-1',
            planFile: '/tmp/o1.md', workspaceId: 'ws1',
        });
        const orphan2 = card('orphan-2', 'PLAN REVIEWED', {
            ownerSince: null, ownerSeat: 'seat-1',
            planFile: '/tmp/o2.md', workspaceId: 'ws1',
        });
        const orphan3 = card('orphan-3', 'CODER CODED', {
            ownerSince: null, ownerSeat: 'seat-1',
            planFile: '/tmp/o3.md', workspaceId: 'ws1',
        });
        const board = [orphan1, live, orphan2, orphan3, card('next', 'STAGING', { columnOrder: 1 })];
        let clearedPlanFile = null;
        const { server } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['seat-1'],
            db: {
                clearOwnerStamp: async (planFile) => { clearedPlanFile = planFile; live.ownerSince = null; live.ownerSeat = ''; return true; },
            },
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'seat-1' });
        assert.strictEqual(out.status, 200);
        assert.strictEqual(out.payload.released, 'live',
            'without planId the live card must win over the orphans');
        assert.strictEqual(clearedPlanFile, '/tmp/live.md');
    });

    await check('with planId naming an orphan, the seat releases that orphan', async () => {
        const live = card('live', 'CODER CODED', {
            ownerSince: '2026-08-30T00:00:00Z', ownerSeat: 'seat-1',
            planFile: '/tmp/live.md', workspaceId: 'ws1',
        });
        const orphan = card('orphan-x', 'CODE REVIEWED', {
            ownerSince: null, ownerSeat: 'seat-1',
            planFile: '/tmp/orphan-x.md', workspaceId: 'ws1',
        });
        const board = [live, orphan, card('next', 'STAGING', { columnOrder: 1 })];
        let releasedPlanFile = null;
        const { server } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['seat-1'],
            db: {
                // clearOwnerStamp is unconditional — one write covers the
                // orphan (no live-stamp requirement).
                clearOwnerStamp: async (planFile) => { releasedPlanFile = planFile; orphan.ownerSeat = ''; return true; },
            },
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'seat-1', planId: 'orphan-x' });
        assert.strictEqual(out.status, 200);
        assert.strictEqual(out.payload.released, 'orphan-x',
            'planId naming an orphan must release that orphan, not the live card');
        assert.strictEqual(releasedPlanFile, '/tmp/orphan-x.md');
    });

    await check('a planId the seat does not hold is refused, not silently ignored', async () => {
        // Negative (paired): a seat cannot release a card held by another
        // seat — a planId naming another seat's card is refused. The filter
        // is owner_seat === from, so another seat's card never enters
        // candidates and the planId find returns undefined → the duplicate
        // arm would silently no-op WITHOUT the guard. The guard must turn
        // this into an explicit refusal.
        const theirs = card('theirs', 'CODER CODED', {
            ownerSince: '2026-08-30T00:00:00Z', ownerSeat: 'seat-2',
            planFile: '/tmp/theirs.md', workspaceId: 'ws1',
        });
        const mine = card('mine', 'CODER CODED', {
            ownerSince: '2026-08-30T00:00:00Z', ownerSeat: 'seat-1',
            planFile: '/tmp/mine.md', workspaceId: 'ws1',
        });
        const board = [theirs, mine, card('next', 'STAGING', { columnOrder: 1 })];
        const { server } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['seat-1', 'seat-2'],
            db: { clearOwnerStamp: async () => true },
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'seat-1', planId: 'theirs' });
        assert.strictEqual(out.status, 400,
            'a planId naming another seat card must be refused, not silently released or ignored');
        assert.ok(/does not hold/.test(out.payload.error || ''),
            'the refusal must state the seat does not hold that card');
    });

    await check('a planId naming an already-completed card is a 200 no-op, not a refusal', async () => {
        // The second post of a completion. The controller posts on a coder's
        // behalf; the coder wakes and submits the same card. The card carries
        // `completed_at`, so it is excluded from the live candidates — and
        // WITHOUT this arm the seat still holding another live card would be
        // told "you do not hold that plan", a 4xx that strands a coder which did
        // nothing wrong. The idempotency is implemented ONCE here so every
        // caller gets it.
        const done = card('done-x', 'CODE REVIEWED', {
            ownerSince: null, ownerSeat: '', completedAt: '2026-08-30T01:00:00Z',
            planFile: '/tmp/done-x.md', workspaceId: 'ws1',
        });
        const mine = card('mine', 'CODER CODED', {
            ownerSince: '2026-08-30T00:00:00Z', ownerSeat: 'seat-1',
            planFile: '/tmp/mine.md', workspaceId: 'ws1',
        });
        const board = [done, mine, card('next', 'STAGING', { columnOrder: 1 })];
        const { server } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['seat-1'],
            db: {
                clearOwnerStamp: async () => true,
                getPlanByPlanId: async (planId) => board.find(p => p.planId === planId),
            },
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'seat-1', planId: 'done-x' });
        assert.strictEqual(out.status, 200,
            'a card somebody already posted for must answer 200 — a 4xx here strands the seat');
        assert.strictEqual(out.payload.reason, 'already complete',
            'the no-op must SAY it was already complete rather than reading as a generic duplicate');
        assert.strictEqual(out.payload.success, true);
    });

    await check('a completed card that cannot be read is NOT reported as already complete', async () => {
        // The read is the only thing that earns the "already complete" answer.
        // An unreadable card falls through to the existing mismatch refusal, so
        // "we could not tell" never renders as "somebody already did it".
        const mine = card('mine', 'CODER CODED', {
            ownerSince: '2026-08-30T00:00:00Z', ownerSeat: 'seat-1',
            planFile: '/tmp/mine.md', workspaceId: 'ws1',
        });
        const board = [mine, card('next', 'STAGING', { columnOrder: 1 })];
        const { server } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['seat-1'],
            db: {
                clearOwnerStamp: async () => true,
                getPlanByPlanId: async () => { throw new Error('db down'); },
            },
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'seat-1', planId: 'ghost' });
        assert.strictEqual(out.status, 400, 'an unreadable card keeps the existing refusal');
        assert.notStrictEqual(out.payload.reason, 'already complete');
    });

    await check('teamHasLiveWork is advisory — a live-stamped roster card counts, nothing gates on it', async () => {
        // The advisory read answers "does any roster seat currently have a
        // card out for work?" — owner_since set + owner_seat on the roster.
        // A column move that cleared owner_since reads as not-live; the
        // owner_seat holder fact alone does not count.
        const before = card('c', 'CODER CODED', {
            ownerSeat: 'seat-1', ownerSince: '2026-08-30T00:00:00Z', completedAt: null,
        });
        const dbFor = (rows) => ({
            getWorkspaceId: async () => 'ws1',
            getDominantWorkspaceId: async () => 'ws1',
            getBoard: async () => rows,
        });
        assert.strictEqual(await teamHasLiveWork(dbFor([before]), ['seat-1']), true,
            'a live-stamped roster card counts as live work');
        const moved = { ...before, kanbanColumn: 'CODE REVIEWED', ownerSince: null };
        assert.strictEqual(await teamHasLiveWork(dbFor([moved]), ['seat-1']), false,
            'a cleared stamp (column move) reads as not live — the advisory tracks the stamp, not the holder alone');
        const otherTeam = card('d', 'CODER CODED', {
            ownerSeat: 'other-seat', ownerSince: '2026-08-30T00:00:00Z',
        });
        assert.strictEqual(await teamHasLiveWork(dbFor([otherTeam]), ['seat-1']), false,
            'a card owned by a non-roster seat does not count for this team');
    });

    await check('_runQueueDone fires onTurnEndNotify and onWorkingStateCleared when clearOwnerStamp transitions', async () => {
        // The API completion path must fire the same turn-end / working-state
        // callbacks the file-watcher path fires, gated on the SAME
        // `transitioned` boolean — a watcher-first clear returns false and
        // must NOT reach the callbacks (verified by the duplicate case below).
        const held = card('held-cb', 'CODER CODED', {
            ownerSince: '2026-08-20T00:00:00Z',
            ownerSeat: 'StandaloneCoder',
            planFile: '/tmp/held-cb.md',
            workspaceId: 'ws1',
        });
        const board = [held, card('next-cb', 'STAGING', { columnOrder: 1 })];
        const clearedCalls = [];
        const notifyCalls = [];
        const { server } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['StandaloneCoder'],
            onWorkingStateCleared: (record, workspaceRoot) => { clearedCalls.push({ record, workspaceRoot }); },
            onTurnEndNotify: (info) => { notifyCalls.push(info); },
            db: {
                clearOwnerStamp: async () => { held.ownerSince = null; held.ownerSeat = ''; return true; },
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

    await check('_runQueueDone does NOT fire callbacks when clearOwnerStamp returns false (watcher-first)', async () => {
        // A duplicate report or a watcher-first clear makes clearOwnerStamp
        // return false (no live-stamp transition). The callbacks must NOT
        // fire — the single-fire contract is the `transitioned` boolean.
        const held = card('held-dup', 'CODER CODED', {
            ownerSince: '2026-08-20T00:00:00Z',
            ownerSeat: 'StandaloneCoder',
            planFile: '/tmp/held-dup.md',
            workspaceId: 'ws1',
        });
        const board = [held, card('next-dup', 'STAGING', { columnOrder: 1 })];
        const clearedCalls = [];
        const notifyCalls = [];
        const { server } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['StandaloneCoder'],
            onWorkingStateCleared: () => { clearedCalls.push('fired'); },
            onTurnEndNotify: () => { notifyCalls.push('fired'); },
            db: {
                clearOwnerStamp: async () => false,
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
            ownerSince: '2026-08-20T00:00:00Z',
            ownerSeat: 'Coder 1',
            planFile: '/tmp/held-failed.md',
            workspaceId: 'ws1',
        });
        const board = [held, card('next-failed', 'STAGING', { columnOrder: 2 })];
        const clearedCalls = [];
        const notifyCalls = [];
        const { server } = makeServer(board, {
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['Coder 1'],
            onWorkingStateCleared: () => { clearedCalls.push('fired'); },
            onTurnEndNotify: (info) => { notifyCalls.push(info); },
            db: {
                clearOwnerStamp: async () => { held.ownerSince = null; held.ownerSeat = ''; return true; },
                getPlanByPlanId: async (planId) => board.find(p => p.planId === planId),
                updateColumnByPlanFile: async () => { held.kanbanColumn = 'STAGING'; return true; },
                setColumnOrders: async () => true,
            },
        });
        await server.reportQueueDone({ workspaceRoot: WS, from: 'Coder 1', outcome: 'failed', planId: 'held-failed' });
        assert.deepStrictEqual(notifyCalls, [], 'onTurnEndNotify must NOT report a failure as outcome completed');
        assert.deepStrictEqual(clearedCalls, [], 'onWorkingStateCleared must NOT fire for a failed report');
    });

    await check('a released card pops the next card and arms the watch on dispatch', async () => {
        // V81 deleted the in-flight 409. A head-paced team member reporting
        // done releases its card and the pop immediately hands out the next
        // one; a successful dispatch arms the watch with onDispatch.
        const held = card('held-inflight', 'CODER CODED', {
            ownerSince: '2026-08-20T00:00:00Z',
            ownerSeat: 'Coder 1',
            planFile: '/tmp/held-inflight.md',
            workspaceId: 'ws1',
        });
        const board = [held, card('next-inflight', 'STAGING', { columnOrder: 2 })];
        const arms = [];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Lead 1', 'Coder 1'],
            resolveTeamPacing: async () => 'head',
            armQueueWatch: async (wsRoot, headTerminal, o) => { arms.push({ wsRoot, headTerminal, o }); },
            db: {
                clearOwnerStamp: async () => { held.ownerSince = null; held.ownerSeat = ''; return true; },
            },
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'Coder 1', planId: 'held-inflight' });
        assert.strictEqual(out.status, 200, 'the done call succeeds');
        assert.strictEqual(out.payload.success, true, 'a released card is a success');
        assert.deepStrictEqual(dispatched, ['next-inflight'], 'the pop hands out the next card — no refusal');
        assert.ok(arms.some(a => a.o && a.o.onDispatch === true),
            'a successful dispatch arms the queue watch');
    });

    await check('the global completion order is installed in the fleet orders database and stays idempotent', async () => {
        const board = [card('next', 'STAGING', { columnOrder: 1 })];
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
        assert.ok(rendered.includes(' done.'),
            'global completion order must render for every terminal');
        assert.ok(!/done --from/.test(rendered),
            'the seat supplies no --from: the CLI resolves it from SWITCHBOARD_TERMINAL');
        // The fragments carry a `<cliPath>` token because they are module
        // constants with byte-identical webview mirrors. renderStandaloneOrdersBlock
        // is the emission seam that resolves it — an unsubstituted token hands the
        // agent `node "<cliPath>" submit …`, a command that cannot run, and the
        // completion signal is lost silently.
        assert.ok(!rendered.includes('<cliPath>'),
            'the <cliPath> token must be substituted at the standing-orders emission seam');
        assert.ok(/run "[^"]+" done\./.test(rendered),
            'the rendered order must name a concrete quoted CLI path — the token is substituted with the platform binary (e.g. dist/<platform>/switchboard) or cli.js, never left as <cliPath>');
    });

    await check('a failed dispatch is passed through and consumes nothing', async () => {
        const board = [card('next', 'STAGING', { columnOrder: 1 })];
        const { server } = makeServer(board);
        server.performKanbanDispatch = async () => ({ status: 409, payload: { success: false, error: 'No terminal agent is live right now' } });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 409, 'the underlying failure status is passed through unchanged');
        assert.ok(/No terminal agent/.test(out.payload.error || ''), 'the underlying error text is preserved');
    });

    await check('a failed escalated dispatch retains its stronger-seat override for retry', async () => {
        const failed = card('failed', 'CODER CODED', {
            ownerSince: '2026-08-20T00:00:00Z',
            ownerSeat: 'Coder 1',
            planFile: '/tmp/failed.md',
            workspaceId: 'ws1',
        });
        const board = [failed, card('next', 'STAGING', { columnOrder: 2 })];
        const { server } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1', 'Lead 1'],
            resolveTeamPacing: async () => 'seat',
            // V81: `routed_to` is gone — the failed rung is derived from the
            // card's coding column through the same dispatch gate the pop uses.
            resolveKanbanDispatch: async (_ws, column) => ({
                role: column === 'CODER CODED' ? 'coder' : column === 'INTERN CODED' ? 'intern' : 'lead',
            }),
            db: {
                clearOwnerStamp: async () => { failed.ownerSeat = ''; failed.ownerSince = null; return true; },
                getPlanByPlanId: async (planId) => board.find(p => p.planId === planId),
                updateColumnByPlanFile: async () => { failed.kanbanColumn = 'STAGING'; return true; },
                setColumnOrders: async (_wsId, ids) => {
                    ids.forEach((id, index) => { const row = board.find(p => p.planId === id); if (row) row.columnOrder = index + 1; });
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
        // 200: the done call did its job. The dispatch failure is the NEXT
        // dispatch's problem and is reported under `next`.
        assert.strictEqual(failedAttempt.status, 200);
        assert.strictEqual(failedAttempt.payload.next?.status, 409);
        assert.strictEqual(failedAttempt.payload.next?.inFlight, undefined, 'no team was in flight — do not invent one');
        assert.strictEqual(failedAttempt.payload.reason, 'next dispatch failed');
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

    await check('escalation round trip: fail -> re-stage -> holder released -> pop dispatches', async () => {
        const failed = card('failed-card', 'INTERN CODED', {
            ownerSince: '2026-08-20T00:00:00Z',
            ownerSeat: 'Intern 1',
            planFile: '/tmp/failed-card.md',
            workspaceId: 'ws1',
        });
        const board = [failed, card('other', 'STAGING', { columnOrder: 2 })];
        let holderReleased = false;
        const { server, dispatched, dispatchOptions } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Intern 1', 'Coder 1'],
            resolveTeamPacing: async () => 'seat',
            resolveKanbanDispatch: async (_ws, column) => ({
                role: column === 'CODER CODED' ? 'coder' : column === 'INTERN CODED' ? 'intern' : 'lead',
            }),
            db: {
                clearOwnerStamp: async () => {
                    holderReleased = true;
                    failed.ownerSeat = '';
                    failed.ownerSince = null;
                    return true;
                },
                getPlanByPlanId: async (planId) => board.find(p => p.planId === planId),
                updateColumnByPlanFile: async () => { failed.kanbanColumn = 'STAGING'; return true; },
                setColumnOrders: async (_wsId, ids) => {
                    ids.forEach((id, index) => { const row = board.find(p => p.planId === id); if (row) row.columnOrder = index + 1; });
                    return true;
                },
            },
        });
        const doneRes = await server.reportQueueDone({ workspaceRoot: WS, from: 'Intern 1', outcome: 'failed', planId: 'failed-card' });
        assert.strictEqual(doneRes.status, 200);
        assert.strictEqual(holderReleased, true, 'clearOwnerStamp must have been called on the failed card');
        assert.strictEqual(failed.kanbanColumn, 'STAGING');
        assert.strictEqual(failed.ownerSeat, '');
        assert.deepStrictEqual(dispatched, ['failed-card'], 'immediately following pop must dispatch the re-staged card');
        assert.deepStrictEqual(dispatchOptions[0].targetColumn, 'CODER CODED', 'stepped up to coder');
    });

    await check('a card re-staged by watch (empty holder) is not re-staged a second time by the ladder', async () => {
        const failed = card('already-restaged', 'STAGING', {
            ownerSince: null,
            ownerSeat: '',
            planFile: '/tmp/already-restaged.md',
            workspaceId: 'ws1',
        });
        const board = [failed, card('next-in-line', 'STAGING', { columnOrder: 1 })];
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

    await check('the in-flight refusal is deleted from LocalApiServer', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        // V81 deleted the concept outright: no predicate, no helper, no 409 arm.
        assert.ok(!/\bresolveTeamInFlight\b/.test(src), 'resolveTeamInFlight must be deleted');
        assert.ok(!/\bheldByTeam\b/.test(src), 'heldByTeam must be deleted');
        assert.ok(!/Team already in flight/.test(src), 'the in-flight 409 body must be deleted');
        assert.ok(!/return fail\(409, `Team already in flight/.test(src), 'no in-flight refusal arm may remain');
        // The pop must decide eligibility on completion, never on a column.
        const popStart = src.indexOf('private async _runQueuePop(');
        const popBody = src.slice(popStart, src.indexOf('\n    /**', popStart + 10));
        assert.ok(!/CODING_COLUMNS/.test(popBody), 'the pop must not decide eligibility from a column');

        // V81 deleted the TEAM-WIDE in-flight refusal, and it stays deleted. What
        // Mission 04 added is a different animal and the two must not be confused:
        // a mission's declared CADENCE ("Coding one, Feature five") holds the next
        // release while that mission's own members are still out. It is scoped to
        // one mission, derived from those members' asserted completion on the
        // board — never from a stored ledger — and it opens the moment the card
        // completes, which is precisely why it cannot wedge the way the ledger gate
        // did (round 1 stamped 'dispatched', never closable, every later round
        // skipped).
        //
        // So the ratchet is on the SHAPE, not the word: every in-flight refusal the
        // pop returns names its mission, and none is read from a ledger. A
        // workspace-wide refusal cannot grow back under this wording without
        // failing here.
        const inFlightRefusals = popBody.match(/reason: `[^`]*in flight[^`]*`/g) || [];
        assert.ok(inFlightRefusals.length > 0,
            'the mission cadence refusal must exist — Mission 04 is what makes "Coding one" one');
        for (const refusal of inFlightRefusals) {
            assert.ok(/\$\{missionId\}/.test(refusal),
                `every in-flight refusal must name its mission, or it is the workspace-wide gate again: ${refusal}`);
        }
        assert.ok(!/in_flight/.test(popBody),
            'in-flight must be derived from the board, never read from a stored ledger');
        // And it must be unreachable without a mission: an unscoped pop refuses nothing.
        assert.ok(/if \(missionId && missionStage && inFlightMembers\.length > 0\)/.test(popBody),
            'the cadence refusal must be gated on a mission — an unscoped pop carries no in-flight concept');
    });

    await check('the rounds path refuses no dispatch either', () => {
        // The ratchet above was written against one exact string ('Team already
        // in flight') on the CARD path, so an identical gate grew back on the
        // ROUND path and wedged a feature for a day: round 1 stamped
        // 'dispatched' on 2026-09-15 with nothing delivered, never closable,
        // and every later round/register skipped the dispatch because a kept
        // round was 'in flight'. The board never refuses a dispatch — that is
        // the invariant, not the absence of one spelling of it.
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');

        // round/register must start a round unconditionally.
        const regStart = src.indexOf('private async _handleKanbanRoundRegister(');
        assert.ok(regStart > -1, '_handleKanbanRoundRegister must exist');
        const regBody = src.slice(regStart, src.indexOf('\n    /**', regStart + 10));
        assert.ok(!/const inFlight\b/.test(regBody),
            'round/register must carry no in-flight predicate — a kept dispatched round must not suppress the dispatch');
        assert.ok(!/if \(!inFlight/.test(regBody),
            'round/register must not gate its dispatch on anything being in flight');

        // round/complete must close the round it is given, never 409 on an
        // ambiguous set — the only way to reduce the in-flight count is to
        // close one, so refusing here is a wedge with no recovery path.
        const compStart = src.indexOf('private async _handleKanbanRoundComplete(');
        if (compStart > -1) {
            const compBody = src.slice(compStart, src.indexOf('\n    /**', compStart + 10));
            assert.ok(!/refusing to close an ambiguous round set/.test(compBody),
                'round/complete must not refuse an ambiguous round set — take the lowest ordinal and log it');
        }
        assert.ok(!/refusing to close an ambiguous round set/.test(src),
            'the ambiguous-round-set refusal body must be deleted');
    });

    await check('a held card does not release the team on a stale completion — dispatch just proceeds', async () => {
        // V81: there is no team to "release". The old scan stopped the whole
        // pop when a second card was held; now the pop simply hands out the
        // next staged card, and a completion that landed after the board read
        // changes nothing about eligibility.
        const board = [
            card('stale', 'CODE REVIEWED', { ownerSeat: 'Coder 1', ownerSince: '2026-08-20T00:00:00Z', completedAt: null }),
            card('wip', 'CODER CODED', { ownerSeat: 'Coder 2', ownerSince: '2026-08-20T00:00:00Z', completedAt: null }),
            card('next', 'STAGING', { columnOrder: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1', 'Coder 2'],
            db: {
                // Canonical read: 'stale' was completed after the board snapshot.
                getPlanByPlanId: async (planId) => {
                    const row = board.find(p => p.planId === planId);
                    if (!row) { return null; }
                    return planId === 'stale'
                        ? { ...row, completedAt: '2026-08-25T00:00:00Z' }
                        : { ...row };
                },
            },
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200, 'the pop never refuses on ownership');
        assert.deepStrictEqual(dispatched, ['next'], 'the next staged card is handed out');
        assert.strictEqual(out.payload.inFlight, undefined, 'no in-flight bookkeeping exists');
    });

    await check('a candidate that re-reads as completed does not block the pop', async () => {
        const board = [
            card('stale', 'CODE REVIEWED', { ownerSeat: 'Coder 1', completedAt: null }),
            card('next', 'STAGING', { columnOrder: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
            db: {
                getPlanByPlanId: async (planId) => {
                    const row = board.find(p => p.planId === planId);
                    if (!row) { return null; }
                    return planId === 'stale'
                        ? { ...row, completedAt: '2026-08-25T00:00:00Z' }
                        : { ...row };
                },
            },
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200, `expected the next card, got ${out.status}: ${out.payload.error || ''}`);
        assert.deepStrictEqual(dispatched, ['next'], 'a completion posted after the board read releases the team');
    });

    await check('concurrent pops are serialized — one card, one dispatch', async () => {
        const board = [card('only', 'STAGING', { columnOrder: 1 })];
        const { server, dispatched } = makeServer(board);
        // Drain the card inside the critical section, exactly as a real
        // dispatch does by moving it out of STAGING.
        server.performKanbanDispatch = async (workspaceRoot, planId) => {
            await new Promise(r => setTimeout(r, 10));
            const row = board.find(p => p.planId === planId);
            if (row) { row.kanbanColumn = 'CODER CODED'; row.ownerSeat = 'Coder 1'; }
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
        assert.ok(!/_terminalAgentInfo/.test(resolver), 'Teams are PTY-only — no VS Code terminal cache fallback');
        assert.ok(/\[\.\.\.leads\]\.sort\(\)\.concat\(\[\.\.\.coders\]\.sort\(\)\)/.test(resolver),
            'live coding terminals must remain deterministic with leads before coders');
        assert.ok(/role === 'lead'/.test(resolver) && /role === 'coder'/.test(resolver));

        const kanbanProvider = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
        const runStart = kanbanProvider.indexOf("case 'runQueue':");
        const runQueue = kanbanProvider.slice(runStart, kanbanProvider.indexOf("case '", runStart + 20));
        assert.ok(/getAliveCodingTerminalNames\(\)/.test(runQueue));
        // The refusal NAMES THE KIND and the team that would have taken it. "No
        // coding terminal is live" told the operator to open a coder when the
        // right move is to start the team that accepts plans — the routing
        // resolver knows which team that is, so the message says so.
        assert.ok(/No team is live to take a plan dispatch/.test(runQueue),
            'the Run-queue refusal must name the work kind and the team that would have taken it');
        assert.ok(/readTeamAcceptedKinds/.test(runQueue),
            'the team named in the refusal must be DERIVED from the defaults that declare the kind, not typed into the message');

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
        assert.ok(/_queueTeamMembersResolver/.test(body) && /teamMembers\.has\(p\.ownerSeat\)/.test(body),
            "a seat-paced watch must select a held card from its own team, not another team's first active card");
        // The head-pacing branch must also use the team resolver for in-flight
        // detection (not just `=== watch.headTerminal`).
        assert.ok(/headTeamSet\.has\(p\.ownerSeat\)/.test(body),
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
        // The clock-driven `_scheduleQueuePop` was deleted in 25fdb6d9 along with
        // the autoban engine it hung on: scheduling consolidated onto team
        // automations and Mission Control Schedules, and a job now fires on team
        // RELEASE (LocalApiServer's onTeamReleased → clearAdvanceWhenReadyJobs
        // zeroes lastRunAt) rather than on a tick. `runSchedulerJob` is the
        // surviving caller. What this contract protects is unchanged and is the
        // reason it is not simply deleted: whatever fires the schedule must reach
        // the queue through the ONE pop, resolve its head the same way every other
        // caller does, and own no in-flight bookkeeping of its own — the pop's 409
        // is the only gate. Repoint this at the current entry point when the
        // scheduling surface moves again; do not drop the assertions.
        assert.ok(!src.includes('_scheduleQueuePop'),
            'the clock-driven _scheduleQueuePop must stay deleted — a job fires on team release, not on a tick');
        const i = src.indexOf('public async runSchedulerJob(');
        assert.notStrictEqual(i, -1, 'runSchedulerJob must exist — it is the schedule\'s route to the pop');
        const body = src.slice(i, src.indexOf('\n    /**', i + 10));
        assert.ok(/dispatchNextFromQueue\(/.test(body), 'the schedule must dispatch through the pop');
        assert.ok(!/_autobanLaneInFlight/.test(body) && !/whenSchedule.*suppress/i.test(body),
            "the pop's 409 replaces every suppression guard — no lane map, no mutual disabling");
        assert.ok(/resolveImplementationHead|resolveCodingHeadFromGroups/.test(body),
            'the schedule must resolve its head the same way Run queue, staging and the watch do — the state.json registry cannot see a pty-fleet team. '
            + 'A queue pop is a PLAN dispatch, so the current resolver is resolveImplementationHead(root, \'plan\'): with both implementation teams live, '
            + 'role order alone hands every pop to the Feature team\'s lead and the Coding team sits idle.');
        // The release-driven trigger is the other half of the retired clock: without
        // it an advance-when-ready job never re-fires and the queue stops silently.
        assert.ok(/onTeamReleased:[\s\S]{0,160}clearAdvanceWhenReadyJobs\(/.test(src),
            'onTeamReleased must be wired to clearAdvanceWhenReadyJobs — team release is what re-arms an advance-when-ready job now that the clock is gone');
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

    await check('auto mode updates group config and UI state', () => {
        const fs = require('fs');
        const webview = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'terminals.js'), 'utf8');
        const modeStart = webview.indexOf('async function setQueueMode(mode)');
        const mode = webview.slice(modeStart, webview.indexOf('\n    /**', modeStart + 10));
        assert.ok(/_queueMode = mode/.test(mode));
        assert.ok(/!res\.ok \|\| !data\?\.success/.test(mode), 'a failed mode write must be surfaced');
        const wiring = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'standingOrderFragments.ts'), 'utf8');
        assert.ok(/export function buildMemberCompletionFragment/.test(wiring));
    });

    // ── Standalone host: the four queue seams + armQueueWatch ─────────────
    //
    // The standalone (npx) host shared the same PlanIngestionEngine but never
    // wired the four queue seams or supplied armQueueWatch. The seams resolved
    // to nothing and no watch was ever armed — the sweep read an empty list
    // every tick. These assertions pin the wiring so a future refactor cannot
    // silently drop it (the host-seam-parity guard catches the cross-root
    // divergence; these assertions catch a within-standalone regression).

    await check('standalone bootstrap wires all four queue seams on ingestionEngine', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'standalone', 'bootstrap.ts'), 'utf8');
        for (const seam of [
            'setQueueHeadResolver',
            'setQueuePacingResolver',
            'setQueueTeamMembersResolver',
            'setQueueEscalationRecorder',
        ]) {
            assert.ok(
                new RegExp(`ingestionEngine\\.${seam}\\s*\\(`).test(src),
                `bootstrap.ts must wire ingestionEngine.${seam}(...) — without it the queue nudge sweep has no resolver and degrades silently`
            );
        }
    });

    await check('standalone bootstrap supplies armQueueWatch in the LocalApiServer options', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'standalone', 'bootstrap.ts'), 'utf8');
        // The options object is passed to `new LocalApiServer(options)`. The
        // armQueueWatch field's body must call ingestionEngine.armQueueWatch —
        // without it the dispatch (:2231) and release (:3183) arm sites are
        // both inert (behind `if (this._options.armQueueWatch)`) and
        // kanban.queueWatches is never written. Layer 2 of the gap.
        assert.ok(/armQueueWatch\s*:/.test(src),
            'bootstrap.ts must define an armQueueWatch field in the LocalApiServer options');
        assert.ok(/ingestionEngine\.armQueueWatch\s*\(/.test(src),
            'the armQueueWatch callback must call ingestionEngine.armQueueWatch(...) — the single arming route');
    });

    await check('standalone bootstrap does NOT reference _globalPlanWatcher (one arming route per host)', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'standalone', 'bootstrap.ts'), 'utf8');
        // Strip comments first. The invariant is about CODE — naming the
        // extension-only field in a comment that explains why standalone does
        // not use it is the opposite of a violation, and a raw substring scan
        // cannot tell the two apart.
        const code = src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');
        assert.ok(!/_globalPlanWatcher/.test(code),
            'bootstrap.ts must not reference _globalPlanWatcher — the extension-only indirection path. One arming route per host; two that can disagree is the thing to avoid.');
    });

    await check('standalone escalation recorder resolves server lazily at call time, not wiring time', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'standalone', 'bootstrap.ts'), 'utf8');
        // The escalation recorder is wired before `new LocalApiServer(options)`
        // runs, so `server` is declared but unassigned at wiring time. The
        // callback must reference `server` INSIDE the async body (call-time
        // resolution), not capture it in a local at wiring time. Capturing at
        // wiring time binds undefined and silently no-ops forever — the exact
        // Promise<void> failure mode this plan exists to close.
        const i = src.indexOf('ingestionEngine.setQueueEscalationRecorder(');
        assert.notStrictEqual(i, -1, 'setQueueEscalationRecorder call must exist');
        // Grab the callback body — from the call to the closing `});`
        const bodyStart = src.indexOf('=>', i);
        const bodyEnd = src.indexOf('});', i);
        assert.notStrictEqual(bodyStart, -1, 'escalation recorder callback body start must be found');
        assert.notStrictEqual(bodyEnd, -1, 'escalation recorder callback body end must be found');
        const body = src.slice(bodyStart, bodyEnd);
        assert.ok(/\bserver\b/.test(body),
            'the escalation recorder callback must reference `server` inside the async body (lazy call-time resolution)');
        // The truthiness check is load-bearing — `server` is undefined at
        // wiring time and only assigned at `new LocalApiServer(options)`.
        assert.ok(/if\s*\(\s*server\b/.test(body),
            'the escalation recorder must guard on `server` truthiness before dereferencing — the check is load-bearing, not defensive noise');
    });

    await check('standalone team-members resolver uses taskViewerProvider.resolveTeamMembers with a null guard', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'standalone', 'bootstrap.ts'), 'utf8');
        // Byte-symmetric with extension.ts:1126, plus the null guard standalone
        // needs (taskViewerProvider is `TaskViewerProvider | null`). The
        // positive assertion confirms the provider method is used; the null-
        // guard assertion confirms `taskViewerProvider` is checked for
        // truthiness before dereferencing.
        const i = src.indexOf('ingestionEngine.setQueueTeamMembersResolver(');
        assert.notStrictEqual(i, -1, 'setQueueTeamMembersResolver call must exist');
        const bodyStart = src.indexOf('=>', i);
        const bodyEnd = src.indexOf('});', i);
        const body = src.slice(bodyStart, bodyEnd);
        assert.ok(/taskViewerProvider\.resolveTeamMembers/.test(body),
            'the team-members resolver must call taskViewerProvider.resolveTeamMembers — byte-symmetric with extension.ts:1126');
        assert.ok(/taskViewerProvider\s*\?/.test(body) || /if\s*\(\s*taskViewerProvider\b/.test(body),
            'the team-members resolver must null-guard taskViewerProvider before dereferencing — it is `TaskViewerProvider | null` in standalone');
    });

    await check('standalone arms the watch on stageForQueue, not only on dispatch/release', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'standalone', 'bootstrap.ts'), 'utf8');
        // KanbanProvider.stageForQueue's own arm resolves the engine through
        // `_globalPlanWatcher`, which standalone never sets — so the shared
        // provider's staging arm is inert in this host. The LocalApiServer
        // dispatch (:2231) and release (:3183) arms cover a queue that RAN;
        // neither covers a queue staged and never run, which is the case the
        // staging arm exists for ("every staging path arms the watch" above).
        // bootstrap must arm on the stageForQueue verb through the same
        // ingestionEngine.armQueueWatch route.
        const i = src.indexOf(`verb === 'stageForQueue'`);
        assert.notStrictEqual(i, -1,
            'bootstrap.ts must arm the queue watch on the stageForQueue verb — dispatch-only arming leaves a staged-but-never-run queue unwatched in standalone');
        const body = src.slice(i, i + 900);
        assert.ok(/ingestionEngine\.armQueueWatch\s*\(/.test(body),
            'the staging arm must go through ingestionEngine.armQueueWatch — the same route the dispatch and release arms use, not a second one that can disagree');
        assert.ok(/resolveImplementationHead\s*\(|resolveCodingHeadFromGroups\s*\(/.test(body),
            'the staging arm must resolve the head from terminals.groups, matching KanbanProvider.stageForQueue — not getAliveRoleTerminalNames (deprecated state.json). '
            + 'Kind is \'plan\': a queue pop dispatches single plans.');
    });

    await check('the host-seam-parity guard script exists and is wired into CI', () => {
        const fs = require('fs');
        const scriptPath = path.join(process.cwd(), 'scripts', 'check-host-seam-parity.js');
        assert.ok(fs.existsSync(scriptPath),
            'scripts/check-host-seam-parity.js must exist — the composition-root parity guard');
        const pkg = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8');
        assert.ok(/"host-seam-parity:check"\s*:\s*"node scripts\/check-host-seam-parity\.js"/.test(pkg),
            'package.json must define host-seam-parity:check — a script without a workflow step is the green-while-incomplete hole');
        const workflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'integration-tests.yml'), 'utf8');
        assert.ok(/host-seam-parity:check/.test(workflow),
            'integration-tests.yml must run host-seam-parity:check — defining the script without the workflow step is the green-while-incomplete hole');
    });

    // ── Dead-pacer alert budget (Option B + B2 + C) ──────────────────────
    //
    // The dead-pacer alert had no one-shot guard of its own and spent the
    // agent nudge's `nudgeCount` budget. Option B gives it a budget keyed on
    // (seat, card); B2 widens the recorder seam to Promise<boolean> so a
    // silent release failure is distinguishable from success; C decouples
    // `nudgeCount` from both operator alerts. These assertions pin all three.

    await check('the dead-pacer block is guarded by deadPacerAlertedFor', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'PlanIngestionEngine.ts'), 'utf8');
        const i = src.indexOf('private async _runQueueNudgeSweep(');
        assert.notStrictEqual(i, -1, '_runQueueNudgeSweep must exist');
        const body = src.slice(i, src.indexOf('\n    private ', i + 10));
        // The dead-pacer block is the one containing pacerLive.status ===
        // 'exited'. It must compare watch.deadPacerAlertedFor to a
        // `${pacerSeat}:${planId}` key before notifying.
        const exitedIdx = body.indexOf("pacerLive.status === 'exited'");
        assert.notStrictEqual(exitedIdx, -1, 'dead-pacer block (pacerLive.status === exited) must exist');
        // Grab from the exited check to the next continue after it — that
        // span covers the whole dead-pacer block including the guard.
        const blockEnd = body.indexOf('continue;', exitedIdx);
        const block = body.slice(exitedIdx, blockEnd);
        assert.ok(/deadPacerAlertedFor/.test(block),
            'the dead-pacer block must compare watch.deadPacerAlertedFor to a (seat, card) key before notifying — Option B');
        assert.ok(/`\$\{pacerSeat\}:\$\{heldCard\.planId\}`/.test(block),
            'the dead-pacer key must be `${pacerSeat}:${heldCard.planId}` — keyed on identity, not a shared boolean');
    });

    await check('neither operator alert block increments nudgeCount (Option C)', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'PlanIngestionEngine.ts'), 'utf8');
        const i = src.indexOf('private async _runQueueNudgeSweep(');
        assert.notStrictEqual(i, -1, '_runQueueNudgeSweep must exist');
        const body = src.slice(i, src.indexOf('\n    private ', i + 10));
        // The no-pacer block: from "No pacer" comment to its continue.
        const noPacerStart = body.indexOf('// (3 re-pointed) No pacer');
        assert.notStrictEqual(noPacerStart, -1, 'no-pacer block must exist');
        const noPacerEnd = body.indexOf('continue;', noPacerStart);
        const noPacerBlock = body.slice(noPacerStart, noPacerEnd);
        assert.ok(!/nudgeCount\s*=/.test(noPacerBlock),
            'the no-pacer alert block must not increment nudgeCount — it is the agent nudge budget, not the operator alert budget (Option C)');
        // The dead-pacer block: from pacerLive.status === 'exited' to its
        // continue (the one OUTSIDE the guard).
        const deadStart = body.indexOf("pacerLive.status === 'exited'");
        const deadEnd = body.indexOf('continue;', deadStart);
        const deadBlock = body.slice(deadStart, deadEnd);
        assert.ok(!/nudgeCount\s*=/.test(deadBlock),
            'the dead-pacer alert block must not increment nudgeCount — it is the agent nudge budget, not the operator alert budget (Option C)');
    });

    await check('armQueueWatch onDispatch deletes deadPacerAlertedFor alongside escalatedAt and noHeadNotifiedAt', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'PlanIngestionEngine.ts'), 'utf8');
        const armIdx = src.indexOf('public async armQueueWatch(');
        assert.notStrictEqual(armIdx, -1, 'armQueueWatch must exist');
        const armBody = src.slice(armIdx, src.indexOf('\n    private ', armIdx + 10));
        const onDispatchIdx = armBody.indexOf('if (opts?.onDispatch)');
        assert.notStrictEqual(onDispatchIdx, -1, 'onDispatch branch must exist');
        // Walk brace depth to the branch's matching close. A fixed-width
        // window is a trap: the branch opens with a four-line comment, so any
        // constant large enough today truncates the moment a line is added.
        const onDispatchOpen = armBody.indexOf('{', onDispatchIdx);
        let odDepth = 0;
        let onDispatchClose = -1;
        for (let j = onDispatchOpen; j < armBody.length; j++) {
            if (armBody[j] === '{') odDepth++;
            else if (armBody[j] === '}') { odDepth--; if (odDepth === 0) { onDispatchClose = j; break; } }
        }
        assert.notStrictEqual(onDispatchClose, -1, 'the onDispatch branch must have a matching close brace');
        const onDispatchBlock = armBody.slice(onDispatchIdx, onDispatchClose + 1);
        assert.ok(/delete rearmed\.escalatedAt/.test(onDispatchBlock),
            'onDispatch must delete escalatedAt');
        assert.ok(/delete rearmed\.noHeadNotifiedAt/.test(onDispatchBlock),
            'onDispatch must delete noHeadNotifiedAt');
        assert.ok(/delete rearmed\.deadPacerAlertedFor/.test(onDispatchBlock),
            'onDispatch must delete deadPacerAlertedFor alongside the other one-shot stamps — a dispatch re-arms all alert budgets');
    });

    await check('the dead-pacer continue is outside the alert guard, not inside it', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'PlanIngestionEngine.ts'), 'utf8');
        const i = src.indexOf('private async _runQueueNudgeSweep(');
        assert.notStrictEqual(i, -1, '_runQueueNudgeSweep must exist');
        const body = src.slice(i, src.indexOf('\n    private ', i + 10));
        const exitedIdx = body.indexOf("pacerLive.status === 'exited'");
        assert.notStrictEqual(exitedIdx, -1, 'dead-pacer block must exist');
        // The guard is `if (watch.deadPacerAlertedFor !== deadPacerKey)`.
        // The `continue` must come AFTER the guard's closing brace, not
        // inside it. If the continue is inside the guard, a suppressed
        // alert falls through to gates 6/7/8 and nudges a dead terminal.
        const guardIdx = body.indexOf('watch.deadPacerAlertedFor !== deadPacerKey', exitedIdx);
        assert.notStrictEqual(guardIdx, -1, 'the dead-pacer guard must exist');
        // Walk brace depth from the guard's opening `{` to find its matching
        // close — a naive indexOf('}') hits a nested block.
        const openBrace = body.indexOf('{', guardIdx);
        let depth = 0;
        let guardClose = -1;
        for (let j = openBrace; j < body.length; j++) {
            if (body[j] === '{') depth++;
            else if (body[j] === '}') { depth--; if (depth === 0) { guardClose = j; break; } }
        }
        assert.notStrictEqual(guardClose, -1, 'the dead-pacer guard block must have a matching close brace');
        // The guard's own block must NOT contain a bare continue.
        const guardBlock = body.slice(guardIdx, guardClose + 1);
        assert.ok(!/\bcontinue\b/.test(guardBlock),
            'the alert guard block must not contain a continue — the continue belongs outside so every dead-pacer tick short-circuits the gates');
        // The RECOVERY must also stay outside the guard. The one-shot budget
        // belongs to the operator notice, not to the release attempt: a
        // transient release failure recovers on the next tick, and muting the
        // retry alongside the notice pins the card in its coding column with
        // `dispatched_at` set until a human intervenes.
        assert.ok(!/_queueEscalationRecorder/.test(guardBlock),
            'the escalation recorder call must be OUTSIDE the alert guard — one-shotting the recovery attempt alongside the notice removes the only retry a transient release failure has');
        const preGuard = body.slice(exitedIdx, guardIdx);
        assert.ok(/_queueEscalationRecorder/.test(preGuard),
            'the escalation recorder must be called before the alert guard, on every dead-pacer tick — its result is what selects the notice text');
        // After the guard closes, kept.push(watch) and continue must follow.
        const afterGuard = body.slice(guardClose + 1);
        const keptIdx = afterGuard.indexOf('kept.push(watch)');
        const continueIdx = afterGuard.indexOf('continue;', keptIdx);
        assert.ok(keptIdx !== -1 && continueIdx !== -1 && continueIdx > keptIdx,
            'kept.push(watch) and continue must appear after the guard closes — the continue is outside the guard');
    });

    await check('the escalation recorder seam is Promise<boolean>, not Promise<void> (B2)', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'PlanIngestionEngine.ts'), 'utf8');
        // The field declaration and the setter must both be Promise<boolean>.
        assert.ok(/_queueEscalationRecorder\?\:\s*\(workspaceRoot:\s*string,\s*planId:\s*string,\s*fromSeat:\s*string\)\s*=>\s*Promise<boolean>/.test(src),
            'the _queueEscalationRecorder field must be typed Promise<boolean> — a Promise<void> seam where "did nothing" and "worked" are the same value is the hole B2 closes');
        assert.ok(/setQueueEscalationRecorder\(fn:\s*\(workspaceRoot:\s*string,\s*planId:\s*string,\s*fromSeat:\s*string\)\s*=>\s*Promise<boolean>\)/.test(src),
            'the setQueueEscalationRecorder setter must accept Promise<boolean>');
    });

    await check('both host wirings return payload.released, not discard the result (B2)', () => {
        const fs = require('fs');
        // The wiring body ends at the arrow function's matching close paren.
        // indexOf('});') is a trap: it lands on `planId });` INSIDE the
        // reportQueueDone call and truncates the body before the return.
        const wiringBody = (src, label) => {
            const i = src.indexOf('setQueueEscalationRecorder(');
            assert.notStrictEqual(i, -1, `${label} must wire setQueueEscalationRecorder`);
            const open = src.indexOf('(', i);
            let depth = 0;
            for (let j = open; j < src.length; j++) {
                if (src[j] === '(') depth++;
                else if (src[j] === ')') { depth--; if (depth === 0) return src.slice(i, j + 1); }
            }
            assert.fail(`${label} setQueueEscalationRecorder call must have a matching close paren`);
        };
        // `payload.released` is the released card id, set ONLY after
        // clearWorkingState made a real non-NULL→NULL transition. NOT
        // `payload.cleared`: that is the clearTerminalContext result, gated on
        // `!isTeamMember` in _runQueueDone, so it is hardcoded false for every
        // team seat — and seat pacing IS a team feature. Reading `cleared`
        // makes the notice claim "could not be released" on every successful
        // release, which is the same false-claim bug pointing the other way.
        for (const [file, label] of [
            [path.join(process.cwd(), 'src', 'extension.ts'), 'extension'],
            [path.join(process.cwd(), 'src', 'standalone', 'bootstrap.ts'), 'standalone'],
        ]) {
            const body = wiringBody(fs.readFileSync(file, 'utf8'), label);
            assert.ok(/return\s+!!\(result\?\.payload\?\.released\)/.test(body),
                `${label} wiring must return !!(result?.payload?.released) — discarding the reportQueueDone result is the Promise<void> failure mode`);
            assert.ok(!/payload\?\.cleared/.test(body),
                `${label} wiring must NOT read payload.cleared — it is the clearTerminalContext result, gated on !isTeamMember, so it is always false for the seat-paced team case`);
        }
    });

    await check('the dead-pacer notice text branches on the release result (B2)', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'PlanIngestionEngine.ts'), 'utf8');
        const i = src.indexOf('private async _runQueueNudgeSweep(');
        assert.notStrictEqual(i, -1, '_runQueueNudgeSweep must exist');
        const body = src.slice(i, src.indexOf('\n    private ', i + 10));
        const exitedIdx = body.indexOf("pacerLive.status === 'exited'");
        const deadEnd = body.indexOf('continue;', exitedIdx);
        const block = body.slice(exitedIdx, deadEnd);
        // The notice body must branch on `released` — true says "will be
        // re-staged", false says "could not be released".
        assert.ok(/released\s*\?/.test(block),
            'the dead-pacer notice body must branch on the release result — true and false carry different text (B2)');
        assert.ok(/will be re-staged/.test(block),
            'the released=true notice must say "will be re-staged to a stronger seat"');
        assert.ok(/could not be released/.test(block),
            'the released=false notice must say "could not be released" — the now-false "will be re-staged" claim must not repeat');
    });

    // ── Complexity routing degrades across the live pool ──────────────────
    //
    // The only other coverage of this function lives in
    // src/test/kanban-complexity.test.ts, which runs under `npm test`
    // (vscode-test) — a script no CI workflow invokes. Without these
    // assertions the degradation ladder is unguarded in CI.

    await check('resolveRoleWithDegradation returns the preferred role when it is live', () => {
        for (const r of ['intern', 'coder', 'lead']) {
            assert.strictEqual(resolveRoleWithDegradation(r, new Set(['intern', 'coder', 'lead'])), r);
            assert.strictEqual(resolveRoleWithDegradation(r, new Set([r])), r);
        }
    });

    await check('resolveRoleWithDegradation degrades outward, upward first', () => {
        // intern prefers up
        assert.strictEqual(resolveRoleWithDegradation('intern', new Set(['coder'])), 'coder');
        assert.strictEqual(resolveRoleWithDegradation('intern', new Set(['lead'])), 'lead');
        assert.strictEqual(resolveRoleWithDegradation('intern', new Set(['coder', 'lead'])), 'coder');
        // lead degrades down
        assert.strictEqual(resolveRoleWithDegradation('lead', new Set(['coder'])), 'coder');
        assert.strictEqual(resolveRoleWithDegradation('lead', new Set(['intern'])), 'intern');
        assert.strictEqual(resolveRoleWithDegradation('lead', new Set(['coder', 'intern'])), 'coder');
        // coder is equidistant — the upward bias breaks the tie
        assert.strictEqual(resolveRoleWithDegradation('coder', new Set(['lead', 'intern'])), 'lead');
        assert.strictEqual(resolveRoleWithDegradation('coder', new Set(['intern'])), 'intern');
        assert.strictEqual(resolveRoleWithDegradation('coder', new Set(['lead'])), 'lead');
    });

    await check('resolveRoleWithDegradation returns null on an empty pool, never a guess', () => {
        for (const r of ['intern', 'coder', 'lead']) {
            assert.strictEqual(resolveRoleWithDegradation(r, new Set()), null);
        }
        assert.strictEqual(resolveRoleWithDegradation('coder', undefined), null);
        // A single live agent takes everything — the feature's headline case.
        assert.strictEqual(resolveRoleWithDegradation('intern', new Set(['lead'])), 'lead');
        assert.strictEqual(resolveRoleWithDegradation('lead', new Set(['intern'])), 'intern');
    });

    await check('the scheduled queue pop still falls back to a live coding seat without a team', () => {
        const fs = require('fs');
        const provider = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        const i = provider.indexOf('typeof apiServer.dispatchNextFromQueue');
        assert.ok(i > 0, 'the scheduled queue-pop branch must exist');
        const block = provider.slice(i, provider.indexOf('dispatchNextFromQueue({', i));
        assert.ok(/resolveImplementationHead|resolveCodingHeadFromGroups/.test(block),
            'the pop must prefer a registered team head, routed by work kind (\'plan\')');
        assert.ok(/getAliveCodingTerminalNames\(\)/.test(block),
            'the pop must fall back to any live coding seat — a teamless PTY grid still pops the queue');
        assert.ok(!/getAliveRoleTerminalNames/.test(block),
            'the fallback must not reach the deprecated state.json registry (invisible to PTY seats)');
    });

    // ── Mission 04: the drain delivers at the team's cadence ──────────────

    /** A mission-scoped db: the pop's stage gate needs the mission, its members,
     *  and a dependency read that answers "no edges" (a missing read BLOCKS every
     *  candidate — the gate refuses rather than dispatching unchecked). */
    function missionDb(mission, members) {
        return {
            getMissionById: async id => (String(id) === String(mission.id) ? mission : null),
            getMissionMembers: async () => members.map(memberId => ({ memberId })),
            getPlanDependencies: async () => [],
            getPlanByPlanId: async () => null,
        };
    }

    function batchSpy() {
        const calls = [];
        return {
            calls,
            kanbanVerb: async (verb, payload) => {
                calls.push({ verb, payload });
                return {
                    success: true,
                    dispatched: true,
                    role: 'lead',
                    moved: payload.sessionIds.map(id => ({ id, targetColumn: payload.targetColumn })),
                };
            },
        };
    }

    const FEATURE_MISSION = { id: 'm1', name: 'Feature batch', team: 'feature-implementation', workspaceId: 'ws1' };

    await check('a Feature mission releases FIVE members in ONE dispatch', async () => {
        const members = Array.from({ length: 12 }, (_, i) => `m${i + 1}`);
        const board = members.map((id, i) => card(id, 'STAGING', { columnOrder: i + 1 }));
        const spy = batchSpy();
        const { server, dispatched } = makeServer(board, {
            db: missionDb(FEATURE_MISSION, members),
            resolveTeamBatchSize: async () => ({ value: 5, source: 'group-row' }),
            kanbanVerb: spy.kanbanVerb,
        });

        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Lead 1', missionId: 'm1' });

        assert.strictEqual(out.status, 200, out.payload.error || '');
        assert.strictEqual(spy.calls.length, 1, 'a wave is ONE dispatch, not five pops');
        assert.strictEqual(spy.calls[0].verb, 'triggerBatchAction');
        assert.strictEqual(spy.calls[0].payload.sessionIds.length, 5, 'five members in one prompt');
        assert.strictEqual(spy.calls[0].payload.targetColumn, 'LEAD CODED', 'released into the stage the team works at');
        assert.strictEqual(spy.calls[0].payload.targetTerminal, 'Lead 1', 'addressed to the head that asked');
        assert.strictEqual(spy.calls[0].payload.bypassTriggerGate, true, 'a drain dispatches regardless of the webview drag toggle');
        assert.deepStrictEqual(dispatched, [], 'the wave does not go through the single-card dispatch');
        assert.deepStrictEqual(out.payload.dispatched.planIds, spy.calls[0].payload.sessionIds, 'the reply names what was released');
        assert.strictEqual(out.payload.wave.cadence.size, 5, 'the reply states the cadence');
        assert.strictEqual(out.payload.wave.remaining, 7, 'the reply states what remains');
    });

    await check('a wave in flight holds the next release — no second wave stacks', async () => {
        const members = Array.from({ length: 12 }, (_, i) => `m${i + 1}`);
        const board = members.map((id, i) => card(id, 'STAGING', { columnOrder: i + 1 }));
        // The first five have been released and have NOT asserted completion.
        for (const id of members.slice(0, 5)) {
            board.find(c => c.planId === id).kanbanColumn = 'LEAD CODED';
        }
        const spy = batchSpy();
        const { server, dispatched } = makeServer(board, {
            db: missionDb(FEATURE_MISSION, members),
            resolveTeamBatchSize: async () => ({ value: 5, source: 'group-row' }),
            kanbanVerb: spy.kanbanVerb,
        });

        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Lead 1', missionId: 'm1' });

        assert.strictEqual(out.payload.dispatched, null, 'nothing may be released while the wave is out');
        assert.ok(/wave in flight/.test(String(out.payload.reason)), `the hold must name itself: ${out.payload.reason}`);
        assert.strictEqual(out.payload.inFlight.length, 5, 'the five in-flight members are named');
        assert.strictEqual(spy.calls.length, 0, 'no second dispatch');
        assert.deepStrictEqual(dispatched, [], 'no card was popped');
    });

    await check('the next wave releases once every in-flight member has asserted completion', async () => {
        const members = Array.from({ length: 12 }, (_, i) => `m${i + 1}`);
        const board = members.map((id, i) => card(id, 'STAGING', { columnOrder: i + 1 }));
        for (const id of members.slice(0, 5)) {
            const c = board.find(x => x.planId === id);
            c.kanbanColumn = 'LEAD CODED';
            c.completedAt = '2026-09-20T10:00:00Z';
        }
        const spy = batchSpy();
        const { server } = makeServer(board, {
            db: missionDb(FEATURE_MISSION, members),
            resolveTeamBatchSize: async () => ({ value: 5, source: 'group-row' }),
            kanbanVerb: spy.kanbanVerb,
        });

        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Lead 1', missionId: 'm1' });

        assert.strictEqual(spy.calls.length, 1, 'the drained wave releases the next one');
        assert.deepStrictEqual(spy.calls[0].payload.sessionIds, ['m6', 'm7', 'm8', 'm9', 'm10'],
            'the next five, in queue order');
        assert.strictEqual(out.payload.wave.remaining, 2, 'two members remain after the second wave');
    });

    await check('Coding cadence one: exactly one member in flight, the next released on completion', async () => {
        const members = ['m1', 'm2', 'm3', 'm4'];
        const board = members.map((id, i) => card(id, 'STAGING', { columnOrder: i + 1 }));
        const codingMission = { id: 'm2', name: 'Coding batch', team: 'coding-team', workspaceId: 'ws1' };
        const spy = batchSpy();
        const { server, dispatched } = makeServer(board, {
            db: missionDb(codingMission, members),
            resolveTeamBatchSize: async () => ({ value: 1, source: 'group-row' }),
            kanbanVerb: spy.kanbanVerb,
        });

        // Nothing in flight: one card goes, through the single-card path.
        const first = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coder', missionId: 'm2' });
        assert.deepStrictEqual(dispatched, ['m1'], 'a cadence of one is today\'s pop');
        assert.strictEqual(spy.calls.length, 0, 'a cadence of one is not a wave');
        assert.ok(first.payload.dispatched, 'the pop reports the dispatch');

        // Now that member is out and incomplete: nothing else may go.
        board.find(c => c.planId === 'm1').kanbanColumn = 'CODER CODED';
        const second = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coder', missionId: 'm2' });
        assert.strictEqual(second.payload.dispatched, null, 'one means one');
        assert.ok(/in flight/.test(String(second.payload.reason)), `the hold must name itself: ${second.payload.reason}`);
        assert.deepStrictEqual(dispatched, ['m1'], 'no second card was popped');

        // The in-flight member asserts completion: the next one releases.
        board.find(c => c.planId === 'm1').completedAt = '2026-09-20T10:00:00Z';
        await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coder', missionId: 'm2' });
        assert.deepStrictEqual(dispatched, ['m1', 'm2'], 'the completion releases the next member');
    });

    await check('a wave that would carry a feature goes one card at a time', async () => {
        // Features are never distributed (the batch arm refuses a set containing
        // one), so a wave is not available for them.
        const members = ['f1', 'm2', 'm3', 'm4', 'm5', 'm6'];
        const board = [
            card('f1', 'STAGING', { columnOrder: 1, isFeature: true }),
            ...members.slice(1).map((id, i) => card(id, 'STAGING', { columnOrder: i + 2 })),
        ];
        const spy = batchSpy();
        const { server, dispatched } = makeServer(board, {
            db: missionDb(FEATURE_MISSION, members),
            resolveTeamBatchSize: async () => ({ value: 5, source: 'group-row' }),
            kanbanVerb: spy.kanbanVerb,
        });

        await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Lead 1', missionId: 'm1' });

        assert.strictEqual(spy.calls.length, 0, 'a set containing a feature is never distributed as a wave');
        assert.deepStrictEqual(dispatched, ['f1'], 'the feature is dispatched to its lead on the single-card path');
    });

    await check('the shipped cadence is Feature five, everything else one', async () => {
        const { DEFAULT_TEAM_DEFINITIONS } = require(path.join(process.cwd(), 'out', 'services', 'teamWiring.js'));
        const byId = id => DEFAULT_TEAM_DEFINITIONS.find(d => d && d.id === id);
        assert.strictEqual(byId('feature-implementation').batchSize, 5, 'the Feature lead takes a wave of five');
        for (const id of ['coding-team', 'multi-agent-planning', 'planning-team', 'review-team']) {
            assert.strictEqual(byId(id).batchSize, 1, `${id} releases one at a time`);
        }
    });

    await check('an absent or invalid cadence reads as one, tagged with its source', async () => {
        const { readTeamBatchSize, DEFAULT_TEAM_BATCH_SIZE } = require(path.join(process.cwd(), 'out', 'services', 'teamWiring.js'));
        const { TEAM_BATCH_PLAN_CAP } = require(path.join(process.cwd(), 'out', 'services', 'agentPromptBuilder.js'));
        assert.strictEqual(DEFAULT_TEAM_BATCH_SIZE, 1);
        assert.deepStrictEqual(readTeamBatchSize({}), { value: 1, source: 'default:absent' });
        assert.deepStrictEqual(readTeamBatchSize({ batchSize: 'nonsense' }), { value: 1, source: 'default:invalid' });
        assert.deepStrictEqual(readTeamBatchSize({ batchSize: 0 }), { value: 1, source: 'default:invalid' });
        assert.deepStrictEqual(readTeamBatchSize({ batchSize: 5 }), { value: 5, source: 'group-row' });
        assert.deepStrictEqual(readTeamBatchSize({ batchSize: 99 }), { value: TEAM_BATCH_PLAN_CAP, source: 'default:capped' });
    });

    await check('the drain carries no cadence constant — the value comes from the team read', async () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const start = src.indexOf('private async _runQueuePop(');
        assert.ok(start > 0, 'the pop must exist');
        const body = src.slice(start, src.indexOf('\n    /**', start + 10));
        assert.ok(/resolveTeamBatchSize/.test(body), 'the cadence is read from the team, through the seam');
        assert.ok(!/batchSize\s*=\s*\d/.test(body), 'no cadence constant is written into the drain');
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
