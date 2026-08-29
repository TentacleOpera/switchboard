'use strict';

/**
 * Plan Ingestion Blocked Digest Contract Test
 *
 * Covers:
 * 1. Flapping seat (blocked -> live -> blocked) inside interval produces one delivered
 *    call, and notifiedSeatsThisTick is populated for the reported tick only.
 * 2. Two seats blocked in same tick produce one delivered call whose body lists both.
 * 3. Seat whose blocked_at was nulled between stamp and digest is excluded.
 * 4. Empty liveness snapshot does not prune the pacing map.
 * 5. TaskViewerProvider and bootstrap deliver: false guards, and the engine's per-seat
 *    blocked emission carries deliver: false (the machine half of the split).
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

require(path.join(process.cwd(), 'src', 'test', 'bootstrap', 'sandboxStateHome.js'));

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

const WS = '/tmp/plan-ingestion-blocked-digest-ws';

function makeEngineHarness(opts = {}) {
    const configMap = new Map();
    const config = {
        getConfigBoolean: (k, d) => d,
        getConfigNumber: (k, d) => d,
        getConfigJson: (k, d) => configMap.has(k) ? configMap.get(k) : (opts.configs?.[k] ?? d),
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

    engine.setTurnEndNotifier((info) => {
        notifications.push(info);
    });

    const dbDispatched = new Map();
    if (opts.dispatched) {
        for (const [seat, rec] of Object.entries(opts.dispatched)) {
            dbDispatched.set(seat, rec);
        }
    }

    const db = {
        getWorkspaceId: async () => 'ws1',
        getConfigJson: async (key, fallback) => configMap.has(key) ? configMap.get(key) : (opts.configs?.[key] ?? fallback),
        setConfigJson: async (key, val) => {
            configMap.set(key, val);
            if (opts.configs) opts.configs[key] = val;
        },
        getActiveDispatchedByTerminal: async (wsId, terminalName) => {
            return dbDispatched.get(terminalName) || null;
        },
        setDispatchedRecord: (terminalName, rec) => {
            dbDispatched.set(terminalName, rec);
        }
    };

    return {
        engine,
        db,
        notifications,
        configMap,
    };
}

async function run() {
    console.log('\nplan-ingestion-blocked-digest contract\n');

    // 1. Flapping seat produces one delivered call inside interval
    await check('flapping seat produces one delivered call inside interval', async () => {
        const dispatched = {
            'coder-1': { planFile: '.switchboard/plans/p1.md', blockedAt: '2026-08-29T10:00:00Z' }
        };
        const { engine, db, notifications } = makeEngineHarness({ dispatched });
        const liveness = [{ friendlyName: 'coder-1', lastDataAt: 1000, status: 'active' }];
        const notifiedSeatsThisTick = new Set();

        // Tick 1: at t = 100_000
        await engine._runBlockedDigestSweep({
            db,
            folder: WS,
            wsId: 'ws1',
            nowMs: 100000,
            intervalMs: 90000,
            liveness,
            blockedThisTick: [{ terminalName: 'coder-1', planFile: '.switchboard/plans/p1.md' }],
            notifiedSeatsThisTick,
        });

        assert.strictEqual(notifications.length, 1, 'first tick delivers digest');
        assert.strictEqual(notifications[0].seatName, 'coder-1');
        assert.ok(notifications[0].body.includes('coder-1'), 'body mentions coder-1');
        assert.ok(notifiedSeatsThisTick.has('coder-1'), 'notifiedSeatsThisTick has coder-1');

        // Tick 2: at t = 130_000 (flap within 90s)
        const tick2Notified = new Set();
        await engine._runBlockedDigestSweep({
            db,
            folder: WS,
            wsId: 'ws1',
            nowMs: 130000,
            intervalMs: 90000,
            liveness,
            blockedThisTick: [{ terminalName: 'coder-1', planFile: '.switchboard/plans/p1.md' }],
            notifiedSeatsThisTick: tick2Notified,
        });

        assert.strictEqual(notifications.length, 1, 'flap within interval is suppressed');
        assert.ok(!tick2Notified.has('coder-1'), 'tick2Notified does not have coder-1');
    });

    // 2. Two seats blocked in same tick produce one delivered call whose body lists both
    await check('two seats blocked in same tick produce one delivered call listing both', async () => {
        const dispatched = {
            'coder-1': { planFile: '.switchboard/plans/p1.md', blockedAt: '2026-08-29T10:00:00Z' },
            'coder-2': { planFile: '.switchboard/plans/p2.md', blockedAt: '2026-08-29T10:00:00Z' }
        };
        const { engine, db, notifications } = makeEngineHarness({ dispatched });
        const liveness = [
            { friendlyName: 'coder-1', lastDataAt: 1000, status: 'active' },
            { friendlyName: 'coder-2', lastDataAt: 2000, status: 'active' }
        ];
        const notifiedSeatsThisTick = new Set();

        await engine._runBlockedDigestSweep({
            db,
            folder: WS,
            wsId: 'ws1',
            nowMs: 100000,
            intervalMs: 90000,
            liveness,
            blockedThisTick: [
                { terminalName: 'coder-1', planFile: '.switchboard/plans/p1.md' },
                { terminalName: 'coder-2', planFile: '.switchboard/plans/p2.md' }
            ],
            notifiedSeatsThisTick,
        });

        assert.strictEqual(notifications.length, 1, 'one digest message delivered');
        assert.ok(notifications[0].body.includes('2 seat(s) have gone quiet'), 'lists 2 seats');
        assert.ok(notifications[0].body.includes('coder-1 on .switchboard/plans/p1.md'));
        assert.ok(notifications[0].body.includes('coder-2 on .switchboard/plans/p2.md'));
        assert.ok(notifiedSeatsThisTick.has('coder-1'));
        assert.ok(notifiedSeatsThisTick.has('coder-2'));
    });

    // 3. Seat whose blocked_at was nulled between stamp and digest is excluded
    await check('seat whose blocked_at was nulled between stamp and digest is excluded', async () => {
        const dispatched = {
            'coder-1': { planFile: '.switchboard/plans/p1.md', blockedAt: null } // recovered
        };
        const { engine, db, notifications } = makeEngineHarness({ dispatched });
        const liveness = [{ friendlyName: 'coder-1', lastDataAt: 99000, status: 'active' }];
        const notifiedSeatsThisTick = new Set();

        await engine._runBlockedDigestSweep({
            db,
            folder: WS,
            wsId: 'ws1',
            nowMs: 100000,
            intervalMs: 90000,
            liveness,
            blockedThisTick: [{ terminalName: 'coder-1', planFile: '.switchboard/plans/p1.md' }],
            notifiedSeatsThisTick,
        });

        assert.strictEqual(notifications.length, 0, 'recovered seat delivers nothing');
        assert.strictEqual(notifiedSeatsThisTick.size, 0);
    });

    // 4. Empty liveness snapshot does not prune pacing map
    await check('empty liveness snapshot does not prune pacing map', async () => {
        const dispatched = {
            'coder-1': { planFile: '.switchboard/plans/p1.md', blockedAt: '2026-08-29T10:00:00Z' }
        };
        const configs = {
            'kanban.blockedNotifyPacing': { 'ws1|coder-1': 100000, 'ws1|coder-old': 50000 }
        };
        const { engine, db } = makeEngineHarness({ dispatched, configs });

        // Run with empty liveness
        await engine._runBlockedDigestSweep({
            db,
            folder: WS,
            wsId: 'ws1',
            nowMs: 200000,
            intervalMs: 90000,
            liveness: [],
            blockedThisTick: [{ terminalName: 'coder-1', planFile: '.switchboard/plans/p1.md' }],
            notifiedSeatsThisTick: new Set(),
        });

        const pacing = await db.getConfigJson('kanban.blockedNotifyPacing', {});
        assert.ok(pacing['ws1|coder-old'], 'coder-old must NOT be pruned when liveness is empty');
    });

    // 5. Source text assertions: both hosts honor deliver: false
    await check('source checks: TaskViewerProvider and bootstrap honor deliver: false', async () => {
        const tvpSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        const bspSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'standalone', 'bootstrap.ts'), 'utf8');

        assert.ok(tvpSrc.includes('if (info.deliver === false) { return; }'), 'TaskViewerProvider.ts has deliver === false guard');
        assert.ok(bspSrc.includes('if (info.deliver === false) { return; }'), 'bootstrap.ts has deliver === false guard');

        // The per-seat emission lives in the main sweep loop, not in
        // _runBlockedDigestSweep, so a unit call on the sweep cannot reach it. Pin it
        // in source: dropping `deliver: false` here would restore the flapping notice
        // the digest exists to replace, and every assertion above would still pass.
        const engineSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'PlanIngestionEngine.ts'), 'utf8');
        const blockedArm = engineSrc.slice(engineSrc.indexOf('Turn-end (silence) marked blocked'));
        const emission = blockedArm.slice(0, blockedArm.indexOf('blockedThisTick.push'));
        assert.ok(/outcome: 'blocked'/.test(emission) && /deliver: false/.test(emission),
            "the blocked arm's per-seat notifier emission must carry deliver: false");
    });

    if (failures > 0) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    } else {
        console.log('\nAll checks passed');
    }
}

run().catch((e) => {
    console.error('Test threw:', e);
    process.exit(1);
});
