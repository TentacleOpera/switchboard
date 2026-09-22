'use strict';

/**
 * "The Board Can Stop a Team In One Call" — `POST /kanban/team/stop`.
 *
 * Stopping a team is ONE server verb: pause the missions the team holds,
 * release the cards its seats hold, close its seats — in that order, as one
 * operation the board owns. It used to be a client fan-out over
 * `ptyCloseTerminal` after a separate pause call, so a tab that died midway
 * left a half-stopped team and no non-browser caller could stop a team at all.
 *
 * The cases below pin the five things a diff cannot show:
 *  - the three steps run in that ORDER: pause, then release, then close;
 *  - the roster is the SERVER's (`resolveTeamMembers`), never the request body;
 *  - a stop RELEASES the cards it holds and never completes them;
 *  - a partial stop reports as partial, naming the seat that did not close;
 *  - an unreadable roster is a partial stop, not a quiet one-seat team.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

require(path.join(process.cwd(), 'src', 'test', 'bootstrap', 'sandboxStateHome.js'));

const { LocalApiServer } = require(path.join(process.cwd(), 'out', 'services', 'LocalApiServer.js'));

const GROUPS_KEY = 'switchboard.prompts.terminals.groups';
const WS = '/tmp/team-stop-ws';

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

/** A board row shaped the way `getBoard` returns them. */
function card(planId, extra = {}) {
    return {
        planId,
        sessionId: planId,
        topic: planId,
        planFile: `.switchboard/plans/${planId}.md`,
        kanbanColumn: 'CODER CODED',
        featureId: '',
        ownerSince: null,
        ownerSeat: '',
        columnOrder: null,
        completedAt: null,
        workspaceId: 'ws1',
        ...extra,
    };
}

/** A live team group row, as `wireSpawnedTeam` writes one. */
function group(id, head, members, definitionId) {
    return { id, name: head, head, members, order: [...members], definitionId };
}

/**
 * A LocalApiServer wired with a team-aware kanban db and a pty seam that
 * records the ORDER of every step it is asked to perform. `calls` is the
 * ordering evidence; `live` is the fleet the seam reports.
 */
function makeServer(opts = {}) {
    const calls = [];
    const board = opts.board || [];
    const live = [...(opts.live || [])];
    const config = new Map();
    config.set(GROUPS_KEY, opts.groups || []);
    const db = {
        getWorkspaceId: async () => 'ws1',
        getDominantWorkspaceId: async () => 'ws1',
        getBoard: async () => board,
        getConfigJson: async (key, fallback) => (config.has(key) ? config.get(key) : fallback),
        clearOwnerStamp: async (planFile) => {
            calls.push(`release:${planFile}`);
            const row = board.find(p => p && p.planFile === planFile);
            if (!row) { return false; }
            row.ownerSeat = '';
            row.ownerSince = null;
            return true;
        },
        pauseMissionsForTeam: async (teamId) => {
            calls.push(`pause:${teamId}`);
            return opts.pauseResult || { paused: [], skipped: [] };
        },
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
        getKanbanDatabase: async () => db,
        resolveTeamMembers: opts.resolveTeamMembers,
        terminalVerb: async (verb, payload) => {
            if (verb === 'ptyListTerminals') {
                calls.push('list');
                if (opts.listResult) { return opts.listResult(); }
                return { success: true, terminals: live.map(n => ({ friendlyName: n, status: 'active' })) };
            }
            if (verb === 'ptyCloseTerminal') {
                calls.push(`close:${payload.name}`);
                const result = opts.closeResult ? opts.closeResult(payload.name) : { success: true };
                if (!result || result.success !== false) {
                    const i = live.indexOf(payload.name);
                    if (i >= 0) { live.splice(i, 1); }
                }
                return result || { success: true };
            }
            return { success: false, error: `unexpected verb '${verb}'` };
        },
    });
    return { server, calls, board, live, db };
}

async function postStop(server, body) {
    const req = {
        method: 'POST',
        url: '/kanban/team/stop',
        headers: {
            'content-type': 'application/json',
            'authorization': 'Bearer test-token',
            'x-switchboard-client': 'contract-test',
        },
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
        getHeaders: () => ({}),
        getHeader: () => undefined,
        end: (data) => { responseBody = data ? JSON.parse(data) : null; },
    };
    await server._handleRequest(req, res);
    return { status, body: responseBody };
}

async function run() {
    console.log('\nteam stop contract\n');

    await check('pause, release and close run in that order, and the hold is released not completed', async () => {
        const board = [card('card-a', { ownerSeat: 'Coder 1' }), card('card-b', { ownerSeat: 'Coder 2' })];
        const { server, calls } = makeServer({
            groups: [group('team_Coding', 'Coding', ['Coding', 'Coder 1', 'Coder 2'], 'def-coding')],
            board,
            live: ['Coding', 'Coder 1', 'Coder 2'],
            resolveTeamMembers: async () => ['Coding', 'Coder 1', 'Coder 2'],
            pauseResult: { paused: ['mission-a'], skipped: [] },
        });

        const out = await postStop(server, { teamId: 'def-coding' });
        assert.strictEqual(out.status, 200, `expected 200, got ${out.status}: ${out.body && out.body.error}`);
        assert.strictEqual(out.body.status, 'stopped', 'a complete stop reports as complete');
        assert.deepStrictEqual(out.body.paused, ['mission-a'], 'the paused mission must be reported');
        assert.deepStrictEqual([...out.body.released].sort(), ['card-a', 'card-b'], 'both held cards release');
        assert.deepStrictEqual([...out.body.releasedSeats].sort(), ['Coder 1', 'Coder 2']);
        assert.deepStrictEqual([...out.body.closed].sort(), ['Coder 1', 'Coder 2', 'Coding'], 'every seat closes');
        assert.deepStrictEqual(out.body.closeFailed, []);

        // RELEASE, never complete: the cards keep no completion, and their
        // owner stamps are gone.
        assert.ok(board.every(p => p.completedAt === null),
            'a stop must never mark a card finished — it releases the hold, it does not complete the work');
        assert.ok(board.every(p => p.ownerSeat === ''),
            'every card the team held must have its owner stamp cleared');

        // The ORDER is load-bearing. Closing before releasing produces orphans;
        // releasing before pausing lets the queue re-dispatch into dead seats.
        const at = (prefix) => calls.findIndex(c => c.startsWith(prefix));
        assert.ok(at('pause:') >= 0 && at('release:') >= 0 && at('close:') >= 0, 'all three steps must run');
        assert.ok(at('pause:') < at('release:'), 'the missions pause BEFORE the holds are released');
        assert.ok(at('release:') < at('close:'), 'the holds are released BEFORE the seats are closed');
    });

    await check('the roster is the server\'s — a caller-supplied seat list is ignored', async () => {
        const board = [
            card('card-resolved', { ownerSeat: 'Coder 1' }),
            card('card-rogue', { ownerSeat: 'Ghost 1' }),
        ];
        const { server, calls } = makeServer({
            // The GROUP row names Ghost 1; `resolveTeamMembers` does not. The
            // stop must follow the resolver the queue uses, not the group row
            // and not the caller.
            groups: [group('team_Coding', 'Coding', ['Coding', 'Ghost 1'], 'def-coding')],
            board,
            live: ['Coding', 'Coder 1', 'Ghost 1'],
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });

        const out = await postStop(server, {
            teamId: 'def-coding',
            seats: ['Ghost 1'],
            members: ['Ghost 1'],
            roster: ['Ghost 1'],
        });
        assert.strictEqual(out.status, 200, `expected 200, got ${out.status}: ${out.body && out.body.error}`);
        assert.deepStrictEqual(out.body.released, ['card-resolved'],
            'only a card held by a RESOLVED seat releases — the caller\'s seat list names nothing');
        assert.ok(!out.body.released.includes('card-rogue'), 'the rogue card must keep its hold');
        assert.ok(!out.body.closed.includes('Ghost 1'),
            'a seat outside the resolved roster is never closed, however the caller spells the request');
        assert.ok(calls.includes('close:Coder 1') && calls.includes('close:Coding'),
            'the resolved seats are the ones closed');
        assert.ok(!calls.includes('close:Ghost 1'), 'the caller-supplied seat is not closed');
    });

    await check('a failing seat close is a partial stop that names the seat', async () => {
        const board = [card('card-a', { ownerSeat: 'Coder 1' })];
        const { server } = makeServer({
            groups: [group('team_Coding', 'Coding', ['Coding', 'Coder 1'], 'def-coding')],
            board,
            live: ['Coding', 'Coder 1'],
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
            pauseResult: { paused: ['mission-a'], skipped: [] },
            closeResult: (name) => (name === 'Coder 1'
                ? { success: false, error: 'the pty host refused' }
                : { success: true }),
        });

        const out = await postStop(server, { teamId: 'def-coding' });
        assert.strictEqual(out.status, 200, 'a partial stop is a performed operation, not an HTTP failure');
        assert.strictEqual(out.body.status, 'partial', 'a partial stop must report as partial');
        assert.deepStrictEqual(out.body.closed, ['Coding']);
        assert.deepStrictEqual(out.body.closeFailed, [{ seat: 'Coder 1', reason: 'the pty host refused' }],
            'the seat that did not close must be named, with the host\'s own reason');
        assert.deepStrictEqual(out.body.paused, ['mission-a'], 'the pause is still reported as done');
        assert.deepStrictEqual(out.body.released, ['card-a'], 'the release is still reported as done');
    });

    await check('a seat that exited before the close is alreadyGone, not a failure', async () => {
        const board = [card('card-a', { ownerSeat: 'Coder 1' })];
        const { server, calls } = makeServer({
            groups: [group('team_Coding', 'Coding', ['Coding', 'Coder 1'], 'def-coding')],
            board,
            // Coder 1 is on the roster but no longer in the fleet.
            live: ['Coding'],
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
        });

        const out = await postStop(server, { teamId: 'def-coding' });
        assert.strictEqual(out.body.status, 'stopped', 'a seat that had already exited is not a failure');
        assert.deepStrictEqual(out.body.alreadyGone, ['Coder 1']);
        assert.deepStrictEqual(out.body.closeFailed, []);
        assert.ok(!calls.includes('close:Coder 1'), 'a seat that is already gone is not closed twice');
    });

    await check('a team with no missions and no held cards stops cleanly and reports zeros', async () => {
        const { server } = makeServer({
            groups: [group('team_Coding', 'Coding', ['Coding', 'Coder 1'], 'def-coding')],
            board: [card('unrelated')],
            live: ['Coding', 'Coder 1'],
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
            pauseResult: { paused: [], skipped: [] },
        });

        const out = await postStop(server, { teamId: 'def-coding' });
        assert.strictEqual(out.status, 200);
        assert.strictEqual(out.body.status, 'stopped');
        assert.deepStrictEqual(out.body.paused, []);
        assert.deepStrictEqual(out.body.released, []);
        assert.deepStrictEqual(out.body.failed, []);
        assert.deepStrictEqual(out.body.closeFailed, []);
        assert.deepStrictEqual([...out.body.closed].sort(), ['Coder 1', 'Coding'],
            'a team with nothing in flight still has its seats closed');
    });

    await check('an unreadable roster is a partial stop, not a quiet one-seat team', async () => {
        const { server } = makeServer({
            groups: [group('team_Coding', 'Coding', ['Coding', 'Coder 1'], 'def-coding')],
            board: [],
            live: ['Coding', 'Coder 1'],
            resolveTeamMembers: async () => null,
        });

        const out = await postStop(server, { teamId: 'def-coding' });
        assert.strictEqual(out.body.status, 'partial',
            'the roster could not be read — that is not a one-seat team, and it must not pass for one');
        assert.strictEqual(out.body.rosterResolved, false);
        assert.deepStrictEqual(out.body.closed, ['Coding'], 'the head alone is all the server could resolve');
    });

    await check('an unreadable fleet is a failure, never an empty fleet', async () => {
        const { server } = makeServer({
            groups: [group('team_Coding', 'Coding', ['Coding', 'Coder 1'], 'def-coding')],
            board: [],
            live: ['Coding', 'Coder 1'],
            resolveTeamMembers: async () => ['Coding', 'Coder 1'],
            listResult: () => ({ success: false, error: 'PTY terminals are unavailable' }),
            closeResult: () => ({ success: false, error: 'PTY terminals are unavailable' }),
        });

        const out = await postStop(server, { teamId: 'def-coding' });
        assert.strictEqual(out.body.status, 'partial', 'a host that cannot close anything is a partial stop');
        assert.deepStrictEqual(out.body.alreadyGone, [],
            'a FAILED fleet read must never read as "every seat is already gone" — the quiet wrong answer');
        assert.deepStrictEqual([...out.body.closeFailed.map(f => f.seat)].sort(), ['Coder 1', 'Coding'],
            'each seat that could not be closed is named');
    });

    await check('a request with no team is refused loudly', async () => {
        const { server, calls } = makeServer({ groups: [], board: [], live: [] });
        const out = await postStop(server, {});
        assert.strictEqual(out.status, 400, 'a nameless team must refuse');
        assert.deepStrictEqual(calls, [], 'nothing runs on a refused request');
    });

    await check('a team this host has never spawned is refused loudly', async () => {
        const { server } = makeServer({ groups: [], board: [], live: [] });
        const out = await postStop(server, { teamId: 'def-nowhere' });
        assert.strictEqual(out.status, 404, 'a stop of a team that is not running must refuse, never report success');
    });

    await check('the route is reachable, and /kanban/team/* rides the mission handler', () => {
        const api = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        assert.ok(/pathname\.startsWith\('\/kanban\/team\/'\)/.test(api),
            'the dispatcher must route /kanban/team/* — an arm no request reaches is dead code, which is exactly how the shipped team/release button came to 404 into an apparently inert one');
        const routeStart = api.indexOf("pathname === '/kanban/team/stop'");
        assert.ok(routeStart > 0, 'the stop route must exist');
        const routeEnd = api.indexOf("pathname === '/kanban/", routeStart + 1);
        const route = api.slice(routeStart, routeEnd > routeStart ? routeEnd : routeStart + 6000);
        assert.ok(!/\bcompleted_at\b|\breleased_at\b/.test(route),
            'the stop route must not write completed_at or released_at — it releases the hold, it does not complete the work');
    });

    if (failures > 0) {
        console.log(`\n${failures} team stop check(s) failed\n`);
        process.exit(1);
    }
    console.log('\nAll team stop checks passed\n');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
