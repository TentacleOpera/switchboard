'use strict';

/**
 * Contract: Store-backed remote provider — a fourth RemoteProviderKind.
 *
 * Asserts that:
 *  - RemoteProviderKind includes 'store'.
 *  - StoreRemoteProvider implements RemoteProvider with pull-only semantics.
 *  - The plan_inbox queue table exists with the right schema.
 *  - KanbanDatabase has execSql, runSql, querySql pass-through methods.
 *  - The provider validates on read (empty title/body, workspace_id, 100KB cap).
 *  - The filename convention follows store_import_${id}.md.
 *
 * Run with:
 *   node src/test/store-remote-provider-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err && err.message ? err.message : err}`);
    }
}

function run() {
    console.log('\nstore-remote-provider-contract\n');

    // ── 1. RemoteProviderKind includes 'store' ───────────────────────────

    check("RemoteProviderKind includes 'store'", () => {
        const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'RemoteControlService.ts'), 'utf8');
        assert.ok(/'store'/.test(src), "RemoteProviderKind must include 'store'");
        assert.ok(/RemoteProviderKind.*=.*'linear'.*'notion'.*'clickup'.*'store'/.test(src.replace(/\s+/g, ' ')),
            "type must list all four kinds");
    });

    // ── 2. StoreRemoteProvider implements RemoteProvider ────────────────

    const providerSrc = fs.readFileSync(path.join(ROOT, 'src', 'services', 'StoreRemoteProvider.ts'), 'utf8');

    check('StoreRemoteProvider class exists', () => {
        assert.ok(/export class StoreRemoteProvider implements RemoteProvider/.test(providerSrc),
            'must export StoreRemoteProvider implementing RemoteProvider');
    });

    check('StoreRemoteProvider is pull-only (canPushState: false, canPushContent: false)', () => {
        assert.ok(/canPushState:\s*false/.test(providerSrc), 'canPushState must be false');
        assert.ok(/canPushContent:\s*false/.test(providerSrc), 'canPushContent must be false');
        assert.ok(/canPostComments:\s*false/.test(providerSrc), 'canPostComments must be false');
    });

    check('StoreRemoteProvider implements fetchStateDeltas', () => {
        assert.ok(/fetchStateDeltas/.test(providerSrc), 'must implement fetchStateDeltas');
    });

    check('StoreRemoteProvider implements importRemotePlan', () => {
        assert.ok(/importRemotePlan/.test(providerSrc), 'must implement importRemotePlan');
    });

    check('StoreRemoteProvider implements stateKeyToColumn', () => {
        assert.ok(/stateKeyToColumn/.test(providerSrc), 'must implement stateKeyToColumn');
    });

    // ── 3. plan_inbox queue table ────────────────────────────────────────

    check('plan_inbox table has the right schema', () => {
        assert.ok(/plan_inbox/.test(providerSrc), 'must reference plan_inbox table');
        assert.ok(/id TEXT PRIMARY KEY/.test(providerSrc), 'must have id as primary key');
        assert.ok(/idempotency_key TEXT NOT NULL/.test(providerSrc), 'must have idempotency_key');
        assert.ok(/workspace_id TEXT NOT NULL/.test(providerSrc), 'must have workspace_id');
        assert.ok(/title TEXT NOT NULL/.test(providerSrc), 'must have title');
        assert.ok(/body TEXT NOT NULL/.test(providerSrc), 'must have body');
        assert.ok(/status TEXT NOT NULL/.test(providerSrc), 'must have status');
        assert.ok(/provenance/.test(providerSrc), 'must have provenance');
        assert.ok(/materialised_path/.test(providerSrc), 'must have materialised_path');
        assert.ok(/error/.test(providerSrc), 'must have error column');
    });

    check('plan_inbox has indexes for status and idempotency', () => {
        assert.ok(/idx_plan_inbox_status/.test(providerSrc), 'must have status index');
        assert.ok(/idx_plan_inbox_idempotency/.test(providerSrc), 'must have idempotency index');
    });

    // ── 4. Validation on read ────────────────────────────────────────────

    check('validates on read (empty title, empty body, empty workspace_id, 100KB cap)', () => {
        assert.ok(/empty title/.test(providerSrc), 'must validate empty title');
        assert.ok(/empty body/.test(providerSrc), 'must validate empty body');
        assert.ok(/empty workspace_id/.test(providerSrc), 'must validate empty workspace_id');
        assert.ok(/100\s*\*\s*1024/.test(providerSrc), 'must have 100KB cap');
    });

    // ── 5. Filename convention ──────────────────────────────────────────

    check('filename follows store_import_${id}.md convention', () => {
        assert.ok(/store_import_\$\{remoteId\}\.md/.test(providerSrc), 'must use store_import_${id}.md');
    });

    // ── 6. KanbanDatabase has SQL pass-through methods ───────────────────

    check('KanbanDatabase has execSql, runSql, querySql', () => {
        const kanbanSrc = fs.readFileSync(path.join(ROOT, 'src', 'services', 'KanbanDatabase.ts'), 'utf8');
        assert.ok(/public execSql/.test(kanbanSrc), 'must have execSql');
        assert.ok(/public runSql/.test(kanbanSrc), 'must have runSql');
        assert.ok(/public querySql/.test(kanbanSrc), 'must have querySql');
    });

    // ── 7. Pull-only stubs ───────────────────────────────────────────────

    check('pull-only stubs for pushState, pushContent, postComment, archiveCard', () => {
        assert.ok(/pushState.*no-op/.test(providerSrc.replace(/\s+/g, ' ')), 'pushState must be no-op');
        assert.ok(/pushContent.*no-op/.test(providerSrc.replace(/\s+/g, ' ')), 'pushContent must be no-op');
        assert.ok(/postComment.*no-op/.test(providerSrc.replace(/\s+/g, ' ')), 'postComment must be no-op');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run();
