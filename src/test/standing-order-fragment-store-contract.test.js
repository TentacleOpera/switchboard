'use strict';

/**
 * Contract: Standing-order fragment bodies belong in the store.
 *
 * Verifies the plan "Standing-Order Fragment Bodies Belong in the Store, Like
 * Every Other Control-Plane Document":
 *
 *  1. Census gate — STATIC_STANDING_ORDER_FRAGMENT_IDS matches a live scan of
 *     every fragment's body source for ctx references (the split is
 *     mechanically enforced, not hand-maintained).
 *  2. Store-backed delivery — a static fragment body edited in control_plane
 *     (via override_body) reaches the next delivered prompt through the REAL
 *     sync delivery path (renderStandaloneOrdersBlock), with no rebuild and no
 *     restart.
 *  3. Compiled-default fallback — with no store row, the compiled constant is
 *     used and composeStandingOrderFragments records source: 'compiled-default'.
 *  4. Override survives re-seed — override_body on a fragment row wins over the
 *     seeded body, and survives an upgrade that re-seeds (re-seed does not
 *     clobber override_body).
 *  5. Projection skip — projectControlPlane does not write any
 *     kind: 'standing-order-fragment' row to .agents/.
 *
 * Run with:
 *   npm run compile-tests && npm run test:contract:standing-order-fragment-store
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));
const {
    STANDING_ORDER_FRAGMENTS,
    STANDING_ORDER_FRAGMENT_IDS,
    composeStandingOrderFragments,
    STATIC_STANDING_ORDER_FRAGMENT_IDS,
    isStaticFragment,
    STATIC_FRAGMENT_BODIES,
    BUNDLED_STANDING_ORDER_FRAGMENTS,
    STANDING_ORDER_FRAGMENT_KIND,
    seedStandingOrderFragments,
    loadStaticFragmentBodies,
    invalidateAllStaticFragmentBodies,
} = require(path.join(process.cwd(), 'out', 'services', 'standingOrderFragments.js'));
const { renderStandaloneOrdersBlock } = require(path.join(process.cwd(), 'out', 'services', 'standingOrders.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => { console.log(`  ✅ ${name}`); passed++; })
        .catch((e) => { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; });
}

async function buildWorkspace(root, workspaceId) {
    const sbDir = path.join(root, '.switchboard');
    await fs.promises.mkdir(sbDir, { recursive: true });
    await fs.promises.writeFile(path.join(sbDir, 'workspace-id'), `${workspaceId}\n`, 'utf8');
    const db = KanbanDatabase.forWorkspace(root);
    await db.createIfMissing();
    return db;
}

// ── 1. Census gate ──────────────────────────────────────────────────────────

async function test_census_gate() {
    // Scan each fragment's body function source for `ctx` references. A body
    // that references `ctx` is dynamic; one that does not is static. The
    // STATIC_STANDING_ORDER_FRAGMENT_IDS set must match this scan exactly.
    const scannedStatic = new Set();
    for (const fragment of STANDING_ORDER_FRAGMENTS) {
        const bodySrc = fragment.body.toString();
        // The body function's parameter is named `ctx` (or `_ctx` / unused).
        // If the function body references `ctx`, it is dynamic. We check for
        // the bare identifier `ctx` — not inside a string, not as a property
        // of another object. A simple heuristic: does the body source contain
        // `ctx.` or `ctx,` or `ctx)` or `ctx;` or `${ctx`?
        const referencesCtx = /\bctx\b/.test(bodySrc.replace(/\/\/.*$/gm, ''));
        if (!referencesCtx) {
            scannedStatic.add(fragment.id);
        }
    }
    assert.ok(scannedStatic.size > 0, 'census scan found at least one static fragment');
    // The scanned set must match the declared set exactly.
    for (const id of STATIC_STANDING_ORDER_FRAGMENT_IDS) {
        assert.ok(scannedStatic.has(id),
            `declared static id '${id}' must be static by body scan (no ctx reference)`);
    }
    for (const id of scannedStatic) {
        assert.ok(STATIC_STANDING_ORDER_FRAGMENT_IDS.has(id),
            `scanned static id '${id}' must be in the declared static set`);
    }
    assert.strictEqual(scannedStatic.size, STATIC_STANDING_ORDER_FRAGMENT_IDS.size,
        `census size mismatch: scanned ${scannedStatic.size} vs declared ${STATIC_STANDING_ORDER_FRAGMENT_IDS.size}`);
    // Every static id MUST carry a compiled default and a bundled seed entry.
    // A static id missing from STATIC_FRAGMENT_BODIES resolves to '' on a cold
    // cache — the fragment silently vanishes from every prompt and reads exactly
    // like one that legitimately emits nothing. The census set alone does not
    // catch that, so pin it here.
    for (const id of STATIC_STANDING_ORDER_FRAGMENT_IDS) {
        assert.strictEqual(typeof STATIC_FRAGMENT_BODIES[id], 'string',
            `static id '${id}' must have a compiled default in STATIC_FRAGMENT_BODIES`);
        assert.ok(STATIC_FRAGMENT_BODIES[id].length > 0,
            `static id '${id}' compiled default must be non-empty`);
        assert.ok(BUNDLED_STANDING_ORDER_FRAGMENTS[id],
            `static id '${id}' must have a bundled seed entry`);
    }
    console.log('Pass: census gate — STATIC_STANDING_ORDER_FRAGMENT_IDS matches body-source scan');
}

// ── 3. Compiled-default fallback ────────────────────────────────────────────

async function test_compiled_default_fallback() {
    // With no store row (cache cleared), a static fragment resolves from the
    // compiled default and composeStandingOrderFragments records
    // source: 'compiled-default'.
    invalidateAllStaticFragmentBodies();
    const ctx = {
        targetName: 'seat-1',
        inTeam: true,
        isHead: true,
        teamId: 'team-1',
        headName: 'lead-1',
        headRole: 'lead',
        members: ['lead-1', 'seat-1'],
        reviewerSeat: false,
        workKind: 'feature',
        pacing: 'head',
        orchestratorPresent: false,
        attended: true,
        externalHead: false,
    };
    const composed = composeStandingOrderFragments([STANDING_ORDER_FRAGMENT_IDS.headCommit], ctx);
    assert.ok(composed.sources[STANDING_ORDER_FRAGMENT_IDS.headCommit] === 'compiled-default',
        `headCommit source must be 'compiled-default' when cache is cold, got '${composed.sources[STANDING_ORDER_FRAGMENT_IDS.headCommit]}'`);
    assert.ok(composed.text.includes(STATIC_FRAGMENT_BODIES[STANDING_ORDER_FRAGMENT_IDS.headCommit]),
        'composed text must contain the compiled-default body');
    console.log('Pass: compiled-default fallback — cold cache resolves from compiled default with source tagged');
}

// ── 2 + 4. Store-backed delivery + override survives re-seed ─────────────────

async function test_store_backed_delivery_and_reseed(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-store');
    const wsId = 'store000000000001';
    const db = await buildWorkspace(wsRoot, wsId);

    // Seed the fragment rows.
    await seedStandingOrderFragments(db);
    // Warm the cache.
    await loadStaticFragmentBodies(db);

    // Verify the seeded body is in the store and the cache serves it.
    const entry = await db.getControlPlaneEntry(STANDING_ORDER_FRAGMENT_IDS.headCommit, STANDING_ORDER_FRAGMENT_KIND);
    assert.ok(entry, 'headCommit row seeded into control_plane');
    assert.strictEqual(entry.body, STATIC_FRAGMENT_BODIES[STANDING_ORDER_FRAGMENT_IDS.headCommit],
        'seeded body matches the compiled default');

    // Set an override — this is the capability the plan exists for.
    const overrideText = 'OVERRIDE: commit via `git commit -m` with a clear subject. No staging step.';
    await db.setControlPlaneOverride(STANDING_ORDER_FRAGMENT_IDS.headCommit, STANDING_ORDER_FRAGMENT_KIND, overrideText);

    // The cache invalidation+reload is async (void reloadStaticFragmentBody).
    // Wait a tick for the reload to settle.
    await new Promise(r => setTimeout(r, 50));

    // The REAL sync delivery path must deliver the override text.
    const ctx = {
        targetName: 'lead-1',
        inTeam: true,
        isHead: true,
        teamId: 'team-1',
        headName: 'lead-1',
        headRole: 'lead',
        members: ['lead-1'],
        reviewerSeat: false,
        workKind: 'feature',
        pacing: 'head',
        orchestratorPresent: false,
        attended: true,
        externalHead: false,
    };
    // Build a minimal standing order that carries the headCommit fragment.
    const orders = [{
        id: 'test-order',
        parent: '',
        child: '',
        instruction: '',
        fragments: [STANDING_ORDER_FRAGMENT_IDS.headCommit],
        scope: 'team-head',
        teamId: 'team-1',
        createdAt: Date.now(),
    }];
    const groups = [{ id: 'team-1', name: 'lead-1', source: 'manual', layout: '2h', members: ['lead-1'], order: ['lead-1'], teamKind: 'spawned', head: 'lead-1', headRole: 'lead' }];
    const liveNames = new Set(['lead-1']);
    const roleMap = new Map([['lead-1', 'lead']]);
    const block = renderStandaloneOrdersBlock(orders, 'lead-1', liveNames, groups, roleMap);
    assert.ok(block, 'a block must be delivered');
    assert.ok(block.includes(overrideText),
        'the override text must appear in the delivered block (store-backed delivery via the sync path)');

    // The composed source must be 'store' for the overridden fragment.
    const composed = composeStandingOrderFragments([STANDING_ORDER_FRAGMENT_IDS.headCommit], ctx);
    assert.ok(composed.sources[STANDING_ORDER_FRAGMENT_IDS.headCommit] === 'store',
        `headCommit source must be 'store' after override+reload, got '${composed.sources[STANDING_ORDER_FRAGMENT_IDS.headCommit]}'`);

    // ── 4. Override survives re-seed ──
    await seedStandingOrderFragments(db);
    await loadStaticFragmentBodies(db);
    const entryAfterReseed = await db.getControlPlaneEntry(STANDING_ORDER_FRAGMENT_IDS.headCommit, STANDING_ORDER_FRAGMENT_KIND);
    assert.strictEqual(entryAfterReseed.overrideBody, overrideText,
        'override_body must survive a re-seed (seedControlPlane COALESCE)');

    // ── An EMPTY override suppresses the fragment; it is not read as "unset" ──
    // The failure this pins: an operator empties a fragment body to switch it
    // off, the store read treats '' as absent, and the compiled constant is
    // delivered instead — a suppressed fragment indistinguishable from an
    // unconfigured one.
    await db.setControlPlaneOverride(STANDING_ORDER_FRAGMENT_IDS.headCommit, STANDING_ORDER_FRAGMENT_KIND, '');
    await loadStaticFragmentBodies(db);
    const emptied = composeStandingOrderFragments([STANDING_ORDER_FRAGMENT_IDS.headCommit], ctx);
    assert.strictEqual(emptied.sources[STANDING_ORDER_FRAGMENT_IDS.headCommit], 'store',
        'an emptied fragment row must still report source: store, not compiled-default');
    assert.strictEqual(emptied.text, '',
        'an empty override must suppress the fragment, not fall back to the compiled default');

    // Clearing the override (NULL) restores the seeded body, still from the store.
    await db.setControlPlaneOverride(STANDING_ORDER_FRAGMENT_IDS.headCommit, STANDING_ORDER_FRAGMENT_KIND, null);
    await loadStaticFragmentBodies(db);
    const cleared = composeStandingOrderFragments([STANDING_ORDER_FRAGMENT_IDS.headCommit], ctx);
    assert.strictEqual(cleared.sources[STANDING_ORDER_FRAGMENT_IDS.headCommit], 'store',
        'a cleared override must resolve the seeded body from the store');
    assert.ok(cleared.text.includes(STATIC_FRAGMENT_BODIES[STANDING_ORDER_FRAGMENT_IDS.headCommit]),
        'a cleared override must deliver the seeded body');

    await KanbanDatabase.invalidateWorkspace(wsRoot);
    console.log('Pass: store-backed delivery + override survives re-seed + empty override suppresses');
}

// ── 5. Projection skip ──────────────────────────────────────────────────────

async function test_projection_skip(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-proj');
    const wsId = 'proj0000000000001';
    const db = await buildWorkspace(wsRoot, wsId);

    await seedStandingOrderFragments(db);
    const { projectControlPlane } = require(path.join(process.cwd(), 'out', 'services', 'ClaudeCodeMirrorService.js'));
    await projectControlPlane(wsRoot, db, '1.0.0');

    const agentsDir = path.join(wsRoot, '.agents');
    for (const id of STATIC_STANDING_ORDER_FRAGMENT_IDS) {
        const projectedPath = path.join(agentsDir, id);
        assert.ok(!fs.existsSync(projectedPath),
            `fragment '${id}' must NOT be projected to .agents/ (got ${projectedPath})`);
    }

    // The ledger must not list fragment rows.
    const ledgerPath = path.join(agentsDir, '.switchboard-bundled.json');
    if (fs.existsSync(ledgerPath)) {
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
        for (const id of STATIC_STANDING_ORDER_FRAGMENT_IDS) {
            assert.ok(!ledger.files.includes(id),
                `fragment '${id}' must NOT appear in the .switchboard-bundled.json ledger`);
        }
    }

    await KanbanDatabase.invalidateWorkspace(wsRoot);
    console.log('Pass: projection skip — no standing-order-fragment row projected to .agents/');
}

async function run() {
    console.log('\nstanding-order-fragment-store-contract\n');

    await test('census gate', () => test_census_gate());
    await test('compiled-default fallback', () => test_compiled_default_fallback());

    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-sof-store-'));
    try {
        await test('store-backed delivery + override survives re-seed', () => test_store_backed_delivery_and_reseed(tmpRoot));
        await test('projection skip', () => test_projection_skip(tmpRoot));
    } finally {
        await KanbanDatabase.disposeAll();
        try { global.gc && global.gc(); } catch {}
        try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }); } catch {}
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
}

run().catch((err) => {
    console.error('Test failed:', err && err.stack ? err.stack : err);
    process.exit(1);
});
