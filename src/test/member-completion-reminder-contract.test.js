'use strict';

/**
 * Contract: the member completion reminder sweep.
 *
 * A team coder is told how to report once, at dispatch, and needs it hours
 * later — the head is topped up throughout its life (turn-end notices plus a
 * durable head-prompt.md) and a member is not. This sweep is the member's
 * equivalent, delivered when it goes quiet holding an uncompleted card.
 *
 * Drives `_runMemberCompletionReminderSweep` directly against fakes. It loads
 * `out/services/PlanIngestionEngine.js`, which does NOT pull LocalApiServer —
 * the sibling engine suites (queue-stall-watch, completion-asserted) do, and
 * cannot load at all since RetentionService -> ArchiveManager entered that
 * import graph. Requires `npm run compile-tests` first.
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js src/test/member-completion-reminder-contract.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlanIngestionEngine } = require('../../out/services/PlanIngestionEngine');
const { TERMINALS_GROUPS_KEY } = require('../../out/services/teamWiring');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') { throw new Error('use runAsync for async tests'); }
        console.log(`  ✅ ${name}`); passed++;
    } catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}
const asyncTests = [];
function testAsync(name, fn) {
    asyncTests.push(async () => {
        try { await fn(); console.log(`  ✅ ${name}`); passed++; }
        catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
    });
}

const HEAD = 'Coding';
const MEMBER = 'Coding-coder-1';
const TEAM_ID = 'team_Coding';
const NUDGE_FLOOR_MS = 600000;
const SILENCE_MS = 90000;

/** Minimal engine instance — only `_host.logger` is touched by the sweep. */
function makeEngine() {
    const engine = Object.create(PlanIngestionEngine.prototype);
    engine._host = { logger: { appendLine: () => {} } };
    engine._memberReminderState = new Map();
    return engine;
}

function makeDb(board, groups) {
    return {
        getConfigJson: async (key) => (key === TERMINALS_GROUPS_KEY ? groups : []),
        getWorkspaceId: async () => 'ws-1',
        getDominantWorkspaceId: async () => 'ws-1',
        getBoard: async () => board,
    };
}

/** The group shape wireSpawnedTeam actually persists (verified against its literal). */
function teamGroup(extra) {
    return Object.assign({
        id: TEAM_ID,
        name: HEAD,
        head: HEAD,
        headRole: 'lead',
        source: 'manual',
        teamGroup: true,
        teamKind: 'spawned',
        members: [HEAD, MEMBER],
        order: [HEAD, MEMBER],
        externalHead: false,
    }, extra || {});
}

function heldCard(extra) {
    return Object.assign({
        planId: 'plan-1',
        planFile: '/tmp/plan-1.md',
        // T0 MINUS fifteen minutes. This used to be exactly T0 — the card was
        // "dispatched" at the same instant the sweep ran, so every assertion
        // below described a reminder fired at a seat that had held its card for
        // zero seconds. That is the reported bug (8 seconds, in the live seat
        // log) written into the fixture as the expected case. A card the seat has
        // genuinely held is the only scenario in which "you have gone idle
        // holding card X" is a true sentence.
        dispatchedAt: new Date(1788750000000 - 900000).toISOString(),
        dispatchedTerminal: MEMBER,
        completedAt: null,
        kanbanColumn: 'CODER CODED',
    }, extra || {});
}

async function sweep(engine, opts) {
    const sent = [];
    engine._turnEndNotifier = (info) => sent.push(info);
    await engine._runMemberCompletionReminderSweep({
        db: makeDb(opts.board, opts.groups),
        folder: opts.folder,
        liveness: opts.liveness,
        nowMs: opts.nowMs,
        turnEndSilenceMs: SILENCE_MS,
        nudgeSilenceMs: NUDGE_FLOOR_MS,
        notifiedSeatsThisTick: opts.notified || new Set(),
    });
    return sent;
}

const T0 = 1788750000000;
const quiet = (name, ageMs) => ({ friendlyName: name, lastDataAt: T0 - ageMs, status: 'active' });

// ── 1. The core delivery ────────────────────────────────────────────────

// The reminder must describe POST-DISPATCH silence. Measured failure
// (2026-09-08, seat log `Coding-coder-2`): a card dispatched at 00:10:03Z drew a
// reminder at 00:10:11Z — eight seconds, 26k/200k context, before the coder had
// done anything, because gate 5 compared a CACHED pre-dispatch `lastDataAt`
// against the silence window and read "silent for hours".

testAsync('a freshly dispatched seat is NOT reminded, however stale its lastDataAt', async () => {
    // The seat sat idle for an hour waiting for work, then was handed a card one
    // second ago. `lastDataAt` is an hour old and the cache has not refreshed.
    const sent = await sweep(makeEngine(), {
        folder: '/ws',
        board: [heldCard({ dispatchedAt: new Date(T0 - 1000).toISOString() })],
        groups: [teamGroup()],
        liveness: [quiet(MEMBER, 3600000), quiet(HEAD, 1000)], nowMs: T0,
    });
    assert.strictEqual(sent.length, 0,
        'a card held for one second cannot have gone idle — the silence predates the dispatch');
});

testAsync('a seat that has produced no output since dispatch is NOT reminded', async () => {
    // Card held well past the silence window, but every byte this seat ever
    // produced predates the dispatch: it is booting or dead, not idle-after-work.
    // The dispatch-stall sweep owns that case.
    const sent = await sweep(makeEngine(), {
        folder: '/ws',
        board: [heldCard({ dispatchedAt: new Date(T0 - (SILENCE_MS * 4)).toISOString() })],
        groups: [teamGroup()],
        liveness: [quiet(MEMBER, SILENCE_MS * 8), quiet(HEAD, 1000)], nowMs: T0,
    });
    assert.strictEqual(sent.length, 0,
        'no output since dispatch is not evidence of a finished turn');
});

testAsync('a seat that worked and then went quiet IS reminded', async () => {
    // The case the reminder exists for: dispatched long ago, produced output
    // after the dispatch, and has now been silent for a full window.
    const sent = await sweep(makeEngine(), {
        folder: '/ws',
        board: [heldCard({ dispatchedAt: new Date(T0 - (SILENCE_MS * 10)).toISOString() })],
        groups: [teamGroup()],
        liveness: [quiet(MEMBER, SILENCE_MS + 1000), quiet(HEAD, 1000)], nowMs: T0,
    });
    assert.strictEqual(sent.length, 1, 'post-dispatch output then silence is the real trigger');
});

testAsync('a member quiet past turnEndSilenceMs holding an uncompleted card is reminded', async () => {
    const sent = await sweep(makeEngine(), {
        folder: '/ws', board: [heldCard()], groups: [teamGroup()],
        liveness: [quiet(MEMBER, SILENCE_MS + 1000), quiet(HEAD, 1000)], nowMs: T0,
    });
    assert.strictEqual(sent.length, 1, 'expected one reminder');
    assert.strictEqual(sent[0].recipientSeat, MEMBER, 'the member is the recipient, not its head');
    assert.strictEqual(sent[0].bareDelivery, true, 'the reminder must suppress the standing-orders block');
    assert.ok(/plan-1/.test(sent[0].body), 'the body must name the held card');
});

testAsync('a member still mid-turn is not interrupted', async () => {
    const sent = await sweep(makeEngine(), {
        folder: '/ws', board: [heldCard()], groups: [teamGroup()],
        liveness: [quiet(MEMBER, SILENCE_MS - 1000)], nowMs: T0,
    });
    assert.strictEqual(sent.length, 0);
});

testAsync('a card with completedAt set produces nothing', async () => {
    const sent = await sweep(makeEngine(), {
        folder: '/ws', board: [heldCard({ completedAt: '2026-09-07T03:05:00.000Z' })], groups: [teamGroup()],
        liveness: [quiet(MEMBER, SILENCE_MS + 1000)], nowMs: T0,
    });
    assert.strictEqual(sent.length, 0);
});

testAsync('the head is never reminded — it has head-prompt.md and the turn-end top-up', async () => {
    const sent = await sweep(makeEngine(), {
        folder: '/ws', board: [heldCard({ dispatchedTerminal: HEAD })], groups: [teamGroup()],
        liveness: [quiet(HEAD, SILENCE_MS + 1000)], nowMs: T0,
    });
    assert.strictEqual(sent.length, 0, 'the head is roster[0] and must be filtered by name === group.head');
});

testAsync('a standalone (non-team) seat is never reminded', async () => {
    const sent = await sweep(makeEngine(), {
        folder: '/ws', board: [heldCard({ dispatchedTerminal: 'planner-1' })], groups: [teamGroup()],
        liveness: [quiet('planner-1', SILENCE_MS + 1000)], nowMs: T0,
    });
    assert.strictEqual(sent.length, 0);
});

testAsync('empty liveness is NO EVIDENCE, not "everyone is quiet"', async () => {
    const sent = await sweep(makeEngine(), {
        folder: '/ws', board: [heldCard()], groups: [teamGroup()], liveness: [], nowMs: T0,
    });
    assert.strictEqual(sent.length, 0);
});

testAsync('an exited seat is left to the queue sweep, not reminded', async () => {
    const sent = await sweep(makeEngine(), {
        folder: '/ws', board: [heldCard()], groups: [teamGroup()],
        liveness: [{ friendlyName: MEMBER, lastDataAt: T0 - SILENCE_MS - 1000, status: 'exited' }], nowMs: T0,
    });
    assert.strictEqual(sent.length, 0);
});

testAsync('a group that is not a spawned team is ignored', async () => {
    const manual = teamGroup({ teamGroup: false, teamKind: 'manual' });
    const sent = await sweep(makeEngine(), {
        folder: '/ws', board: [heldCard()], groups: [manual],
        liveness: [quiet(MEMBER, SILENCE_MS + 1000)], nowMs: T0,
    });
    assert.strictEqual(sent.length, 0);
});

// ── 2. The budget — the regression this suite exists for ────────────────
//
// The reminder is itself a prompt: it echoes into the pty and the agent
// answers it, so `lastDataAt` ALWAYS advances afterwards. A dedupe that
// re-arms on "output since the last reminder" therefore re-arms on the
// reminder's own consequence and nags every nudgeSilenceMs forever — on a
// card whose `completedAt` only the LEAD ever writes, so it may never be set
// at all.

testAsync('a seat that stays quiet is reminded once, not per tick', async () => {
    const engine = makeEngine();
    const base = { folder: '/ws', board: [heldCard()], groups: [teamGroup()] };
    const first = await sweep(engine, Object.assign({}, base, { liveness: [quiet(MEMBER, SILENCE_MS + 1000)], nowMs: T0 }));
    assert.strictEqual(first.length, 1);
    // Next tick, 10s later, seat still silent.
    const second = await sweep(engine, Object.assign({}, base, { liveness: [{ friendlyName: MEMBER, lastDataAt: T0 - SILENCE_MS - 1000, status: 'active' }], nowMs: T0 + 10000 }));
    assert.strictEqual(second.length, 0, 'the pacing floor must hold within nudgeSilenceMs');
});

testAsync('the reminder\'s own echo cannot re-arm the reminder (no nag loop)', async () => {
    const engine = makeEngine();
    const base = { folder: '/ws', board: [heldCard()], groups: [teamGroup()] };
    let now = T0;
    let sends = 0;
    // Twelve windows, each one past the pacing floor, each with lastDataAt
    // advanced as it would be by the previous reminder's echo and answer.
    for (let i = 0; i < 12; i++) {
        const sent = await sweep(engine, Object.assign({}, base, {
            liveness: [{ friendlyName: MEMBER, lastDataAt: now - SILENCE_MS - 1000, status: 'active' }],
            nowMs: now,
        }));
        sends += sent.length;
        now += NUDGE_FLOOR_MS + 1000;
    }
    assert.strictEqual(sends, 2,
        `a card dispatch must yield at most MAX_MEMBER_REMINDERS_PER_DISPATCH reminders, got ${sends}. `
        + 'Re-arming on advanced lastDataAt nags forever, because the reminder is itself output.');
});

testAsync('a NEW dispatchedAt re-arms the budget — new work, the one signal a reminder cannot fake', async () => {
    const engine = makeEngine();
    const groups = [teamGroup()];
    let now = T0;
    let sends = 0;
    for (let i = 0; i < 6; i++) {
        const sent = await sweep(engine, {
            folder: '/ws', board: [heldCard()], groups,
            liveness: [{ friendlyName: MEMBER, lastDataAt: now - SILENCE_MS - 1000, status: 'active' }],
            nowMs: now,
        });
        sends += sent.length;
        now += NUDGE_FLOOR_MS + 1000;
    }
    assert.strictEqual(sends, 2, 'budget spent on the first card');
    // A second card dispatched to the same seat.
    const afterRedispatch = await sweep(engine, {
        // Relative to the advanced `now`, not a fixed future timestamp: the
        // re-arm keys on the dispatchedAt STRING (so it only has to differ), but
        // the post-dispatch-silence gate needs it to be genuinely in the past.
        folder: '/ws', board: [heldCard({ planId: 'plan-2', dispatchedAt: new Date(now - 900000).toISOString() })], groups,
        liveness: [{ friendlyName: MEMBER, lastDataAt: now - SILENCE_MS - 1000, status: 'active' }],
        nowMs: now,
    });
    assert.strictEqual(afterRedispatch.length, 1, 'a new dispatch must re-arm the budget');
    assert.ok(/plan-2/.test(afterRedispatch[0].body));
});

testAsync('a seat already notified this tick by another sweep is not double-woken', async () => {
    const sent = await sweep(makeEngine(), {
        folder: '/ws', board: [heldCard()], groups: [teamGroup()],
        liveness: [quiet(MEMBER, SILENCE_MS + 1000)], nowMs: T0,
        notified: new Set([MEMBER]),
    });
    assert.strictEqual(sent.length, 0);
});

// ── 3. The pointer must name a file the seat can open ───────────────────

testAsync('the body names the orders file by ABSOLUTE path when it exists', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-member-orders-'));
    const dir = path.join(root, '.switchboard', 'teams', TEAM_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'member-orders.md'), '# orders\n', 'utf8');
    const sent = await sweep(makeEngine(), {
        folder: root, board: [heldCard()], groups: [teamGroup()],
        liveness: [quiet(MEMBER, SILENCE_MS + 1000)], nowMs: T0,
    });
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].body.includes(path.join(root, '.switchboard', 'teams', TEAM_ID, 'member-orders.md')),
        `body must carry the absolute orders path — a relative one resolves against the SEAT's cwd, `
        + `which for a worktree member is not where the file was written. Body: ${sent[0].body}`);
});

testAsync('an absent orders file falls back to the route, never a dangling path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-member-orders-none-'));
    const sent = await sweep(makeEngine(), {
        folder: root, board: [heldCard()], groups: [teamGroup()],
        liveness: [quiet(MEMBER, SILENCE_MS + 1000)], nowMs: T0,
    });
    assert.strictEqual(sent.length, 1);
    assert.ok(!/member-orders\.md/.test(sent[0].body),
        `the body must not point at a file that is not there. Body: ${sent[0].body}`);
    assert.ok(/done --from/.test(sent[0].body), 'the fallback must name the completion route itself');
    assert.ok(!/<cliPath>/.test(sent[0].body), 'the <cliPath> token must be substituted before delivery');
});

testAsync('an external-headed member gets the report-file route, not the POST recipe', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-member-orders-ext-'));
    const ext = teamGroup({ externalHead: true, members: [MEMBER], order: [MEMBER] });
    const sent = await sweep(makeEngine(), {
        folder: root, board: [heldCard()], groups: [ext],
        liveness: [quiet(MEMBER, SILENCE_MS + 1000)], nowMs: T0,
    });
    assert.strictEqual(sent.length, 1);
    assert.ok(/reports/.test(sent[0].body), `external-head members report by writing a file. Body: ${sent[0].body}`);
    assert.ok(!/done --from/.test(sent[0].body), 'an external-head member must not be given the POST recipe');
});

// ── 4. Both hosts honour bareDelivery (SEAT BLOCK ONLY) ─────────────────

/**
 * REVISED. This gate used to assert that `bareDelivery` suppressed the
 * STANDING-ORDERS block in both hosts. That assertion contradicted
 * `seat-safeguards-fleet-prompt-path.test.js`'s "notifyTurnEnd must NOT pass
 * standingOrders: false — the recipient acts on this notification and needs its
 * standing orders", so one of the two was red at HEAD no matter what the code
 * did. The orders rule settles it: standing orders ride EVERY prompt delivery
 * and the only gate is the caller's explicit opt-out, so `bareDelivery` now
 * suppresses the seat block and nothing else.
 *
 * What `bareDelivery` still buys the member reminder is the SHORT BODY — a
 * pointer instead of the full recipe — which is asserted by the body-composition
 * tests above, not here.
 */
test('both composition roots keep bareDelivery to the seat block, not the orders', () => {
    const tvp = fs.readFileSync(path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts'), 'utf8');
    const boot = fs.readFileSync(path.join(__dirname, '..', 'standalone', 'bootstrap.ts'), 'utf8');
    assert.ok(!/info\.bareDelivery\s*\?\s*\{\s*standingOrders:\s*false/.test(tvp),
        'TaskViewerProvider.notifyTurnEnd must NOT map bareDelivery to an orders opt-out');
    assert.ok(!/deliverPrompt\([^)]*!info\.bareDelivery/.test(boot),
        'bootstrap.handleTurnEndNotify must NOT pass !info.bareDelivery as the standingOrders argument');
    // The seat-block suppression is the part that survives, in both hosts.
    assert.ok(/seatBlock: false/.test(tvp),
        'TaskViewerProvider.notifyTurnEnd must still opt out of the seat block');
    assert.ok(/deliverPrompt\(handle, message, \{ clearBeforePrompt: false \}, true, false\)/.test(boot),
        'bootstrap turn-end must pass applyOrders=true, applySeatBlock=false');
});

test('every production wireSpawnedTeam call site passes workspaceRoot', () => {
    const files = [
        ['agentGroupInstantiation.ts', path.join(__dirname, '..', 'services', 'agentGroupInstantiation.ts')],
        ['TaskViewerProvider.ts', path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts')],
        ['bootstrap.ts', path.join(__dirname, '..', 'standalone', 'bootstrap.ts')],
    ];
    let sites = 0;
    for (const [label, file] of files) {
        const src = fs.readFileSync(file, 'utf8');
        const re = /wireSpawnedTeam\(\{/g;
        let m;
        while ((m = re.exec(src)) !== null) {
            sites++;
            // The call's argument object, to the matching close.
            const window = src.slice(m.index, m.index + 1200);
            assert.ok(/workspaceRoot/.test(window),
                `${label}: a wireSpawnedTeam call at offset ${m.index} omits workspaceRoot — `
                + 'the member orders file is then never written and the fragment pointer dangles');
        }
    }
    assert.strictEqual(sites, 4, `expected 4 wireSpawnedTeam call sites, found ${sites}`);
});

(async () => {
    for (const t of asyncTests) { await t(); }
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
})();
