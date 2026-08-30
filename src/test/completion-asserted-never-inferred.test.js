'use strict';

/**
 * Completion is asserted, never inferred — and silence halts.
 *
 * Tests the anchor plan's surviving invariants: no consumer derives completion
 * from a kanban column, and silence halts the pipeline (an un-posted card holds
 * its team in every column and every pacing mode, so nothing advances on a
 * guess). See `completion-is-asserted-never-inferred.md`.
 *
 * NOT covered here, deliberately: the plan's other two invariants — "every
 * automation self-stop carries a reason" and "a halt is visible without reading
 * terminal scrollback" — were asserted against `_autobanState.stopReason` and
 * the `_stopAutobanEngine` Mission Control relay. 25fdb6d9 retired the autoban
 * clock outright and deleted both, along with the assertions that pinned them;
 * there is no automation self-stop left to carry a reason. Halt VISIBILITY did
 * survive, on a different mechanism: a stall reaches the operator as a
 * `notifyTurnEnd({ outcome: 'stalled' })` whose report mirror is written to
 * `.switchboard/mission-control/reports/` before any pty guard, so the notice
 * outlives scrollback. That path is owned by the queue-stall-watch contract
 * (`test:contract:queue-stall-watch`), not by this file. Do not re-add
 * stopReason assertions here without the state to back them.
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

const WS = '/tmp/completion-asserted-ws';

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

function makeServer(opts = {}) {
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
            getBoard: async () => opts.board || [],
            ...(opts.db || {}),
        }),
        resolveTeamMembers: opts.resolveTeamMembers || (async () => ['Coding', 'Coder-1']),
        resolveTeamPacing: opts.resolveTeamPacing || (async () => 'head'),
        armQueueWatch: async () => {},
    });
    server.performKanbanDispatch = async (workspaceRoot, planId) => {
        dispatched.push(planId);
        return { status: 200, payload: { success: true, planId, dispatched: true } };
    };
    return { server, dispatched };
}

async function run() {
    console.log('\ncompletion-asserted-never-inferred\n');

    // ── Board position cannot complete anything ──────────────────────────

    await check('board position cannot complete: cards in coding columns with no completion post do not advance', async () => {
        const board = [
            card('sub1', 'CODER CODED', { dispatchedTerminal: 'Coder-1', completedAt: null }),
            card('sub2', 'CODER CODED', { dispatchedTerminal: 'Coder-1', completedAt: null }),
            card('next', 'STAGING', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer({
            board,
            resolveTeamMembers: async () => ['Coding', 'Coder-1'],
            resolveTeamPacing: async () => 'head',
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 409, 'uncompleted cards pin the team — no inference from column position');
        assert.deepStrictEqual(dispatched, [], 'nothing dispatched without a completion post');
    });

    // ── In-flight reads the fact, no fact means busy ─────────────────────

    await check('in-flight reads completed_at: NULL means busy, non-NULL means released', async () => {
        const board = [
            card('done', 'CODER CODED', { dispatchedTerminal: 'Coder-1', completedAt: '2026-08-24T12:00:00Z' }),
            card('next', 'STAGING', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer({
            board,
            resolveTeamMembers: async () => ['Coding', 'Coder-1'],
            resolveTeamPacing: async () => 'head',
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200, 'completed card releases the team');
        assert.deepStrictEqual(dispatched, ['next']);
    });

    await check('in-flight: completed_at NULL refuses even in a coding column', async () => {
        const board = [
            card('busy', 'LEAD CODED', { dispatchedTerminal: 'Coding', completedAt: null }),
            card('next', 'STAGING', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer({
            board,
            resolveTeamMembers: async () => ['Coding', 'Coder-1'],
            resolveTeamPacing: async () => 'head',
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 409, 'NULL completed_at means busy');
        assert.deepStrictEqual(dispatched, []);
    });

    // ── Seat-pacing skip is gone ─────────────────────────────────────────

    await check('seat pacing runs the same in-flight check as head pacing', async () => {
        // A completed card in a coding column should NOT pin the team under seat pacing.
        const board = [
            card('done', 'CODER CODED', { dispatchedTerminal: 'Coder-1', completedAt: '2026-08-24T12:00:00Z' }),
            card('next', 'STAGING', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer({
            board,
            resolveTeamMembers: async () => ['Coding', 'Coder-1'],
            resolveTeamPacing: async () => 'seat',
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200, 'seat pacing honours completed_at — no skip');
        assert.deepStrictEqual(dispatched, ['next']);
    });

    await check('seat pacing: uncompleted card still pins team', async () => {
        const board = [
            card('busy', 'CODER CODED', { dispatchedTerminal: 'Coder-1', completedAt: null }),
            card('next', 'STAGING', { queuePosition: 1 }),
        ];
        const { server, dispatched } = makeServer({
            board,
            resolveTeamMembers: async () => ['Coding', 'Coder-1'],
            resolveTeamPacing: async () => 'seat',
        });
        const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 409, 'seat pacing refuses when card is uncompleted');
        assert.deepStrictEqual(dispatched, []);
    });

    // ── queue/done is not completion ─────────────────────────────────────

    await check('context-aware completion order routes to queue/done without mtime guess', async () => {
        const { CONTEXT_AWARE_COMPLETION_ORDER_BODY } = require(path.join(process.cwd(), 'out', 'services', 'teamWiring.js'));
        const body = CONTEXT_AWARE_COMPLETION_ORDER_BODY('test-group', 'lead-1');
        assert.ok(body.includes('POST /kanban/queue/done'), 'order must instruct coder to call POST /kanban/queue/done');
        assert.ok(body.includes('/terminals/teams/test-group/queue/done'), 'order must instruct fallback queue/done');
        // Reading `kanbanColumn` to pick an ENDPOINT is routing and is allowed.
        // Reading it to decide that WORK IS FINISHED is the inference this file
        // exists to forbid — a column advances when work starts. The order must
        // therefore never tell a seat to move or dispatch a card.
        assert.ok(!body.includes('kanban/dispatch'),
            'order must not instruct the seat to dispatch a feature');
        assert.ok(!body.includes('CODE REVIEWED'),
            'order must not instruct the seat to move work to CODE REVIEWED');
        assert.ok(!/all subtasks are in/i.test(body),
            'order must not read "all subtasks are in <column>" as a completion signal');
    });

    // ── No agent is told to write a completion report file ───────────────

    await check('head order does not instruct writing a completion report file', async () => {
        const { NEW_CODING_HEAD_PROMPT } = require(path.join(process.cwd(), 'out', 'services', 'teamWiring.js'));
        assert.ok(!NEW_CODING_HEAD_PROMPT.includes('mission-control/reports/ naming the feature'),
            'head order must not instruct posting a report file for completion');
        assert.ok(NEW_CODING_HEAD_PROMPT.includes('task/complete'),
            'head order must instruct using POST /kanban/task/complete');
    });

    // ── Context-aware completion orders at team and team-head scopes ──────

    await check('wireSpawnedTeam installs context-aware completion order at team and team-head scopes', async () => {
        const tw = require(path.join(process.cwd(), 'out', 'services', 'teamWiring.js'));
        // Key-AWARE store. wireSpawnedTeam writes three config keys (orders,
        // order definitions, terminal groups); a stub that returns one shared
        // array for every key lets the groups write clobber the orders and the
        // assertions below read a groups array.
        const store = {};
        const db = {
            getConfigJson: async (k, d) => (store[k] !== undefined ? store[k] : d),
            setConfigJson: async (k, v) => { store[k] = v; },
        };
        await tw.wireSpawnedTeam({
            db, headName: 'lead-1', children: [{ friendlyName: 'coder-1' }], teamId: 'g1',
        });
        const stored = store['terminals.standingOrders'] || [];
        const member = stored.find(o => o.scope === 'team' && o.teamId === 'g1');
        const head = stored.find(o => o.scope === 'team-head' && o.id === 'context-aware-completion:g1:team-head');
        assert.ok(member && head, 'both the team and team-head orders must be installed');
        assert.ok(member.instruction.includes(tw.CONTEXT_AWARE_COMPLETION_ORDER_BODY('g1', 'lead-1')),
            'team order must carry context-aware completion body');
        assert.strictEqual(head.instruction, tw.CONTEXT_AWARE_HEAD_COMPLETION_ORDER_BODY('g1'),
            'head order must carry the HEAD completion body, not the member body');
    });

    // ── The head's own order is the LEAD's, not the members' ─────────────
    // The member body's fallback names the head as the recipient, so a head
    // handed that text is told to ptySendPrompt itself — and it never names the
    // one post only a lead can make. `completed_at` is the single fact that
    // releases a team; an order on the head that omits it releases nothing.

    await check('the team-head body tells the LEAD to post task/complete and not to prompt itself', async () => {
        const tw = require(path.join(process.cwd(), 'out', 'services', 'teamWiring.js'));
        const head = tw.CONTEXT_AWARE_HEAD_COMPLETION_ORDER_BODY('test-group');
        const member = tw.CONTEXT_AWARE_COMPLETION_ORDER_BODY('test-group', 'lead-1');
        assert.notStrictEqual(head, member, 'the head must not be handed the member body');
        assert.ok(head.includes('POST /kanban/task/complete'),
            'the lead\'s own order must name POST /kanban/task/complete');
        assert.ok(head.includes('"from":"<your terminal name>"'),
            'the post must be addressed FROM the lead — first person, not a description of what somebody else does');
        assert.ok(!head.includes('ptySendPrompt'),
            'the head has nobody to relay to — a self-prompt fallback must not survive in the head body');
        assert.ok(head.includes('/terminals/teams/test-group/queue/done'),
            'the head still advances the team queue, so queue/done must survive with the groupId baked in');
        assert.ok(!head.includes('kanban/dispatch') && !head.includes('CODE REVIEWED'),
            'the head body must not infer completion from board position either');
    });

    // ── Source-text invariants (no compilation required) ─────────────────
    // The remaining acceptance criteria are source-text invariants: they pin
    // the shape of the code, not a runtime result. Scanning the .ts source
    // directly keeps them runnable without a build step.

    const fs = require('fs');
    const ROOT = process.cwd();
    function readSrc(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
    const teamWiringSrc = readSrc('src/services/teamWiring.ts');
    const localApiSrc = readSrc('src/services/LocalApiServer.ts');
    const autobanStateSrc = readSrc('src/services/autobanState.ts');
    const providerSrc = readSrc('src/services/TaskViewerProvider.ts');
    const planEngineSrc = readSrc('src/services/PlanIngestionEngine.ts');
    const kanbanHtmlSrc = readSrc('src/webview/kanban.html');
    const terminalsJsSrc = readSrc('src/webview/terminals.js');

    await check('context-aware completion order body exists in teamWiring', async () => {
        const fnStart = teamWiringSrc.indexOf('export function CONTEXT_AWARE_COMPLETION_ORDER_BODY');
        assert.ok(fnStart >= 0, 'CONTEXT_AWARE_COMPLETION_ORDER_BODY not found');
        const fnEnd = teamWiringSrc.indexOf('\n}', fnStart);
        const fnBody = teamWiringSrc.slice(fnStart, fnEnd);
        assert.ok(fnBody.includes('POST /kanban/queue/done'),
            'context-aware completion order must route to queue/done');
        assert.ok(!fnBody.includes('kanban/dispatch'),
            'the order body must not instruct a seat to dispatch a feature');
        assert.ok(!fnBody.includes('CODE REVIEWED'),
            'the order body must not instruct a seat to move work to CODE REVIEWED');
    });

    await check('seat-pacing skip is gone — in-flight scan runs for both pacing modes and contains no column check', async () => {
        // The guard must be `if (isTeamDispatch)` — NOT `if (pacing !== 'seat' && isTeamDispatch)`.
        // The scan reads completed_at and contains no column comparison (CODING_COLUMNS).
        assert.ok(/if \(isTeamDispatch\)\s*\{[\s\S]*?!p\.completedAt/.test(localApiSrc),
            'in-flight scan must run on `if (isTeamDispatch)` and read `!p.completedAt`');
        assert.ok(!/if \(isTeamDispatch\)\s*\{[\s\S]*?CODING_COLUMNS/.test(localApiSrc),
            'in-flight scan must contain no CODING_COLUMNS / column comparison');
        assert.ok(!/pacing !== 'seat' && isTeamDispatch/.test(localApiSrc),
            'the seat-pacing skip (`pacing !== \'seat\' && isTeamDispatch`) must be deleted');
    });

    await check('no in-flight consumer derives completion from a kanban column', async () => {
        // The rule is a CATEGORY, not a site. Asserting it against
        // LocalApiServer alone is what let the queue-watch stall sweep keep a
        // column-scoped copy of the predicate: a completed card keeps its
        // holder and stays in its coding column, so that copy read "in flight"
        // forever and the head was never nudged again — silence halted, and
        // the sweep that says so was muzzled. Every consumer, or none.
        assert.ok(!/CODING_COLUMNS/.test(planEngineSrc),
            'PlanIngestionEngine must not carry a CODING_COLUMNS in-flight predicate — '
            + 'key on `completed_at` (the asserted fact) and the dispatch holder, never on board position');
        // The queue-watch sweep's in-flight predicate must read the fact.
        // Pinned as a CATEGORY over the whole predicate body, not as one
        // literal clause order: the predicate legitimately carries further
        // conditions (an outstanding `dispatched_at`), and a regex anchored to
        // the FIRST clause goes red on a correct tightening while staying green
        // on a column read moved one line down — it pins spelling, not the
        // rule. What must hold is that `completed_at` IS read and that board
        // position is NOT an input.
        const inFlightTail = planEngineSrc.split('const inFlight = board.some(p =>')[1];
        assert.ok(inFlightTail, 'the queue-watch in-flight predicate must exist in PlanIngestionEngine.ts');
        const inFlightPredicate = inFlightTail.split('if (inFlight)')[0];
        assert.ok(/!p\.completedAt/.test(inFlightPredicate),
            'the queue-watch in-flight predicate must read `!p.completedAt`');
        assert.ok(!/kanbanColumn/.test(inFlightPredicate),
            'the queue-watch in-flight predicate must not read board position');
        // The feature sweep's remaining-subtask filter must read it too.
        assert.ok(/kanbanColumn !== 'COMPLETED' && !s\.completedAt/.test(planEngineSrc),
            'the feature sweep must treat a subtask as remaining only until its completion post');
    });

    await check('queue/done is not completion — completed_at has exactly one writer', async () => {
        // The anchor plan's named invariant: `queue/done` means "give me the next
        // item", and completion is NOT a side effect of it. Asserting that by
        // driving a queue/done and re-reading the row only proves today's handler;
        // the durable form of the rule is that the completion fact has ONE writer
        // and it is the asserted post. Conflating the two is the original defect
        // — the release → clear → pop chain is a critical section that will be
        // edited again, and a `setCompletedAt` added inside it would restore
        // completion-by-queue-advance with every other gate still green.
        const writers = (localApiSrc.match(/setCompletedAt\?\.\(|setCompletedAt\(/g) || []).length;
        assert.strictEqual(writers, 1,
            `completed_at must have exactly one writer in LocalApiServer.ts (found ${writers}) — `
            + 'the asserted post, via completeCardInternal. A second call site means some other '
            + 'operation records completion as a side effect, which is the inference this plan removed.');
        // ...and that one writer must live in completeCardInternal, not in the
        // queue/done chain or the pop.
        const completeStart = localApiSrc.indexOf('public async completeCardInternal(');
        assert.notStrictEqual(completeStart, -1, 'completeCardInternal must exist');
        const completeBody = localApiSrc.slice(completeStart, localApiSrc.indexOf('\n    /**', completeStart + 10));
        assert.ok(/setCompletedAt\?\.\(planId, timestamp\)/.test(completeBody),
            'the single completed_at write must be completeCardInternal\'s');
        // The queue/done path must not reach the fact at all. Every arm is
        // asserted by NAME and each name is required to resolve — a soft
        // `if (found)` skip here is the same green-while-incomplete hole this
        // feature exists to close: a rename would silently retire the check.
        for (const arm of [
            'private async _handleKanbanQueueDone(',  // the HTTP route
            'private _runQueueDone(',                 // the shared release -> clear -> pop body
            'private _handleTeamQueueDone(',          // the file-based team queue
        ]) {
            const start = localApiSrc.indexOf(arm);
            assert.notStrictEqual(start, -1,
                `${arm} must exist — if it was renamed, repoint this assertion rather than dropping it`);
            const body = localApiSrc.slice(start, localApiSrc.indexOf('\n    /**', start + 10));
            assert.ok(!/setCompletedAt/.test(body),
                `${arm} must never write completed_at — queue/done requests the next item, it does not assert completion`);
            assert.ok(!/completeCardInternal/.test(body),
                `${arm} must never call completeCardInternal — completion is the lead's separate, explicit post`);
        }
    });

    await check('kanban.html + terminals.js mirrors retired the report-file completion channel', async () => {
        // The webview mirrors of NEW_CODING_HEAD_PROMPT must not instruct
        // writing a completion report file, and must instruct task/complete.
        for (const [name, src] of [['kanban.html', kanbanHtmlSrc], ['terminals.js', terminalsJsSrc]]) {
            assert.ok(!src.includes('Post a finished report to .switchboard/mission-control/reports/ naming the feature'),
                `${name} must not instruct posting a completion report file`);
            assert.ok(src.includes('POST /kanban/task/complete'),
                `${name} must instruct using POST /kanban/task/complete`);
        }
    });

    // ── Summary ──────────────────────────────────────────────────────────

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
