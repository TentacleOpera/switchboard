'use strict';

/**
 * Contract: the standing-orders definitions library — migration, sync,
 * deduplication, delete-unlink, and crash recovery.
 *
 * These tests exercise the actual transpiled functions from `out/`, so
 * they require `npm run compile-tests` first. Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js src/test/standing-orders-definitions-contract.test.js
 *
 * The denormalized-copy approach keeps the delivery path unchanged: the
 * `instruction` field on the assignment is the synced copy, and
 * `selectOrders` / `renderOrder` read it directly. These tests verify that
 * invariant holds across migration, sync, and delete.
 */

const assert = require('assert');
const {
    loadEffectiveStandingOrders,
    wireSpawnedTeam,
    STANDING_ORDERS_CONFIG_KEY,
} = require('../../out/services/teamWiring');
const {
    STANDING_ORDER_DEFINITIONS_CONFIG_KEY,
    syncDefinitionToAssignments,
    reSyncAssignmentsToDefinitions,
    makeStandingOrderDefinition,
    ensureStandingOrderDefinition,
    mutateStandingOrders,
    mutateStandingOrderDefinitions,
    applyStandingOrders,
    renderStandaloneOrdersBlock,
} = require('../../out/services/standingOrders');

let passed = 0;
let failed = 0;
const testPromises = [];

function test(name, fn) {
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            testPromises.push(
                result.then(() => { console.log(`  ✅ ${name}`); passed++; })
                      .catch((e) => { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; })
            );
        } else {
            console.log(`  ✅ ${name}`); passed++;
        }
    } catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

/**
 * In-memory db stub. getConfigJson/setConfigJson operate on a plain object
 * so mutateStandingOrders / mutateStandingOrderDefinitions can read-modify-write
 * their respective config keys.
 */
function makeInMemoryDb() {
    const store = {};
    return {
        getConfigJson: async function (key, fallback) {
            if (key in store) { return JSON.parse(JSON.stringify(store[key])); }
            return fallback;
        },
        setConfigJson: async function (key, value) {
            store[key] = JSON.parse(JSON.stringify(value));
        },
        _store: store,
    };
}

function makeOrder(id, instruction, scope, teamId, definitionId) {
    return {
        id: id || 'order-' + Math.random().toString(36).slice(2),
        parent: 'lead-1',
        child: '',
        instruction,
        createdAt: Date.now(),
        ...(scope ? { scope } : {}),
        ...(teamId ? { teamId } : {}),
        ...(definitionId ? { definitionId } : {}),
    };
}

// ── 1. Migration creates definitions + stamps definitionId ─────────────

test('migration: existing orders get definitionId, rendered block byte-identical', async () => {
    const db = makeInMemoryDb();
    const instruction = 'Always commit with conventional commit messages';
    const orders = [
        makeOrder('a', instruction, 'global'),
        makeOrder('b', 'Review every PR within 24 hours', 'global'),
    ];
    await db.setConfigJson(STANDING_ORDERS_CONFIG_KEY, orders);

    // Render before migration
    const beforeBlock = renderStandaloneOrdersBlock(
        orders, 'lead-1', new Set(), []
    );

    // Run migration
    const effective = await loadEffectiveStandingOrders(db);

    // Every order should now have a definitionId
    for (const o of effective) {
        assert.ok(o.definitionId, `order ${o.id} must have a definitionId after migration`);
    }

    // Render after migration — byte-identical (instruction unchanged)
    const afterBlock = renderStandaloneOrdersBlock(
        effective, 'lead-1', new Set(), []
    );
    assert.strictEqual(afterBlock, beforeBlock,
        'rendered block must be byte-identical before and after migration');

    // Definitions were persisted
    const defs = await db.getConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, []);
    assert.ok(Array.isArray(defs) && defs.length === 2,
        `expected 2 definitions, got ${defs.length}`);
});

// ── 2. syncDefinitionToAssignments updates all linked assignments ──────

test('syncDefinitionToAssignments: updates instruction on all matching assignments', async () => {
    const db = makeInMemoryDb();
    const defId = 'def-1';
    const oldInstruction = 'Old instruction text';
    const newInstruction = 'New instruction text';
    const orders = [
        makeOrder('a', oldInstruction, 'global', undefined, defId),
        makeOrder('b', oldInstruction, 'team', 'team_x', defId),
        makeOrder('c', 'Unrelated instruction', 'global'),
    ];
    await db.setConfigJson(STANDING_ORDERS_CONFIG_KEY, orders);

    await syncDefinitionToAssignments(db, defId, newInstruction);

    const updated = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []);
    const a = updated.find(o => o.id === 'a');
    const b = updated.find(o => o.id === 'b');
    const c = updated.find(o => o.id === 'c');
    assert.strictEqual(a.instruction, newInstruction, 'assignment a must have new instruction');
    assert.strictEqual(b.instruction, newInstruction, 'assignment b must have new instruction');
    assert.strictEqual(c.instruction, 'Unrelated instruction', 'unrelated assignment c must be unchanged');

    // Rendered block reflects the new instruction
    const block = renderStandaloneOrdersBlock(updated, 'lead-1', new Set(), []);
    assert.ok(block.includes(newInstruction), 'rendered block must contain new instruction');
    assert.ok(!block.includes(oldInstruction), 'rendered block must not contain old instruction');
});

// ── 3. Deduplication: same instruction → same definition ───────────────

test('migration deduplication: two orders with same instruction reference the same definition', async () => {
    const db = makeInMemoryDb();
    const instruction = 'Shared instruction text';
    const orders = [
        makeOrder('a', instruction, 'global'),
        makeOrder('b', instruction, 'role', undefined),  // different scope, same instruction
    ];
    await db.setConfigJson(STANDING_ORDERS_CONFIG_KEY, orders);

    const effective = await loadEffectiveStandingOrders(db);

    assert.strictEqual(effective[0].definitionId, effective[1].definitionId,
        'two orders with the same instruction must reference the same definition');

    const defs = await db.getConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, []);
    assert.strictEqual(defs.length, 1,
        `expected 1 definition (deduplicated), got ${defs.length}`);
});

// ── 4. wireSpawnedTeam creates definitions + assignments, idempotent ───

test('wireSpawnedTeam: creates definitions + assignments, re-spawn idempotent', async () => {
    const db = makeInMemoryDb();
    const args = {
        db, headName: 'lead-1',
        children: [{ friendlyName: 'lead-1-coder-1' }],
        members: [{ role: 'coder', count: 1, relationship: 'reports-to-head' }],
        prompt: 'team prompt {child}',
        headPrompt: 'Advance finished subtasks. From: {head}.',
    };

    await wireSpawnedTeam(args);

    const orders = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []);
    const defs = await db.getConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, []);

    // Two orders (team + team-head), each with a definitionId
    assert.strictEqual(orders.length, 2, `expected 2 orders, got ${orders.length}`);
    const teamOrder = orders.find(o => o.scope === 'team');
    const headOrder = orders.find(o => o.scope === 'team-head');
    assert.ok(teamOrder.definitionId, 'team order must have a definitionId');
    assert.ok(headOrder.definitionId, 'head order must have a definitionId');

    // Two definitions (team prompt + head prompt)
    assert.strictEqual(defs.length, 2, `expected 2 definitions, got ${defs.length}`);

    // Re-spawn: no duplicates
    await wireSpawnedTeam(args);
    const orders2 = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []);
    const defs2 = await db.getConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, []);
    assert.strictEqual(orders2.length, 2, `idempotent re-spawn: expected 2 orders, got ${orders2.length}`);
    assert.strictEqual(defs2.length, 2, `idempotent re-spawn: expected 2 definitions, got ${defs2.length}`);
});

// ── 5. Delete definition unlinks assignments, preserves instruction ────

test('deleteDefinition: unlinks assignments, instruction copy stays', async () => {
    const db = makeInMemoryDb();
    const defId = 'def-to-delete';
    const instruction = 'Instruction that survives deletion';
    const orders = [
        makeOrder('a', instruction, 'global', undefined, defId),
        makeOrder('b', 'Other instruction', 'global'),
    ];
    await db.setConfigJson(STANDING_ORDERS_CONFIG_KEY, orders);
    await db.setConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, [
        { id: defId, name: 'Test def', instruction, createdAt: Date.now() },
    ]);

    // Delete the definition
    await mutateStandingOrderDefinitions(db, async (defs) => defs.filter(d => d.id !== defId));
    // Unlink assignments
    await mutateStandingOrders(db, async (current) => {
        let changed = false;
        const next = current.map(o => {
            if (!o || o.definitionId !== defId) { return o; }
            changed = true;
            const { definitionId, ...rest } = o;
            return rest;
        });
        return changed ? next : current;
    });

    const updated = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []);
    const a = updated.find(o => o.id === 'a');
    assert.ok(!a.definitionId, 'assignment must be unlinked (no definitionId)');
    assert.strictEqual(a.instruction, instruction, 'instruction copy must survive deletion');

    // Rendered block still works
    const block = renderStandaloneOrdersBlock(updated, 'lead-1', new Set(), []);
    assert.ok(block.includes(instruction), 'rendered block must still contain the instruction');
});

// ── 6. reSyncAssignmentsToDefinitions: crash recovery ──────────────────

test('reSyncAssignmentsToDefinitions: detects and corrects drifted instruction', async () => {
    const defId = 'def-drift';
    const correctInstruction = 'Correct instruction';
    const staleInstruction = 'Stale instruction (crash left this)';
    const definitions = [
        { id: defId, name: 'Test', instruction: correctInstruction, createdAt: Date.now() },
    ];
    const orders = [
        makeOrder('a', staleInstruction, 'global', undefined, defId),
        makeOrder('b', 'Unrelated', 'global'),
    ];

    const resynced = reSyncAssignmentsToDefinitions(definitions, orders);
    assert.notStrictEqual(resynced, orders, 'must return a new array when drift detected');
    const a = resynced.find(o => o.id === 'a');
    assert.strictEqual(a.instruction, correctInstruction, 'drifted instruction must be corrected');

    // No drift → returns input by reference
    const synced = reSyncAssignmentsToDefinitions(definitions, [
        makeOrder('a', correctInstruction, 'global', undefined, defId),
    ]);
    // reSyncAssignmentsToDefinitions returns a new array from .map() only when
    // changed=true; when nothing changed it returns the input by reference.
    // But .map() always creates a new array... check the implementation: it
    // returns `changed ? next : orders`. So when nothing changed, it returns
    // the input array by reference.
    // Actually the input here is a fresh array from makeOrder, so we need to
    // check identity against that exact array.
    const inputOrders = [
        makeOrder('a', correctInstruction, 'global', undefined, defId),
    ];
    const noChange = reSyncAssignmentsToDefinitions(definitions, inputOrders);
    assert.strictEqual(noChange, inputOrders, 'must return input by reference when no drift');
});

// ── 7. Migration self-healing after partial crash ──────────────────────

test('migration self-healing: definitions written, orders not stamped → next read completes', async () => {
    const db = makeInMemoryDb();
    const instruction = 'Self-healing test instruction';
    const orders = [
        makeOrder('a', instruction, 'global'),
    ];
    await db.setConfigJson(STANDING_ORDERS_CONFIG_KEY, orders);

    // Simulate a partial crash: definitions are written but orders are NOT
    // stamped (no definitionId). This is the state after a crash between the
    // two writes in migrateToDefinitions.
    const def = makeStandingOrderDefinition(instruction.slice(0, 60), instruction);
    await db.setConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, [def]);

    // The orders still lack definitionId (crash prevented the stamp)
    let current = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []);
    assert.ok(!current[0].definitionId, 'pre-condition: order must lack definitionId');

    // Next loadEffectiveStandingOrders re-runs migration, finds existing
    // definition by instruction text, stamps definitionId.
    const effective = await loadEffectiveStandingOrders(db);
    assert.ok(effective[0].definitionId, 'order must be stamped after self-healing');
    assert.strictEqual(effective[0].definitionId, def.id,
        'must reuse the existing definition (deduplication), not create a new one');

    // No duplicate definitions
    const defs = await db.getConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, []);
    assert.strictEqual(defs.length, 1, `expected 1 definition (reused), got ${defs.length}`);
});

// ── 8. ensureStandingOrderDefinition is idempotent ─────────────────────

test('ensureStandingOrderDefinition: idempotent by instruction text', async () => {
    const db = makeInMemoryDb();
    const instruction = 'Ensure test instruction';

    const id1 = await ensureStandingOrderDefinition(db, instruction);
    const id2 = await ensureStandingOrderDefinition(db, instruction);

    assert.strictEqual(id1, id2, 'same instruction must return the same definition id');

    const defs = await db.getConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, []);
    assert.strictEqual(defs.length, 1, 'must not create a duplicate definition');
});

// ── 9. loadEffectiveStandingOrders: no write when nothing to migrate ───

test('loadEffectiveStandingOrders: no spurious write when all orders already have definitionId', async () => {
    const db = makeInMemoryDb();
    const defId = 'def-already';
    const instruction = 'Already linked instruction';
    const orders = [
        makeOrder('a', instruction, 'global', undefined, defId),
    ];
    await db.setConfigJson(STANDING_ORDERS_CONFIG_KEY, orders);
    await db.setConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, [
        { id: defId, name: 'Test', instruction, createdAt: Date.now() },
    ]);

    // Track writes by snapshotting the store
    const beforeStore = JSON.stringify(db._store[STANDING_ORDERS_CONFIG_KEY]);

    await loadEffectiveStandingOrders(db);

    const afterStore = JSON.stringify(db._store[STANDING_ORDERS_CONFIG_KEY]);
    assert.strictEqual(afterStore, beforeStore,
        'orders must not be rewritten when nothing needs migration or re-sync');
});

// ── Run ────────────────────────────────────────────────────────────────

Promise.all(testPromises).then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
});
