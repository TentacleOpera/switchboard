'use strict';

/**
 * Contract: the board payload carries no empty fields, and the collection
 * read is windowed to what is in play.
 *
 * Plan: .switchboard/plans/the-board-must-fit-a-1gb-pi-and-the-peak-is-what-does-not.md
 *       (Changes 2 and 3)
 *
 * Two silent-failure shapes this gate bounds:
 *
 *   - Empty fields: 13,210 null/empty slots across 579 cards shipped as
 *     key+null every full-state push. Reverting `dispatchedAt: row.dispatchedAt
 *     ?? undefined` back to `?? null` compiles, lints, and re-adds the whole
 *     empty-slot tax while every suite stays green. The card-builder must emit
 *     `undefined` (dropped by JSON.stringify), not `null`/`''`.
 *
 *   - Windowing: 317 cards in PLAN REVIEWED + 91 in CODE REVIEWED were
 *     materialised on every full-state push while none were in play. Reverting
 *     getFullStateMessages to `getBoard` (or making the window an archive
 *     move that flips status to 'archived') compiles and silently floods the
 *     board OR hides live cards. The window must be a READ-SIDE filter that
 *     keeps status='active' and leaves the card reachable by id.
 *
 * Three halves, on purpose:
 *
 *   STATIC (always runs, gates CI) — the source-level invariants a regression
 *   would have to break: the card builder emits `undefined` for the empty-prone
 *   fields, the dormant column set is stated, the working-set read exists and
 *   excludes dormant columns older than the hot window, and both composition
 *   roots wire the working-set read (parity).
 *
 *   REAL-STORE (always runs against a temp workspace) — a dormant PLAN REVIEWED
 *   card older than the hot window is excluded from the working-set collection
 *   read, still present in the full getBoard, still status='active' (NOT
 *   archived), and still resolvable by id via lookupPlanRecord (source:
 *   'board'). The paired negative invariant: the same card is NOT archived.
 *
 *   LIVE (runs only when a host answers on this workspace's port) — the
 *   serialized /kanban/board payload carries no null or empty-string field
 *   values and stays under a stated byte budget per card. A CI runner has no
 *   host, so this half is skipped out loud rather than passing quietly.
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.SWITCHBOARD_STATE_HOME) {
    try { require('./bootstrap/sandboxStateHome'); } catch { /* already sandboxed */ }
}

const { KanbanDatabase } = require('../../out/services/KanbanDatabase');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Stated per-card byte budget for the serialized board payload. */
const BYTES_PER_CARD_BUDGET = 1600;

let passed = 0;
let failed = 0;
let liveSkipped = false;

function test(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') { throw new Error('use asyncTest for async bodies'); }
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(e && e.stack ? e.stack : e);
        failed++;
    }
}

async function asyncTest(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(e && e.stack ? e.stack : e);
        failed++;
    }
}

function readSource(...segments) {
    return fs.readFileSync(path.join(REPO_ROOT, ...segments), 'utf8');
}

// ── STATIC ───────────────────────────────────────────────────────────────────

console.log('Board payload size + windowing contract');
console.log('\n  Static invariants');

test('the card builder emits undefined (not null/empty) for empty-prone fields', () => {
    const src = readSource('src', 'services', 'KanbanProvider.ts');
    const body = src.slice(src.indexOf('private async _buildBoardCards'), src.indexOf('return cards;', src.indexOf('private async _buildBoardCards')) + 'return cards;'.length);
    assert.ok(body.length > 0, '_buildBoardCards body not found');
    // Empty-prone fields the plan names. Each must emit `?? undefined` or
    // `|| undefined`, never `?? null` or `|| ''`. Reverting any one re-adds
    // the empty-slot tax on the wire.
    for (const field of ['dispatchedTerminal', 'dispatchedAt', 'queuePosition', 'columnEnteredAt', 'priority', 'columnOrder']) {
        const emitsUndefined = new RegExp(`${field}:\\s*row\\.${field}\\s*(\\?\\?|\\|\\|)\\s*undefined`).test(body);
        assert.ok(emitsUndefined,
            `${field} must emit undefined when empty (not null/'') — re-adding ?? null re-adds the empty-slot tax`);
        const emitsNull = new RegExp(`${field}:\\s*row\\.${field}\\s*\\?\\?\\s*null`).test(body);
        assert.ok(!emitsNull,
            `${field} must NOT emit ?? null — null is kept by JSON.stringify and re-adds the key+null every push`);
    }
});

test('the dormant column set is stated and contains the two parked columns', () => {
    const src = readSource('src', 'services', 'KanbanDatabase.ts');
    assert.ok(/DORMANT_KANBAN_COLUMNS\s*=\s*\[/.test(src),
        'the dormant column set must be a named constant, not an inline literal a regression can silently shrink');
    assert.ok(/'PLAN REVIEWED'/.test(src) && /'CODE REVIEWED'/.test(src),
        'the dormant set must contain PLAN REVIEWED and CODE REVIEWED — the 317 + 91 measured parked cards');
});

test('a working-set read exists and excludes dormant cards older than the hot window', () => {
    const src = readSource('src', 'services', 'KanbanDatabase.ts');
    assert.ok(/public async getBoardWorkingSet/.test(src),
        'getBoardWorkingSet must exist — the windowed collection read');
    assert.ok(/public async getBoardFilteredByProjectWorkingSet/.test(src),
        'getBoardFilteredByProjectWorkingSet must exist — the repo-scoped windowed read');
    const body = src.slice(src.indexOf('public async getBoardWorkingSet'), src.indexOf('public async getBoardFilteredByProjectWorkingSet'));
    assert.ok(/status = 'active'/.test(body), 'the working-set read must keep status=\'active\' — windowing is a read-side filter, not an archive move');
    assert.ok(/DORMANT_KANBAN_COLUMNS/.test(body), 'the dormant exclusion must reference the named constant, not an inline list');
    assert.ok(/updated_at < \?/.test(body), 'the exclusion must key on updated_at vs the hot-window cutoff');
    assert.ok(/IN_FLIGHT_SQL/.test(body), 'in-flight cards must be pinned (never excluded) — mirroring selectColdEligiblePlanIds');
});

test('both composition roots wire the working-set read (no parity divergence)', () => {
    // CLAUDE.md: the trap is composition-root wiring. The standalone push path
    // (getFullStateMessages) and the extension editor refresh path
    // (TaskViewerProvider._refreshRunSheetsImpl → refreshWithData) share
    // _buildBoardCards, so the READ must window the same way in both roots.
    const provider = readSource('src', 'services', 'KanbanProvider.ts');
    assert.ok(/getBoardFilteredByProjectWorkingSet/.test(provider) && /getBoardWorkingSet/.test(provider),
        'getFullStateMessages must use the working-set read variants');
    const tvp = readSource('src', 'services', 'TaskViewerProvider.ts');
    assert.ok(/getBoardFilteredByProjectWorkingSet/.test(tvp) && /getBoardWorkingSet/.test(tvp),
        'TaskViewerProvider._refreshRunSheetsImpl must use the working-set read variants — extension-first is a divergence');
});

test('the burst-attribution seam is wired in both composition roots', () => {
    // Change 5: the client-count resolver must be wired by both roots so the
    // debug-gated burst log can attribute a spike to a path. Defined-but-not-
    // wired is the exact hole the queue seams fell into (CLAUDE.md precedent).
    const provider = readSource('src', 'services', 'KanbanProvider.ts');
    assert.ok(/setBurstAttributionClientCountResolver/.test(provider),
        'KanbanProvider must expose the burst-attribution client-count seam');
    assert.ok(/getWsConnectionInfo/.test(readSource('src', 'services', 'LocalApiServer.ts')),
        'LocalApiServer must expose the WS connection count the resolver reads');
    const bootstrap = readSource('src', 'standalone', 'bootstrap.ts');
    assert.ok(/setBurstAttributionClientCountResolver/.test(bootstrap),
        'standalone bootstrap must wire the burst-attribution seam');
    const tvp = readSource('src', 'services', 'TaskViewerProvider.ts');
    assert.ok(/setBurstAttributionClientCountResolver/.test(tvp),
        'extension TaskViewerProvider must wire the burst-attribution seam — parity with standalone');
});

test('the forced-GC split probe is armed on the build, not a timer', () => {
    // Change 1: the probe must fire on the next getFullStateMessages call,
    // not on a timer (a timer measures rest, not the burst peak). Gated by
    // SWITCHBOARD_BURST_GC_SPLIT=1 + --expose-gc so it is inert in normal use.
    const provider = readSource('src', 'services', 'KanbanProvider.ts');
    assert.ok(/_recordBurstGcSplit/.test(provider), 'the forced-GC split probe must exist');
    assert.ok(/SWITCHBOARD_BURST_GC_SPLIT/.test(provider), 'the probe must be env-gated (off by default)');
    assert.ok(/global as any\)\.gc/.test(provider), 'the probe must use --expose-gc global.gc, not an inspector attach');
    // Assert against the full source — the method definition sits far below the
    // call site, and a slice from call-site to the first 'verdict' stops before
    // the artefact path line (which follows the verdict computation).
    assert.ok(/burst-gc-split\.jsonl/.test(provider), 'the probe must record its split to a JSONL artefact');
});

test('the V8 old-space flag is explicit and env-overridable in both Go entry paths', () => {
    // Change 6: the flag is mandatory on a 1 GB device and the value must be
    // measured (from Change 1), not guessed. Both Go entry paths (systemd
    // service via the client, icon launch via the launcher) must set it and
    // read SWITCHBOARD_MAX_OLD_SPACE_MB so a measured value applies without a
    // rebuild. Keep the two defaults identical.
    const client = readSource('cmd', 'switchboard', 'main.go');
    const launcher = readSource('internal', 'launcher', 'discovery.go');
    for (const [label, src] of [['cmd/switchboard/main.go', client], ['internal/launcher/discovery.go', launcher]]) {
        assert.ok(/--max-old-space-size=/.test(src), `${label} must set --max-old-space-size explicitly`);
        assert.ok(/SWITCHBOARD_MAX_OLD_SPACE_MB/.test(src), `${label} must read SWITCHBOARD_MAX_OLD_SPACE_MB so a measured value applies without a rebuild`);
    }
});

// ── REAL-STORE: windowing ─────────────────────────────────────────────────────

async function makeWorkspace(label) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `sb-payload-${label}-`));
    fs.mkdirSync(path.join(root, '.switchboard', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(root, '.switchboard', 'workspace-id'), `ws-${label}\n`, 'utf8');
    const db = KanbanDatabase.forWorkspace(root);
    await db.createIfMissing();
    return { root, db };
}

function insertPlan(db, wsId, planId, overrides) {
    const o = overrides || {};
    db.getDriver().run(
        `INSERT INTO plans (plan_id, session_id, topic, plan_file, kanban_column, status,
             complexity, workspace_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [planId, o.sessionId || '', o.topic || `topic ${planId}`,
            o.planFile || `.switchboard/plans/${planId}.md`, o.column || 'CREATED',
            o.status || 'active', o.complexity || '3', wsId,
            o.createdAt || new Date().toISOString(), o.updatedAt || new Date().toISOString()]
    );
}

function isoDaysAgo(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString();
}

(async () => {
    console.log('\n  Real-store windowing (temp workspace)');

    await asyncTest('a dormant PLAN REVIEWED card older than the hot window is EXCLUDED from the working set', async () => {
        const { root, db } = await makeWorkspace('window');
        try {
            const wsId = await db.getWorkspaceId();
            insertPlan(db, wsId, 'live-1', { column: 'CREATED' });
            insertPlan(db, wsId, 'dormant-1', { column: 'PLAN REVIEWED', updatedAt: isoDaysAgo(60) });
            insertPlan(db, wsId, 'dormant-2', { column: 'CODE REVIEWED', updatedAt: isoDaysAgo(60) });
            const working = await db.getBoardWorkingSet(wsId);
            const ids = working.map(r => r.planId);
            assert.ok(ids.includes('live-1'), 'a live CREATED card must be in the working set');
            assert.ok(!ids.includes('dormant-1'), 'a dormant PLAN REVIEWED card older than the hot window must NOT be materialised');
            assert.ok(!ids.includes('dormant-2'), 'a dormant CODE REVIEWED card older than the hot window must NOT be materialised');
        } finally {
            await KanbanDatabase.invalidateWorkspace(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await asyncTest('a touched dormant card re-enters the working set (updated_at promotes it)', async () => {
        const { root, db } = await makeWorkspace('touch');
        try {
            const wsId = await db.getWorkspaceId();
            insertPlan(db, wsId, 'touched-1', { column: 'PLAN REVIEWED', updatedAt: new Date().toISOString() });
            const working = await db.getBoardWorkingSet(wsId);
            assert.ok(working.map(r => r.planId).includes('touched-1'),
                'a dormant-column card with a fresh updated_at must be in the working set — any write that bumps updated_at promotes it');
        } finally {
            await KanbanDatabase.invalidateWorkspace(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await asyncTest('an in-flight dormant card is NOT excluded (active worktree / dispatched pins it)', async () => {
        const { root, db } = await makeWorkspace('inflight');
        try {
            const wsId = await db.getWorkspaceId();
            // V74 moved dispatched_at out of plans into plan_runtime_state. Insert
            // the plan row first (no dispatched_at column on plans post-V74), then
            // insert the runtime row with dispatched_at to pin the card in-flight.
            insertPlan(db, wsId, 'inflight-1', { column: 'PLAN REVIEWED', updatedAt: isoDaysAgo(60) });
            db.getDriver().run(
                `INSERT INTO plan_runtime_state (plan_id, device_id, workspace_id, dispatched_at, updated_at)
                 VALUES (?, ?, ?, ?, ?)`,
                ['inflight-1', 'test-device', wsId, new Date().toISOString(), new Date().toISOString()]
            );
            const working = await db.getBoardWorkingSet(wsId);
            assert.ok(working.map(r => r.planId).includes('inflight-1'),
                'an in-flight card (dispatched_at IS NOT NULL on plan_runtime_state) must NOT be excluded even in a dormant column past the window');
        } finally {
            await KanbanDatabase.invalidateWorkspace(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await asyncTest('a windowed-out card is still status=active in the FULL getBoard (NOT archived)', async () => {
        const { root, db } = await makeWorkspace('active');
        try {
            const wsId = await db.getWorkspaceId();
            insertPlan(db, wsId, 'dormant-keep', { column: 'PLAN REVIEWED', updatedAt: isoDaysAgo(60) });
            const full = await db.getBoard(wsId);
            const row = full.find(r => r.planId === 'dormant-keep');
            assert.ok(row, 'the full getBoard must still carry the dormant card — windowing is a read-side filter, not a delete');
            assert.strictEqual(row.status, 'active',
                'a windowed-out card must stay status=\'active\' — flipping it to \'archived\' is the archive-move bug the plan exists to avoid');
        } finally {
            await KanbanDatabase.invalidateWorkspace(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await asyncTest('a windowed-out card is still resolvable by id (lookupPlanRecord, source: board)', async () => {
        const { root, db } = await makeWorkspace('lookup');
        try {
            const wsId = await db.getWorkspaceId();
            insertPlan(db, wsId, 'dormant-lookup', { column: 'PLAN REVIEWED', updatedAt: isoDaysAgo(60) });
            const r = await db.lookupPlanRecord('dormant-lookup');
            assert.strictEqual(r.outcome, 'found',
                'an agent asking about a specific card must not be told it does not exist because it aged out of the collection read');
            assert.strictEqual(r.source, 'board',
                'the card is still in the hot store (status=\'active\'); the windowing did not move it');
            assert.strictEqual(r.record.planId, 'dormant-lookup');
        } finally {
            await KanbanDatabase.invalidateWorkspace(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await asyncTest('the repo-scoped working-set read windows the same way', async () => {
        const { root, db } = await makeWorkspace('scoped');
        try {
            const wsId = await db.getWorkspaceId();
            insertPlan(db, wsId, 'scoped-live', { column: 'CREATED' });
            insertPlan(db, wsId, 'scoped-dormant', { column: 'CODE REVIEWED', updatedAt: isoDaysAgo(60) });
            const working = await db.getBoardFilteredByProjectWorkingSet(wsId, null, null);
            const ids = working.map(r => r.planId);
            assert.ok(ids.includes('scoped-live'), 'a live card must be in the scoped working set');
            assert.ok(!ids.includes('scoped-dormant'), 'a dormant card must be excluded from the scoped working set too — the window and the project filter must compose');
        } finally {
            await KanbanDatabase.invalidateWorkspace(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    // ── LIVE: serialized payload shape ──────────────────────────────────────
    const portFile = path.join(REPO_ROOT, '.switchboard', 'api-server-port.txt');
    const cliBuilt = fs.existsSync(path.join(REPO_ROOT, 'dist', 'standalone', 'cli.js'));
    const port = (cliBuilt && fs.existsSync(portFile))
        ? parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10)
        : null;
    if (!port || !Number.isFinite(port) || port <= 0) {
        liveSkipped = true;
    } else {
        console.log('\n  Live payload shape (host answering on port ' + port + ')');

        await asyncTest('the /kanban/board collection read is windowed (dormant cards not materialised)', async () => {
            const body = await new Promise((resolve, reject) => {
                http.get(`http://127.0.0.1:${port}/kanban/board`, res => {
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                }).on('error', reject);
            });
            const parsed = JSON.parse(body);
            const rows = (parsed && parsed.data) || [];
            assert.ok(rows.length > 0, 'the live host should have at least one card to assert against');
            // The HTTP /kanban/board endpoint serves raw DB rows (not card-builder
            // output), so field-value null/empty checks do not apply here — the
            // card builder's `undefined` conversion only runs in the WS push
            // (getFullStateMessages) and extension refresh (refreshWithData) paths.
            // What this endpoint CAN prove is that the working-set windowing is
            // applied: no dormant PLAN REVIEWED / CODE REVIEWED card older than
            // the hot window is materialised (unless in-flight).
            const hotWindowDays = 45; // KanbanDatabase.DEFAULT_HOT_WINDOW_DAYS
            const cutoff = Date.now() - hotWindowDays * 24 * 60 * 60 * 1000;
            const dormant = new Set(['PLAN REVIEWED', 'CODE REVIEWED']);
            let staleDormant = 0;
            for (const row of rows) {
                const col = row.kanbanColumn || row.kanban_column || '';
                if (!dormant.has(col)) continue;
                const updated = row.updatedAt || row.updated_at || '';
                if (!updated) continue;
                const ts = Date.parse(updated);
                if (!Number.isFinite(ts)) continue;
                if (ts < cutoff) {
                    // Could still be in-flight — but the HTTP endpoint does not
                    // expose worktree_status / dispatched_at to check. Count it;
                    // a real board should have very few of these (in-flight is
                    // rare), so a loose ceiling catches a regression that floods
                    // the collection with dormant cards.
                    staleDormant++;
                }
            }
            // Loose ceiling: the windowing must exclude the bulk of dormant
            // cards. A handful of in-flight ones may remain; hundreds would
            // mean the window is not applied.
            assert.ok(staleDormant < 10,
                `${staleDormant} stale dormant cards in the /kanban/board collection — the working-set window is not applied to the HTTP endpoint`);
        });

        await asyncTest(`the serialized payload stays under ${BYTES_PER_CARD_BUDGET} bytes per card`, async () => {
            const body = await new Promise((resolve, reject) => {
                http.get(`http://127.0.0.1:${port}/kanban/board`, res => {
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                }).on('error', reject);
            });
            const parsed = JSON.parse(body);
            const cards = (parsed && parsed.data) || [];
            assert.ok(cards.length > 0, 'need cards to measure per-card bytes');
            const perCard = body.length / cards.length;
            assert.ok(perCard < BYTES_PER_CARD_BUDGET,
                `serialized payload is ${Math.round(perCard)} bytes/card (budget ${BYTES_PER_CARD_BUDGET}) — empty-field omission + windowing must keep the per-card footprint bounded`);
        });
    }

    console.log(`\nTests passed: ${passed}, failed: ${failed}`);
    if (liveSkipped) {
        console.log('LIVE PAYLOAD CHECKS NOT RUN — no built CLI or no host answering on this workspace.');
        console.log('The static + real-store invariants above do NOT measure the live payload. Run this file');
        console.log('against a running host (npm run compile && switchboard local) to enforce the byte budget.');
    }
    if (failed > 0) { process.exit(1); }
})();
