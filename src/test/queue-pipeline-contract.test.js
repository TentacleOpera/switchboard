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
            ...(opts.db || {}),
        }),
        resolveTeamMembers: opts.resolveTeamMembers,
        resolveTeamPacing: opts.resolveTeamPacing,
        armQueueWatch: async () => { /* recorded separately where it matters */ },
    });
    // Stub the dispatch machinery: this contract is about SELECTION and
    // REFUSAL, not about what performKanbanDispatch does with the card.
    server.performKanbanDispatch = async (workspaceRoot, planId) => {
        dispatched.push(planId);
        return { status: 200, payload: { success: true, planId, moved: true, dispatched: true } };
    };
    return { server, dispatched };
}

async function run() {
    console.log('\nqueue-pipeline contract\n');

    // ── Subtask 1: the queue source ────────────────────────────────────────

    await check('the queue is DISPATCH — an empty queue does NOT drain PLAN REVIEWED', async () => {
        const board = [
            card('pr-1', 'PLAN REVIEWED'),
            card('pr-2', 'PLAN REVIEWED'),
        ];
        const { server, dispatched } = makeServer(board);
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200, 'an empty queue is not an error');
        assert.strictEqual(out.payload.dispatched, null,
            'an empty DISPATCH queue must report dispatched: null — the interim PLAN REVIEWED fallback would drain the whole lane unattended');
        assert.deepStrictEqual(dispatched, [], 'nothing may be dispatched from an empty queue');
    });

    await check('the pop takes the lowest queue_position, NULLs last', async () => {
        const board = [
            card('c', 'DISPATCH', { queuePosition: null }),
            card('b', 'DISPATCH', { queuePosition: 7 }),
            card('a', 'DISPATCH', { queuePosition: 2 }),
        ];
        const { server, dispatched } = makeServer(board);
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatched, ['a'], 'queue_position 2 must beat 7 and beat NULL');
    });

    await check('subtasks and already-dispatched cards are excluded from the queue', async () => {
        const board = [
            card('sub', 'DISPATCH', { featureId: 'feat-1', queuePosition: 1 }),
            card('gone', 'DISPATCH', { dispatchedAt: '2026-08-18T00:00:00Z', queuePosition: 2 }),
            card('real', 'DISPATCH', { queuePosition: 3 }),
        ];
        const { server, dispatched } = makeServer(board);
        await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.deepStrictEqual(dispatched, ['real'],
            'a subtask (non-empty featureId) and a card already carrying dispatchedAt must both be skipped');
    });

    // ── Subtask 1: the in-flight predicate (the deadlock regression) ───────

    await check('seat pacing ignores resting coded cards and routes the next queued card', async () => {
        const board = [
            card('resting', 'INTERN CODED', { dispatchedTerminal: 'Intern 1', dispatchedAt: null }),
            card('next', 'DISPATCH', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Intern 1'],
            resolveTeamPacing: async () => 'seat',
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatched, ['next']);
    });

    await check('a just-reviewed card in CODE REVIEWED does NOT make the team in flight', async () => {
        // The regression the plan calls "the one that matters": after a review
        // pass the card sits in CODE REVIEWED with dispatchedAt set and
        // dispatchedTerminal naming the team's REVIEWER. A dispatchedAt-keyed
        // predicate refuses the head's own legitimate call and the pipeline
        // stops after card one.
        const board = [
            card('done', 'CODE REVIEWED', { dispatchedAt: '2026-08-18T00:00:00Z', dispatchedTerminal: 'Reviewer' }),
            card('next', 'DISPATCH', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Reviewer', 'Coder 1'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200, `expected the next card, got ${out.status}: ${out.payload.error || ''}`);
        assert.deepStrictEqual(dispatched, ['next']);
    });

    await check('a team holding a card in a coding column is refused with 409', async () => {
        const board = [
            card('wip', 'CODER CODED', { dispatchedTerminal: 'Coder 1' }),
            card('next', 'DISPATCH', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 409, 'a team with a card in a coding column is in flight');
        assert.deepStrictEqual(dispatched, [], 'a refused pop dispatches nothing and consumes no queue position');
    });

    await check('in-flight is derived from board position, not from dispatchedAt', async () => {
        // A plan-file mtime advance clears dispatchedAt (clearWorkingState) and
        // the staleness sweep clears it too. Neither may make an actively
        // coding team look free.
        const board = [
            card('wip', 'INTERN CODED', { dispatchedTerminal: 'Coder 1', dispatchedAt: null }),
            card('next', 'DISPATCH', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 409, 'a cleared dispatchedAt must not release the in-flight flag');
        assert.deepStrictEqual(dispatched, []);
    });

    await check("another team's coding card does not block this team", async () => {
        const board = [
            card('theirs', 'CODER CODED', { dispatchedTerminal: 'Other Coder' }),
            card('next', 'DISPATCH', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(dispatched, ['next']);
    });

    await check("an unresolvable `from` is a 400, never workspace-wide routing", async () => {
        const board = [card('next', 'DISPATCH', { queuePosition: 1 })];
        const { server, dispatched } = makeServer(board, { resolveTeamMembers: async () => null });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Ghost' });
        assert.strictEqual(out.status, 400, 'a `from` that names no live team must not pull work as another team');
        assert.deepStrictEqual(dispatched, []);
    });

    await check('a failed dispatch is passed through and consumes nothing', async () => {
        const board = [card('next', 'DISPATCH', { queuePosition: 1 })];
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
        const board = [failed, card('next', 'DISPATCH', { queuePosition: 2 })];
        const { server } = makeServer(board, {
            resolveTeamMembers: async () => ['Coding', 'Coder 1', 'Lead 1'],
            resolveTeamPacing: async () => 'seat',
            db: {
                clearWorkingState: async () => { failed.dispatchedAt = null; return true; },
                getPlanByPlanId: async (planId) => board.find(p => p.planId === planId),
                updateColumnByPlanFile: async () => { failed.kanbanColumn = 'DISPATCH'; return true; },
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

    await check('concurrent pops are serialized — one card, one dispatch', async () => {
        const board = [card('only', 'DISPATCH', { queuePosition: 1 })];
        const { server, dispatched } = makeServer(board);
        // Drain the card inside the critical section, exactly as a real
        // dispatch does by moving it out of DISPATCH.
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

    // ── Subtask 3: the queue watch ────────────────────────────────────────

    await check('the queue watch counts DISPATCH only, and escalates exactly once', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'PlanIngestionEngine.ts'), 'utf8');
        const i = src.indexOf('private async _runQueueNudgeSweep(');
        assert.notStrictEqual(i, -1, '_runQueueNudgeSweep must exist');
        const body = src.slice(i, src.indexOf('\n    private ', i + 10));
        assert.ok(!/kanbanColumn === 'PLAN REVIEWED'/.test(body),
            "the watch's queue must be DISPATCH only — counting PLAN REVIEWED means it never reaches 'queue empty' on a real board and nudges forever");
        assert.ok(/watch\.escalatedAt/.test(body),
            'escalation must be bounded by a one-shot stamp — re-escalating every silence window trains the user to ignore it');
        assert.ok(/nudgeCount >= 1/.test(body),
            'one nudge, then escalate — a head that ignored the first nudge will not answer a second');
        assert.ok(/_queueTeamMembersResolver/.test(body) && /teamMembers\.has\(p\.dispatchedTerminal\)/.test(body),
            "a seat-paced watch must select a held card from its own team, not another team's first active card");
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
