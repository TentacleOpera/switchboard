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

    // ── Board position cannot complete anything, and cannot refuse either ──
    // V81 deleted the in-flight refusal: a card in a coding column with no
    // completion post no longer pins its team, so the next staged card is
    // handed out. Duplicate dispatch is not a failure mode — the agent reads
    // the plan and says the work is done. What survives is the ORIGINAL
    // invariant: a column move never writes `completed_at`, so board position
    // cannot complete anything.

    await check('board position cannot complete: an un-posted coding card never advances the board', async () => {
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
        assert.strictEqual(out.status, 200, 'dispatch is never refused');
        assert.deepStrictEqual(dispatched, ['next'], 'the next staged card is handed out');
        assert.strictEqual(board.find(p => p.planId === 'sub1').completedAt, null,
            'the un-posted card is NOT marked complete — board position completes nothing');
    });

    // ── An un-posted card does not pin the team ──────────────────────────

    await check('an uncompleted card does not refuse the next dispatch (head pacing)', async () => {
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
        assert.strictEqual(out.status, 200, 'a NULL completed_at no longer means "busy"');
        assert.deepStrictEqual(dispatched, ['next']);
    });

    await check('a completed card does not block the next dispatch either', async () => {
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
        assert.strictEqual(out.status, 200, 'completed_at never gates dispatch');
        assert.deepStrictEqual(dispatched, ['next']);
    });

    // ── Pacing mode does not change whether dispatch is refused ──────────

    await check('seat pacing dispatches the next card regardless of an uncompleted card', async () => {
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
        assert.strictEqual(out.status, 200, 'seat pacing refuses nothing — the in-flight scan is gone');
        assert.deepStrictEqual(dispatched, ['next']);
    });

    // ── queue/done is not completion ─────────────────────────────────────

    await check('context-aware completion order routes to queue/done without mtime guess', async () => {
        const { buildMemberCompletionFragment } = require(path.join(process.cwd(), 'out', 'services', 'standingOrderFragments.js'));
        const body = buildMemberCompletionFragment({ teamId: 'test-group', headName: 'lead-1' });
        assert.ok(body.includes('node "<cliPath>" done.'),
            'order must instruct coder to signal completion with the bundled CLI\'s bare done command');
        assert.ok(!/done --from/.test(body),
            'the seat supplies no --from: the CLI resolves it from SWITCHBOARD_TERMINAL');
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
        assert.ok(NEW_CODING_HEAD_PROMPT.includes('accept --plan'),
            'head order must instruct using the accept --plan CLI verb (which posts to task/complete)');
    });

    // ── System completion orders are composed at delivery, not persisted ──

    await check('wireSpawnedTeam persists no system completion orders — composed at delivery from fragments', async () => {
        const tw = require(path.join(process.cwd(), 'out', 'services', 'teamWiring.js'));
        // Key-AWARE store. wireSpawnedTeam writes config keys (orders, order
        // definitions, terminal groups); a stub that returns one shared array
        // for every key lets the groups write clobber the orders.
        const store = {};
        const db = {
            getConfigJson: async (k, d) => (store[k] !== undefined ? store[k] : d),
            setConfigJson: async (k, v) => { store[k] = v; },
        };
        await tw.wireSpawnedTeam({
            db, headName: 'lead-1', children: [{ friendlyName: 'coder-1' }], teamId: 'g1',
        });
        const stored = store['terminals.standingOrders'] || [];
        // No prompt supplied → no team or team-head rows persisted at all.
        // System protocol (member completion, head completion) is composed at
        // delivery by selectOrders from the fragment library, never persisted.
        assert.strictEqual(stored.length, 0,
            'no system-authored rows must be persisted — system protocol is composed at delivery');
        assert.ok(!stored.some(o => o.id && o.id.startsWith('context-aware-completion:')),
            'no context-aware-completion system row must be persisted');
    });

    // ── The head's own order is the LEAD's, not the members' ─────────────
    // The member body's fallback names the head as the recipient, so a head
    // handed that text is told to ptySendPrompt itself — and it never names the
    // one post only a lead can make. `completed_at` is the single fact that
    // releases a team; an order on the head that omits it releases nothing.

    await check('the head completion fragment tells the LEAD to accept the subtask and not to prompt itself', async () => {
        const { buildHeadCompletionFragment, buildMemberCompletionFragment } = require(path.join(process.cwd(), 'out', 'services', 'standingOrderFragments.js'));
        const head = buildHeadCompletionFragment();
        const member = buildMemberCompletionFragment({ teamId: 'test-group', headName: 'lead-1' });
        assert.notStrictEqual(head, member, 'the head must not be handed the member body');
        // The lead's completion verb is `accept --plan`, not a hand-assembled
        // task/complete POST. The system derives round close and feature
        // complete from the accepts.
        assert.ok(head.includes('accept --plan'),
            'the lead\'s own order must name the accept verb');
        assert.ok(head.includes('"from":"<your terminal name>"'),
            'the register call must be addressed FROM the lead — first person, not a description of what somebody else does');
        assert.ok(!head.includes('ptySendPrompt'),
            'the head has nobody to relay to — a self-prompt fallback must not survive in the head body');
        // queue/done is NOT in this fragment any more. A lead advances by
        // accepting — the system dispatches the next round — so the
        // `done --from` pop was gated out for lead heads entirely (it raced
        // the round advance). Reviewer heads still get it, from headNext.
        assert.ok(!head.includes('queue/done'),
            'a lead does not pop a queue: accepting advances the round, and both live at once is the race this gate exists to prevent');
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
    const kanbanDbSrc = readSrc('src/services/KanbanDatabase.ts');
    const kanbanHtmlSrc = readSrc('src/webview/kanban.html');
    // The shipped Coding headPrompt moved to agent-control.js with the Teams tab.
    const agentControlJsSrc = readSrc('src/webview/agent-control.js');
    const terminalsJsSrc = readSrc('src/webview/terminals.js');

    await check('member completion fragment body exists in standingOrderFragments', async () => {
        const fragmentsSrc = readSrc('src/services/standingOrderFragments.ts');
        const fnStart = fragmentsSrc.indexOf('export function buildMemberCompletionFragment');
        assert.ok(fnStart >= 0, 'buildMemberCompletionFragment not found in standingOrderFragments.ts');
        const fnEnd = fragmentsSrc.indexOf('\n}', fnStart);
        const fnBody = fragmentsSrc.slice(fnStart, fnEnd);
        assert.ok(fnBody.includes('POST /kanban/queue/done') || fnBody.includes('/terminals/teams/'),
            'member completion fragment must route to queue/done or team queue/done');
        assert.ok(!fnBody.includes('kanban/dispatch'),
            'the fragment body must not instruct a seat to dispatch a feature');
        assert.ok(!fnBody.includes('CODE REVIEWED'),
            'the fragment body must not instruct a seat to move work to CODE REVIEWED');
    });

    await check('column transitions clear the advisory working stamp for cards and feature cascades', async () => {
        const directStart = kanbanDbSrc.indexOf('public async updateColumnByPlanFileWithReason(');
        const directEnd = kanbanDbSrc.indexOf('public async updateColumnByPlanFile(', directStart);
        const directBody = kanbanDbSrc.slice(directStart, directEnd);
        assert.ok(directBody.includes('_columnMoveDispatchClearSql()'),
            'a direct column transition must clear the advisory working stamp in the same update');

        // The helper itself NULLs owner_since — V81 replaced the old
        // dispatched_at/last_liveness_at/blocked_at clears, whose columns are gone.
        const helperStart = kanbanDbSrc.indexOf('private _columnMoveDispatchClearSql(');
        assert.notStrictEqual(helperStart, -1, '_columnMoveDispatchClearSql must exist');
        const helperBody = kanbanDbSrc.slice(helperStart, kanbanDbSrc.indexOf('\n    }', helperStart));
        assert.ok(helperBody.includes('owner_since = NULL'),
            'the column-move clear must NULL owner_since — the advisory "out for work" stamp');

        const cascadeStart = kanbanDbSrc.indexOf('public async cascadeFeatureByPlanId(');
        const cascadeEnd = kanbanDbSrc.indexOf('public async isOwnedActive(', cascadeStart);
        const cascadeBody = kanbanDbSrc.slice(cascadeStart, cascadeEnd);
        const clears = cascadeBody.match(/dispatchClear/g) || [];
        assert.ok(clears.length >= 2,
            'a feature cascade must clear the working stamp for both the feature and its subtasks');
    });

    await check('the in-flight refusal is deleted — no scan remains in the pop', async () => {
        // V81 removed the whole concept: ownership is advisory, and a duplicate
        // dispatch is legal. The two predicates and the pop's in-flight arm are gone.
        assert.ok(!/\bresolveTeamInFlight\b/.test(localApiSrc), 'resolveTeamInFlight must be deleted');
        assert.ok(!/\bheldByTeam\b/.test(localApiSrc), 'heldByTeam must be deleted');
        assert.ok(!/pacing !== 'seat' && isTeamDispatch/.test(localApiSrc),
            'the seat-pacing skip (`pacing !== \'seat\' && isTeamDispatch`) must be deleted');
        const popStart = localApiSrc.indexOf('private async _runQueuePop(');
        assert.notStrictEqual(popStart, -1, '_runQueuePop must exist');
        const popBody = localApiSrc.slice(popStart, localApiSrc.indexOf('\n    /**', popStart + 10));
        assert.ok(!/inFlight/.test(popBody),
            'the pop must carry no in-flight refusal — it hands out the next staged card, whoever holds what');
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

    await check('silence never infers a blocked seat — no writer, no sweep, no board decoration', async () => {
        // The silence arm stamped `blocked_at` after ~90s of PTY quiet and lit a
        // yellow "Waiting on you" ring. Silence cannot tell thinking from crashed,
        // so the arm was removed as an instance of the same inference the file's
        // other checks forbid. Its own tests went with it (they were anchored on
        // `if (silentTerminals.length > 0)`), which left the removal with nothing
        // in CI discriminating on it. These are that discriminator: each one is a
        // distinct re-entry point for the mechanism.
        assert.ok(!/setBlockedState/.test(kanbanDbSrc),
            'setBlockedState must stay deleted — it is the only writer the blocked stamp ever had');
        // `blocked_at = NULL` clears are fine (the column is dead and clears keep
        // legacy rows honest); a parameterised write is the writer coming back.
        for (const [name, src] of [['KanbanDatabase.ts', kanbanDbSrc], ['PlanIngestionEngine.ts', planEngineSrc], ['TaskViewerProvider.ts', providerSrc]]) {
            assert.ok(!/blocked_at\s*=\s*\?/.test(src),
                `${name} must not write blocked_at — the column is dead and has no writer`);
        }
        assert.ok(!/_blockedCandidates|_runBlockedDigestSweep|blockedNotifyPacing/.test(planEngineSrc),
            'the silence sweep and its paced digest must stay deleted, along with their pacing state');
        assert.ok(!/outcome:\s*'blocked'/.test(planEngineSrc),
            "the engine must never emit outcome: 'blocked' — its only producer was the silence arm");
        assert.ok(!/turnEndSilenceMs/.test(planEngineSrc.slice(planEngineSrc.indexOf('const liveNames'), planEngineSrc.indexOf('let recordedLiveness'))),
            'the liveness partition must not re-classify a quiet seat — silence is not a turn boundary');
        for (const marker of ['is-blocked', 'blocked-badge', 'Waiting on you', 'Agent waiting on you']) {
            assert.ok(!kanbanHtmlSrc.includes(marker),
                `kanban.html must carry no '${marker}' decoration — the board must not render a guessed wait`);
        }
        const pkg = readSrc('package.json');
        for (const setting of ['blockedTimeoutMs', 'blockedNotifyIntervalMs']) {
            assert.ok(!pkg.includes(setting),
                `package.json must not contribute switchboard.activityLight.${setting} — nothing reads it, so the settings UI would offer a dead knob`);
        }
    });

    await check('agent-control.js + terminals.js mirrors retired the report-file completion channel', async () => {
        // The webview mirrors of NEW_CODING_HEAD_PROMPT must not instruct
        // writing a completion report file, and must instruct accept --plan
        // (the CLI verb that posts to task/complete — the lead moved off the
        // hand-assembled POST in plan: the-lead-accepts-a-subtask-and-the-
        // system-advances).
        for (const [name, src] of [['agent-control.js', agentControlJsSrc], ['terminals.js', terminalsJsSrc]]) {
            assert.ok(!src.includes('Post a finished report to .switchboard/mission-control/reports/ naming the feature'),
                `${name} must not instruct posting a completion report file`);
        }
        // Only agent-control.js still CARRIES the Coding headPrompt (it moved
        // out of kanban.html with the Teams tab). The terminals.js client mirror
        // (NEW_CODING_HEAD_PROMPT_CLIENT) was retired when system protocol
        // composition moved to delivery-time fragment composition —
        // `coding-head-prompt-contract.test.js` pins its absence. Demanding the
        // completion verb from a file that carries no prompt at all is a gate
        // that can only ever be red, so assert what is actually true of each:
        // agent-control.js names the verb, terminals.js declares no mirror.
        assert.ok(agentControlJsSrc.includes('accept --plan'),
            'agent-control.js must instruct using the accept --plan CLI verb');
        assert.ok(!terminalsJsSrc.includes('NEW_CODING_HEAD_PROMPT_CLIENT'),
            'terminals.js must declare NO Coding headPrompt mirror — the client mirror is retired, '
            + 'and a reinstated one would drift from teamWiring.ts the moment the verb changes');
    });

    // ── Summary ──────────────────────────────────────────────────────────

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
