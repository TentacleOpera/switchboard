'use strict';

/**
 * Queue Stall Watch Contract — a completed card is not in flight.
 *
 * Covers:
 * 1. Head pacing: a team whose only held card carries completed_at is NOT in
 *    flight — the sweep nudges, and a second tick does not reset its nudge
 *    state (the in-flight branch's reset is the defect's signature).
 * 2. Head pacing: a team with an outstanding dispatch (dispatched_at set,
 *    completed_at NULL) IS in flight and the sweep stays silent.
 * 2b. Head pacing: a holder with dispatched_at cleared is NOT in flight — a
 *    released latch is not an outstanding dispatch.
 * 3. Seat pacing: a completed card with a dead holder does NOT resolve as the
 *    pacer, and the escalation recorder is not called.
 * 4. Escalation ladder: reportQueueDone(outcome:'failed') against a card carrying
 *    completed_at re-stages nothing and moves no column.
 * 5. Source pins: CODING_COLUMNS is absent from PlanIngestionEngine.ts, and the
 *    STAGING queue definition read is retained.
 *
 * See `.switchboard/plans/a-completed-card-is-not-in-flight.md`.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

require(path.join(process.cwd(), 'src', 'test', 'bootstrap', 'sandboxStateHome.js'));

const { LocalApiServer } = require(path.join(process.cwd(), 'out', 'services', 'LocalApiServer.js'));
const { PlanIngestionEngine } = require(path.join(process.cwd(), 'out', 'services', 'PlanIngestionEngine.js'));
const { createStandalonePlanIngestionHost } = require(path.join(process.cwd(), 'out', 'standalone', 'planIngestionHost.js'));

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

const WS = '/tmp/queue-stall-watch-contract-ws';

function card(planId, kanbanColumn, extra = {}) {
    return {
        planId,
        sessionId: planId,
        topic: planId,
        planFile: `.switchboard/plans/${planId}.md`,
        kanbanColumn,
        featureId: '',
        dispatchedAt: null,
        dispatchedTerminal: '',
        queuePosition: null,
        completedAt: null,
        workspaceId: 'ws1',
        ...extra,
    };
}

function makeEngineHarness(opts = {}) {
    const configMap = new Map();
    const config = {
        getConfigBoolean: (k, d) => d,
        getConfigNumber: (k, d) => d,
        getConfigJson: (k, d) => configMap.has(k) ? configMap.get(k) : d,
        getConfigString: (k, d) => d ?? '',
    };
    const host = createStandalonePlanIngestionHost({
        workspaceRoot: WS,
        config,
        extraRoots: [],
        log: () => {},
    });
    const getSvc = () => null;
    const engine = new PlanIngestionEngine(getSvc, getSvc, host, getSvc);

    const notifications = [];
    const escalations = [];

    engine.setTurnEndNotifier((info) => {
        notifications.push(info);
    });

    if (opts.pacing) {
        engine.setQueuePacingResolver(async () => opts.pacing);
    }
    if (opts.teamMembers) {
        engine.setQueueTeamMembersResolver(async () => opts.teamMembers);
    }
    if (opts.escalationRecorder) {
        engine.setQueueEscalationRecorder(opts.escalationRecorder);
    } else {
        engine.setQueueEscalationRecorder(async (wsRoot, planId, fromSeat) => {
            escalations.push({ wsRoot, planId, fromSeat });
            return true;
        });
    }

    const db = {
        getWorkspaceId: async () => 'ws1',
        getDominantWorkspaceId: async () => 'ws1',
        getBoard: async () => opts.board || [],
        getConfigJson: async (key, fallback) => configMap.has(key) ? configMap.get(key) : (opts.configs?.[key] ?? fallback),
        setConfigJson: async (key, val) => {
            configMap.set(key, val);
            if (opts.configs) opts.configs[key] = val;
        },
    };

    return {
        engine,
        db,
        notifications,
        escalations,
        configMap,
    };
}

async function run() {
    console.log('\nqueue-stall-watch contract\n');

    // ── 1. Head pacing: completed card is NOT in flight across multiple ticks ──

    await check('head pacing: team with completed card is NOT in flight and nudges across ticks', async () => {
        const board = [
            card('staged-1', 'STAGING', { queuePosition: 1 }),
            card('sub-1', 'LEAD CODED', {
                dispatchedTerminal: 'Coding',
                dispatchedAt: '2026-08-26T10:00:00Z',
                completedAt: '2026-08-26T10:05:00Z',
            }),
        ];
        const watch = {
            workspaceRoot: WS,
            headTerminal: 'Coding',
            armedAt: 1000,
            nudgeCount: 0,
            lastNudgedAt: 0,
        };
        const configs = {
            'kanban.queueWatches': [watch],
        };
        const { engine, db, notifications } = makeEngineHarness({
            board,
            configs,
            pacing: 'head',
            teamMembers: ['Coding', 'Coder-1'],
        });

        const liveness = [{ friendlyName: 'Coding', lastDataAt: 1000, status: 'running' }];

        // Tick 1: at 200s (quiet > 90s)
        await engine._runQueueNudgeSweep({
            db,
            folder: WS,
            liveness,
            nowMs: 200000,
            turnEndSilenceMs: 90000,
            nudgeSilenceMs: 90000,
            notifiedSeatsThisTick: new Set(),
        });

        assert.strictEqual(notifications.length, 1, 'tick 1 must nudge when held card is completed');
        assert.strictEqual(notifications[0].seatName, 'Coding');
        assert.strictEqual(notifications[0].outcome, 'stalled');
        assert.strictEqual(watch.nudgeCount, 1, 'watch nudgeCount must increment');

        // Tick 2: at 300s (quiet > another 90s nudgeSilenceMs)
        await engine._runQueueNudgeSweep({
            db,
            folder: WS,
            liveness,
            nowMs: 300000,
            turnEndSilenceMs: 90000,
            nudgeSilenceMs: 90000,
            notifiedSeatsThisTick: new Set(),
        });

        // Gate (8) — "one nudge, then stop" — legitimately suppresses a SECOND
        // nudge; repeating every window is the noise the sweep exists to avoid.
        // So a second NOTIFICATION is the wrong thing to assert. The defect's
        // signature is different and is what this pins: the in-flight branch
        // RESETS nudgeCount / lastNudgedAt / escalatedAt on every tick, so a
        // sweep that reads the completed card as in flight arrives back at
        // nudgeCount 0 forever and can never reach the nudge at all. Surviving
        // nudge state across a second tick IS the proof the branch was not
        // taken — which one tick alone cannot show.
        assert.strictEqual(notifications.length, 1, 'tick 2 must not re-nudge — the one-nudge budget (gate 8) holds');
        assert.strictEqual(watch.nudgeCount, 1, 'tick 2 must NOT reset nudgeCount — a completed card is not in flight');
        assert.strictEqual(watch.lastNudgedAt, 200000, 'tick 2 must NOT reset lastNudgedAt — a completed card is not in flight');
    });

    // ── 2. Head pacing: outstanding dispatch IS in flight ──────────────────

    await check('head pacing: outstanding dispatch (dispatched_at set, no completed_at) suppresses nudge', async () => {
        const board = [
            card('staged-1', 'STAGING', { queuePosition: 1 }),
            card('sub-1', 'CODER CODED', {
                dispatchedTerminal: 'Coder-1',
                dispatchedAt: '2026-08-26T10:00:00Z',
                completedAt: null,
            }),
        ];
        const watch = {
            workspaceRoot: WS,
            headTerminal: 'Coding',
            armedAt: 1000,
            nudgeCount: 1,
            lastNudgedAt: 150000,
        };
        const configs = {
            'kanban.queueWatches': [watch],
        };
        const { engine, db, notifications } = makeEngineHarness({
            board,
            configs,
            pacing: 'head',
            teamMembers: ['Coding', 'Coder-1'],
        });

        const liveness = [
            { friendlyName: 'Coding', lastDataAt: 1000, status: 'running' },
            { friendlyName: 'Coder-1', lastDataAt: 1000, status: 'running' },
        ];

        await engine._runQueueNudgeSweep({
            db,
            folder: WS,
            liveness,
            nowMs: 300000,
            turnEndSilenceMs: 90000,
            nudgeSilenceMs: 90000,
            notifiedSeatsThisTick: new Set(),
        });

        assert.strictEqual(notifications.length, 0, 'outstanding dispatch must suppress nudge');
        assert.strictEqual(watch.nudgeCount, 0, 'in-flight dispatch must reset nudgeCount');
        assert.strictEqual(watch.lastNudgedAt, 0, 'in-flight dispatch must reset lastNudgedAt');
    });

    // ── 2b. Head pacing: a released latch is not an outstanding dispatch ────
    //
    // The `dispatched_at` half of the predicate, pinned on its own. A holder
    // alone is NOT a dispatch: `clearWorkingState` nulls `dispatched_at` at
    // turn end but deliberately leaves `dispatched_terminal` set, so a card
    // whose coder finished a turn without a completion post keeps its holder
    // forever. Keying in-flight on the holder alone reads that card as live
    // work and muzzles the watch — the same silence as the column read, under
    // a different clause. Suppression here is the team-liveness gate's job
    // (a coder still producing output), not the in-flight gate's.

    await check('head pacing: holder set with dispatched_at cleared is NOT in flight', async () => {
        const board = [
            card('staged-1', 'STAGING', { queuePosition: 1 }),
            card('sub-1', 'CODER CODED', {
                dispatchedTerminal: 'Coder-1',
                dispatchedAt: null,
                completedAt: null,
            }),
        ];
        const watch = {
            workspaceRoot: WS,
            headTerminal: 'Coding',
            armedAt: 1000,
            nudgeCount: 0,
            lastNudgedAt: 0,
        };
        const configs = {
            'kanban.queueWatches': [watch],
        };
        const { engine, db, notifications } = makeEngineHarness({
            board,
            configs,
            pacing: 'head',
            teamMembers: ['Coding', 'Coder-1'],
        });

        // Both seats quiet well beyond nudgeSilenceMs, so the team-liveness
        // gate does not stand in for the in-flight gate and mask the result.
        const liveness = [
            { friendlyName: 'Coding', lastDataAt: 1000, status: 'running' },
            { friendlyName: 'Coder-1', lastDataAt: 1000, status: 'running' },
        ];

        await engine._runQueueNudgeSweep({
            db,
            folder: WS,
            liveness,
            nowMs: 200000,
            turnEndSilenceMs: 90000,
            nudgeSilenceMs: 90000,
            notifiedSeatsThisTick: new Set(),
        });

        assert.strictEqual(notifications.length, 1, 'a released latch must not suppress the nudge');
        assert.strictEqual(notifications[0].seatName, 'Coding');
        assert.strictEqual(watch.nudgeCount, 1, 'the sweep must reach the nudge, not the in-flight reset');
    });

    // ── 3. Seat pacing: completed card with dead holder does NOT resolve as pacer ──

    await check('seat pacing: completed card with dead holder does not resolve as pacer and does not escalate', async () => {
        const board = [
            card('staged-1', 'STAGING', { queuePosition: 1 }),
            card('sub-1', 'CODER CODED', {
                dispatchedTerminal: 'Coder-1',
                dispatchedAt: '2026-08-26T10:00:00Z',
                completedAt: '2026-08-26T10:05:00Z',
            }),
        ];
        const watch = {
            workspaceRoot: WS,
            headTerminal: 'Coding',
            armedAt: 1000,
            nudgeCount: 0,
            lastNudgedAt: 0,
        };
        const configs = {
            'kanban.queueWatches': [watch],
        };
        const { engine, db, escalations } = makeEngineHarness({
            board,
            configs,
            pacing: 'seat',
            teamMembers: ['Coding', 'Coder-1'],
        });

        // Coder-1 is exited/dead, Coding is running
        const liveness = [
            { friendlyName: 'Coding', lastDataAt: 1000, status: 'running' },
            { friendlyName: 'Coder-1', lastDataAt: 1000, status: 'exited' },
        ];

        await engine._runQueueNudgeSweep({
            db,
            folder: WS,
            liveness,
            nowMs: 200000,
            turnEndSilenceMs: 90000,
            nudgeSilenceMs: 90000,
            notifiedSeatsThisTick: new Set(),
        });

        assert.deepStrictEqual(escalations, [], 'completed card must not resolve as pacer and must not call escalation recorder');
    });

    // ── 4. Ladder: reportQueueDone(outcome:'failed') on completed card does not re-stage ──

    await check('ladder: reportQueueDone(outcome: failed) on completed card does not re-stage', async () => {
        const heldPlan = card('sub-1', 'CODER CODED', {
            dispatchedTerminal: 'Coder-1',
            dispatchedAt: '2026-08-26T10:00:00Z',
            completedAt: '2026-08-26T10:05:00Z',
            routedTo: 'coder',
        });
        const board = [
            heldPlan,
            card('staged-1', 'STAGING', { queuePosition: 1 }),
        ];

        const movedColumns = [];
        const releasedHolders = [];

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
                getPlanByPlanId: async (id) => id === 'sub-1' ? heldPlan : null,
                getActiveDispatchedByTerminal: async () => heldPlan,
                clearWorkingState: async () => true,
                updateColumnByPlanFile: async (file, wsId, col) => {
                    movedColumns.push({ file, col });
                    return true;
                },
                releaseDispatchHolder: async (file, wsId) => {
                    releasedHolders.push(file);
                    return true;
                },
                getConfigJson: async () => [],
                setConfigJson: async () => {},
            }),
            resolveTeamMembers: async () => ['Coding', 'Coder-1'],
            resolveTeamPacing: async () => 'head',
            armQueueWatch: async () => {},
        });

        // Stub performKanbanDispatch
        server.performKanbanDispatch = async () => ({ status: 200, payload: { success: true } });

        const res = await server.reportQueueDone({
            workspaceRoot: WS,
            from: 'Coder-1',
            outcome: 'failed',
            planId: 'sub-1',
        });

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(movedColumns, [], 'failed report on completed card must NOT move column back to STAGING');
        assert.deepStrictEqual(releasedHolders, [], 'failed report on completed card must NOT release dispatch holder for restaging');
    });

    // ── 5. Source pins ───────────────────────────────────────────────────

    await check('source pin: CODING_COLUMNS does not appear in PlanIngestionEngine.ts', () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'PlanIngestionEngine.ts'), 'utf8');
        assert.ok(!src.includes('CODING_COLUMNS'), 'CODING_COLUMNS must not exist in PlanIngestionEngine.ts');
    });

    await check('source pin: STAGING queue definition read is retained in PlanIngestionEngine.ts', () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'PlanIngestionEngine.ts'), 'utf8');
        assert.ok(src.includes("p.kanbanColumn === 'STAGING'"), 'STAGING queue definition filter must be present in PlanIngestionEngine.ts');
    });

    console.log('');
    if (failures > 0) {
        console.error(`${failures} contract(s) failed.`);
        process.exit(1);
    }
    console.log('queue-stall-watch contract passed');
}

run().catch(err => {
    console.error('queue-stall-watch contract crashed:', err);
    process.exit(1);
});
