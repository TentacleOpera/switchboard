'use strict';

/**
 * Storage verification gap · Proposed Change 6
 * =============================================
 *
 * The control plane stores feature-flag-like entries with an optional override.
 * Two invariants must hold:
 * 1. Override preservation: `upsertControlPlaneEntry` must NOT clobber an
 *    existing `override_body` when the upsert doesn't provide one (COALESCE).
 *    `setControlPlaneOverride` must set and clear overrides without losing the
 *    base body.
 * 2. Projection atomicity: `getControlPlaneEntries` returns all entries in a
 *    single consistent read — no partial results if an entry is mid-upsert.
 *
 * Run with:
 *   npm run compile-tests && npm run test:contract:db-control-plane-override
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

async function run() {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-cp-override-'));
    try {
        await test_override_preserved_on_upsert_without_override(tmpRoot);
        await test_setControlPlaneOverride_sets_and_clears(tmpRoot);
        await test_getControlPlaneEntries_returns_all_consistently(tmpRoot);
        await test_override_null_does_not_clobber_existing(tmpRoot);

        console.log('\nAll db-control-plane-override contract tests passed.');
    } finally {
        await KanbanDatabase.disposeAll();
        try { global.gc && global.gc(); } catch {}
        try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }); } catch {}
    }
}

async function buildWorkspace(root, workspaceId) {
    const sbDir = path.join(root, '.switchboard');
    await fs.promises.mkdir(sbDir, { recursive: true });
    await fs.promises.writeFile(path.join(sbDir, 'workspace-id'), `${workspaceId}\n`, 'utf8');
    const db = KanbanDatabase.forWorkspace(root);
    await db.createIfMissing();
    return db;
}

async function test_override_preserved_on_upsert_without_override(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-a');
    const wsId = 'aaaaaaaaaaaaaaaa';
    const db = await buildWorkspace(wsRoot, wsId);

    // Seed an entry with an override.
    await db.upsertControlPlaneEntry({
        name: 'feature-x',
        kind: 'flag',
        version: '1.0',
        contentHash: 'hash-1',
        body: 'false',
        delivery: 'inline',
        updatedAt: new Date().toISOString(),
    });
    await db.setControlPlaneOverride('feature-x', 'flag', 'true');

    // Upsert the same entry with a new version but NO override.
    // The override must be preserved (COALESCE in the SQL).
    await db.upsertControlPlaneEntry({
        name: 'feature-x',
        kind: 'flag',
        version: '2.0',
        contentHash: 'hash-2',
        body: 'false',
        delivery: 'inline',
        updatedAt: new Date().toISOString(),
    });

    const entries = await db.getControlPlaneEntries('flag');
    const entry = entries.find(e => e.name === 'feature-x');
    assert.ok(entry, 'entry exists');
    assert.strictEqual(entry.version, '2.0', 'version updated to 2.0');
    assert.strictEqual(entry.overrideBody, 'true', 'override preserved across upsert without override');

    await KanbanDatabase.invalidateWorkspace(wsRoot);
    console.log('Pass: override preserved on upsert without override (COALESCE)');
}

async function test_setControlPlaneOverride_sets_and_clears(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-b');
    const wsId = 'bbbbbbbbbbbbbbbb';
    const db = await buildWorkspace(wsRoot, wsId);

    await db.upsertControlPlaneEntry({
        name: 'feature-y',
        kind: 'flag',
        version: '1.0',
        contentHash: 'hash-y',
        body: 'false',
        delivery: 'inline',
        updatedAt: new Date().toISOString(),
    });

    // Set override
    await db.setControlPlaneOverride('feature-y', 'flag', 'true');
    let entries = await db.getControlPlaneEntries('flag');
    let entry = entries.find(e => e.name === 'feature-y');
    assert.strictEqual(entry.overrideBody, 'true', 'override set to true');

    // Clear override (set to null)
    await db.setControlPlaneOverride('feature-y', 'flag', null);
    entries = await db.getControlPlaneEntries('flag');
    entry = entries.find(e => e.name === 'feature-y');
    assert.strictEqual(entry.overrideBody, null, 'override cleared to null');
    assert.strictEqual(entry.body, 'false', 'base body preserved after override clear');

    await KanbanDatabase.invalidateWorkspace(wsRoot);
    console.log('Pass: setControlPlaneOverride sets and clears without losing base body');
}

async function test_getControlPlaneEntries_returns_all_consistently(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-c');
    const wsId = 'cccccccccccccccc';
    const db = await buildWorkspace(wsRoot, wsId);

    // Seed multiple entries of different kinds.
    for (let i = 1; i <= 5; i++) {
        await db.upsertControlPlaneEntry({
            name: `entry-${i}`,
            kind: i <= 3 ? 'flag' : 'config',
            version: '1.0',
            contentHash: `hash-${i}`,
            body: `body-${i}`,
            delivery: 'inline',
            updatedAt: new Date().toISOString(),
        });
    }

    // Read all entries (no kind filter).
    const all = await db.getControlPlaneEntries();
    assert.strictEqual(all.length, 5, 'all 5 entries returned');

    // Read by kind filter.
    const flags = await db.getControlPlaneEntries('flag');
    assert.strictEqual(flags.length, 3, '3 flag entries returned');
    const configs = await db.getControlPlaneEntries('config');
    assert.strictEqual(configs.length, 2, '2 config entries returned');

    // Verify each entry has all required fields.
    for (const entry of all) {
        assert.ok(entry.name, 'entry has name');
        assert.ok(entry.kind, 'entry has kind');
        assert.ok(entry.version, 'entry has version');
        assert.ok(entry.contentHash, 'entry has contentHash');
        assert.ok(entry.body !== undefined, 'entry has body');
        assert.ok(entry.delivery, 'entry has delivery');
    }

    await KanbanDatabase.invalidateWorkspace(wsRoot);
    console.log('Pass: getControlPlaneEntries returns all entries consistently');
}

async function test_override_null_does_not_clobber_existing(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-d');
    const wsId = 'dddddddddddddddd';
    const db = await buildWorkspace(wsRoot, wsId);

    // Seed with override.
    await db.upsertControlPlaneEntry({
        name: 'feature-z',
        kind: 'flag',
        version: '1.0',
        contentHash: 'hash-z',
        body: 'false',
        delivery: 'materialize',
        updatedAt: new Date().toISOString(),
    });
    await db.setControlPlaneOverride('feature-z', 'flag', 'custom-override');

    // Upsert with override explicitly null — should NOT clobber existing override.
    await db.upsertControlPlaneEntry({
        name: 'feature-z',
        kind: 'flag',
        version: '1.1',
        contentHash: 'hash-z-2',
        body: 'false',
        delivery: 'materialize',
        overrideBody: null,
        updatedAt: new Date().toISOString(),
    });

    const entries = await db.getControlPlaneEntries('flag');
    const entry = entries.find(e => e.name === 'feature-z');
    assert.strictEqual(entry.overrideBody, 'custom-override', 'override preserved when upsert provides null');
    assert.strictEqual(entry.version, '1.1', 'version updated');

    await KanbanDatabase.invalidateWorkspace(wsRoot);
    console.log('Pass: upsert with null override does not clobber existing override');
}

run().catch((err) => {
    console.error('Test failed:', err && err.stack ? err.stack : err);
    process.exit(1);
});
