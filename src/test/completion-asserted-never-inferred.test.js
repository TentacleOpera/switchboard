'use strict';

/**
 * Completion is asserted, never inferred — and silence halts.
 *
 * Tests the anchor plan's invariants: no consumer derives completion from
 * a kanban column, silence halts the pipeline, every automation self-stop
 * carries a reason, and a halt is visible without reading terminal scrollback.
 * See `completion-is-asserted-never-inferred.md`.
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

    await check('queue/done does not set completed_at — it is a next-item request', async () => {
        // This is a source-text assertion: the TEAM_QUEUE_DONE_ORDER_BODY
        // must not instruct the coder to infer completion from board position.
        const { TEAM_QUEUE_DONE_ORDER_BODY } = require(path.join(process.cwd(), 'out', 'services', 'teamWiring.js'));
        const body = TEAM_QUEUE_DONE_ORDER_BODY('test-group');
        assert.ok(!body.includes('LEAD CODED'), 'order must not reference LEAD CODED as a completion signal');
        assert.ok(!body.includes('CODE REVIEWED'), 'order must not instruct coder to move to CODE REVIEWED');
        assert.ok(!body.includes('kanban/dispatch'), 'order must not instruct coder to dispatch');
    });

    // ── No agent is told to write a completion report file ───────────────

    await check('head order does not instruct writing a completion report file', async () => {
        const { NEW_CODING_HEAD_PROMPT } = require(path.join(process.cwd(), 'out', 'services', 'teamWiring.js'));
        assert.ok(!NEW_CODING_HEAD_PROMPT.includes('mission-control/reports/ naming the feature'),
            'head order must not instruct posting a report file for completion');
        assert.ok(NEW_CODING_HEAD_PROMPT.includes('task/complete'),
            'head order must instruct using POST /kanban/task/complete');
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

    await check('REVIEW seat order does not infer completion from board position', async () => {
        // The REVIEW_TEAM_QUEUE_DONE_ORDER_BODY must not carry the board-position
        // clause (the "if all subtasks are in LEAD CODED, POST /kanban/dispatch
        // ... instead of posting to queue/done" inference path).
        const fnStart = teamWiringSrc.indexOf('export function REVIEW_TEAM_QUEUE_DONE_ORDER_BODY');
        assert.ok(fnStart >= 0, 'REVIEW_TEAM_QUEUE_DONE_ORDER_BODY not found');
        const fnEnd = teamWiringSrc.indexOf('\n}', fnStart);
        const fnBody = teamWiringSrc.slice(fnStart, fnEnd);
        assert.ok(!fnBody.includes('LEAD CODED'),
            'REVIEW seat order must not reference LEAD CODED as a completion signal');
        assert.ok(!fnBody.includes('CODE REVIEWED'),
            'REVIEW seat order must not instruct the reviewer to move to CODE REVIEWED');
        assert.ok(!fnBody.includes('kanban/dispatch'),
            'REVIEW seat order must not instruct the reviewer to dispatch the feature');
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

    await check('stopReason field exists on AutobanConfigState and is normalised', async () => {
        assert.ok(/stopReason\?:\s*string/.test(autobanStateSrc),
            'AutobanConfigState must declare an optional stopReason field');
        // The normaliser must carry stopReason forward (string or undefined),
        // not rely solely on the unknown-keys spread.
        assert.ok(/stopReason:\s*typeof\s+\(state as any\)\?\.stopReason\s*===\s*'string'/.test(autobanStateSrc),
            'normalizeAutobanConfigState must explicitly normalise stopReason');
    });

    await check('every automation self-stop records a reason on _autobanState', async () => {
        // _stopAutobanEngine must set _autobanState.stopReason when given a reason,
        // regardless of whether a Mission Control exists.
        assert.ok(/_stopAutobanEngine\(reason\?:\s*string\)/.test(providerSrc),
            '_stopAutobanEngine must accept an optional reason argument');
        assert.ok(/if \(reason\)\s*\{[\s\S]*?this\._autobanState\.stopReason\s*=\s*reason/.test(providerSrc),
            '_stopAutobanEngine must record the reason on _autobanState when present');
        // The no-valid-tickets self-stop must pass a reason through.
        assert.ok(/_stopAutobanWithMessage\('Autoban stopped: no more valid tickets remain in enabled columns\.'/.test(providerSrc),
            'the no-valid-tickets self-stop must pass its message as the stop reason');
    });

    await check('halt is relayed to Mission Control gated on _hasMissionControl with standingOrders: false', async () => {
        // The relay must be gated on _hasMissionControl(), use the adopted seat
        // name, and carry standingOrders: false so it never resets the
        // controller's context (the established machine-origin relay shape).
        assert.ok(/if \(reason && this\._hasMissionControl\(\)\)/.test(providerSrc),
            'halt relay must be gated on `reason && this._hasMissionControl()`');
        assert.ok(/this\._autobanState\?\.missionControlSeat\?\.terminalName/.test(providerSrc),
            'halt relay must resolve the Mission Control recipient from the adopted seat');
        assert.ok(/clearBeforePrompt:\s*false,\s*standingOrders:\s*false/.test(providerSrc),
            'halt relay must use clearBeforePrompt: false AND standingOrders: false — never reset the controller');
        // The reason is recorded BEFORE the relay gate, so an unattended halt
        // (no Mission Control) still leaves a legible off state.
        const reasonIdx = providerSrc.indexOf('this._autobanState.stopReason = reason');
        const gateIdx = providerSrc.indexOf('if (reason && this._hasMissionControl())');
        assert.ok(reasonIdx >= 0 && gateIdx >= 0 && reasonIdx < gateIdx,
            'stopReason must be recorded before the Mission Control relay gate — the reason survives without a controller');
    });

    await check('stall classification routes through notifyTurnEnd stalled — no second detector', async () => {
        // Every stall notification must flow through _turnEndNotifier with
        // outcome: 'stalled' (which maps to notifyTurnEnd). There must be no
        // second, parallel stall detector.
        assert.ok(/outcome:\s*'stalled'/.test(planEngineSrc),
            'PlanIngestionEngine must classify stalls via _turnEndNotifier with outcome: \'stalled\'');
        // handleAutobanTurnEnd is the notifier hook — it must NOT build a
        // second detector. It is a no-op for dispatch (completion-driven
        // dispatch is deleted); the turn-end signal path stays intact.
        const hIdx = providerSrc.indexOf('public handleAutobanTurnEnd(');
        assert.ok(hIdx >= 0, 'handleAutobanTurnEnd must exist as the notifier hook');
        const hBody = providerSrc.slice(hIdx, providerSrc.indexOf('\n    }', hIdx) + 1);
        assert.ok(!/outcome === 'stalled'/.test(hBody) || /notifyTurnEnd/.test(hBody),
            'handleAutobanTurnEnd must not re-classify stalls independently of notifyTurnEnd');
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
