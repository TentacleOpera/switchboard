'use strict';

/**
 * POST /kanban/queue/done — the team-lead relay.
 *
 * The kanban `_runQueueDone` handler was built as a headless
 * release → clear → pop pipeline and delegated all notification to
 * `notifyTurnEnd`, a Mission Control path whose recipient resolution walks
 * `parentInstanceId` and silently skips an inactive, unparented or shared
 * seat. The lead learned nothing. The relay closes that gap by resolving the
 * head from the REGISTERED GROUP's `head` field and sending it a
 * `ptySendPrompt`, mirroring the file-based `_handleTeamQueueDone`.
 *
 * Every failure mode here is silent by construction — a relay that never
 * fires, one addressed at the seat that just finished, or one aimed at an
 * external head that owns no terminal all return HTTP 200 with
 * `{"success":true}`. None of them produce a compile error, and the original
 * bug shipped with every other gate green.
 *
 * Drives the real compiled service from `out/services/LocalApiServer.js` with
 * stub seams — `LocalApiServer` is host-agnostic by construction, so no
 * `vscode` is required.
 */

const assert = require('assert');
const path = require('path');

require(path.join(process.cwd(), 'src', 'test', 'bootstrap', 'sandboxStateHome.js'));

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

const WS = '/tmp/queue-done-lead-relay-ws';

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

/** A registered team group the way `wireSpawnedTeam` writes it. */
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

/**
 * A LocalApiServer wired for the completion path. `calls` records the ORDER of
 * every side effect the relay must precede — the relay's whole point is that
 * the lead sees the report even when the clear or the dispatch fails.
 */
function makeServer(board, opts = {}) {
    const calls = [];
    const config = new Map();
    if (opts.groups) { config.set(TERMINALS_GROUPS_KEY, opts.groups); }
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
            clearWorkingState: async () => {
                const row = board.find(p => p && p.dispatchedAt);
                if (row) { row.dispatchedAt = null; }
                return true;
            },
            ...(opts.db || {}),
        }),
        resolveTeamMembers: opts.resolveTeamMembers,
        getRegisteredTerminals: opts.getRegisteredTerminals || (() => []),
        terminalVerb: async (verb, payload) => {
            calls.push({ kind: 'verb', verb, name: payload && payload.name, payload });
            if (opts.terminalVerbResult) { return opts.terminalVerbResult(verb, payload); }
            return { success: true };
        },
        clearTerminalContext: async (workspaceRoot, terminalName) => {
            calls.push({ kind: 'clear', name: terminalName });
            return { cleared: true };
        },
        armQueueWatch: async () => { /* not under test */ },
    });
    // The pop's own machinery is not under test — only that the relay precedes it.
    server.performKanbanDispatch = async (workspaceRoot, planId) => {
        calls.push({ kind: 'dispatch', planId });
        return { status: 200, payload: { success: true, planId, moved: true, dispatched: true } };
    };
    return { server, calls };
}

/** The relay sends (`ptySendPrompt` carrying the `[queue/done]` marker). */
function relays(calls) {
    return calls.filter(c => c.kind === 'verb' && c.verb === 'ptySendPrompt'
        && typeof c.payload.data === 'string' && c.payload.data.startsWith('[queue/done]'));
}

/**
 * A held card + the next queued card, wired to the given seat.
 *
 * `completedAt` is set because the shipped seat orders post
 * `/kanban/task/complete` alongside `queue/done`; without it the pop that
 * follows the relay refuses with 409 ("completion is asserted, never
 * inferred") and the case under test never reaches the queue.
 */
function boardHeldBy(seat, extra = {}) {
    return [
        card('held', 'CODER CODED', {
            dispatchedAt: '2026-08-24T00:00:00Z',
            dispatchedTerminal: seat,
            planFile: '/tmp/held.md',
            workspaceId: 'ws1',
            completedAt: '2026-08-24T01:00:00Z',
            ...extra,
        }),
        card('next', 'STAGING', { queuePosition: 1 }),
    ];
}

async function run() {
    console.log('\nqueue/done team-lead relay contract\n');

    await check('a member completion relays to the head named by the group', async () => {
        const { server, calls } = makeServer(boardHeldBy('Coder 1'), {
            groups: [group('Coding', ['Coder 1'])],
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'Coder 1' });
        assert.strictEqual(out.status, 200, `expected 200, got ${out.status}: ${out.payload.error || ''}`);
        const sent = relays(calls);
        assert.strictEqual(sent.length, 1, 'exactly one relay must reach the lead');
        assert.strictEqual(sent[0].payload.name, 'Coding', 'the relay must address the group\'s declared head');
        assert.ok(/Coder 1 reports its dispatched task complete/.test(sent[0].payload.data),
            `relay body must name the finishing seat, got: ${sent[0].payload.data}`);
        assert.strictEqual(sent[0].payload.clearBeforePrompt, false, 'a relay must never reset the lead\'s context');
        assert.strictEqual(sent[0].payload.standingOrders, false, 'a relay is not a dispatch — no standing-orders block');
    });

    await check('the relay names the held plan even when the POST omits planId', async () => {
        // Every shipped standing order (SEAT_QUEUE_DONE_ORDER_BODY,
        // TEAM_CODER_QUEUE_DONE_INSTRUCTION, GLOBAL_QUEUE_DONE_ORDER_BODY)
        // POSTs {"from":"<seat>"} with NO planId. Keying the message off the
        // request field tells the lead "somebody finished something".
        const { server, calls } = makeServer(boardHeldBy('Coder 1'), {
            groups: [group('Coding', ['Coder 1'])],
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        await server.reportQueueDone({ workspaceRoot: WS, from: 'Coder 1' });
        const sent = relays(calls);
        assert.strictEqual(sent.length, 1);
        assert.ok(/\(plan held\)/.test(sent[0].payload.data),
            `relay must carry the held card's planId, got: ${sent[0].payload.data}`);
    });

    await check('the relay precedes the seat clear and the pop', async () => {
        const { server, calls } = makeServer(boardHeldBy('Coder 1'), {
            groups: [group('Coding', ['Coder 1'])],
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        await server.reportQueueDone({ workspaceRoot: WS, from: 'Coder 1' });
        const relayAt = calls.findIndex(c => c.kind === 'verb' && typeof c.payload.data === 'string'
            && c.payload.data.startsWith('[queue/done]'));
        const clearAt = calls.findIndex(c => c.kind === 'clear');
        const dispatchAt = calls.findIndex(c => c.kind === 'dispatch');
        assert.ok(relayAt >= 0, 'the relay must fire');
        assert.ok(clearAt >= 0, 'the finishing seat must still be cleared');
        assert.ok(relayAt < clearAt, 'the relay must precede the clear — a cleared lead may lose the report');
        assert.ok(dispatchAt === -1 || relayAt < dispatchAt,
            'the relay must precede the pop — the next dispatch must not overwrite the lead\'s context first');
    });

    await check('the head\'s OWN completion does not relay to itself', async () => {
        // Seat pacing installs the queue/done order at `team-head` scope too
        // (applySeatPacingOrders), and the head is order[0] of its own roster —
        // so from === head is routine, not malformed. Prompting a seat about
        // its own completion is noise, and the clear wipes it immediately after.
        const { server, calls } = makeServer(boardHeldBy('Coding'), {
            groups: [group('Coding', ['Coder 1'])],
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'Coding' });
        assert.strictEqual(out.status, 200, `expected 200, got ${out.status}: ${out.payload.error || ''}`);
        assert.deepStrictEqual(relays(calls), [], 'the head must not be prompted about its own completion');
    });

    await check('an external-headed team does not ptySendPrompt its non-terminal head', async () => {
        // An external head (Antigravity / Cursor / IDE chat) owns no pty seat,
        // so the send is a dead click. Those workers already report through
        // EXTERNAL_HEAD_CALLBACK_INSTRUCTION, which writes into the team's
        // reports inbox — the head's real channel.
        const { server, calls } = makeServer(boardHeldBy('Coder 1'), {
            groups: [group('External Lead', ['Coder 1'], { externalHead: true })],
            resolveTeamMembers: async () => ['Coder 1'],
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'Coder 1' });
        assert.strictEqual(out.status, 200, `expected 200, got ${out.status}: ${out.payload.error || ''}`);
        assert.deepStrictEqual(relays(calls), [],
            'an external head must not be addressed by ptySendPrompt');
    });

    await check('a standalone seat on no team skips the relay', async () => {
        const { server, calls } = makeServer(boardHeldBy('StandaloneCoder'), {
            groups: [group('Coding', ['Coder 1'])],
            resolveTeamMembers: async () => null,
            getRegisteredTerminals: () => ['StandaloneCoder'],
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'StandaloneCoder' });
        assert.strictEqual(out.status, 200, `expected 200, got ${out.status}: ${out.payload.error || ''}`);
        assert.deepStrictEqual(relays(calls), [], 'a seat on no team has no head to relay to');
    });

    await check('a failed outcome does not relay a completion', async () => {
        // A `failed` report is a release, not a completion. Telling the lead a
        // member "finished" would advance a card nobody completed.
        const { server, calls } = makeServer(boardHeldBy('Coder 1'), {
            groups: [group('Coding', ['Coder 1'])],
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });
        await server.reportQueueDone({ workspaceRoot: WS, from: 'Coder 1', outcome: 'failed' });
        assert.deepStrictEqual(relays(calls), [], 'a failure must not relay a completion to the lead');
    });

    await check('a relay that throws does not abort the clear or the pop', async () => {
        const { server, calls } = makeServer(boardHeldBy('Coder 1'), {
            groups: [group('Coding', ['Coder 1'])],
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
            terminalVerbResult: (verb, payload) => {
                if (verb === 'ptySendPrompt' && String(payload.data).startsWith('[queue/done]')) {
                    throw new Error('pty host down');
                }
                return { success: true };
            },
        });
        const out = await server.reportQueueDone({ workspaceRoot: WS, from: 'Coder 1' });
        assert.strictEqual(out.status, 200, `a relay failure must not fail the completion, got ${out.status}`);
        assert.ok(calls.some(c => c.kind === 'clear'), 'the finishing seat must still be cleared');
    });

    await check('the head comes from the group, not from a fleet parent chain', async () => {
        // The registered group's `head` field is the authoritative head name.
        // A parentInstanceId walk is stale for renamed seats, missing for
        // `scope: shared` members, and resolves to Mission Control when the
        // chain breaks — none of which may redirect this relay.
        const { server, calls } = makeServer(boardHeldBy('Shared Coder'), {
            groups: [
                group('Other Lead', ['Other Coder']),
                group('Coding', ['Shared Coder']),
            ],
            resolveTeamMembers: async () => ['Coding', 'Shared Coder'],
        });
        await server.reportQueueDone({ workspaceRoot: WS, from: 'Shared Coder' });
        const sent = relays(calls);
        assert.strictEqual(sent.length, 1, 'exactly one relay, to exactly one head');
        assert.strictEqual(sent[0].payload.name, 'Coding',
            'the relay must resolve the head of the group whose roster holds the seat');
    });

    console.log('');
    if (failures > 0) {
        console.log(`${failures} check(s) failed.\n`);
        process.exit(1);
    }
    console.log('All queue/done relay checks passed.\n');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
