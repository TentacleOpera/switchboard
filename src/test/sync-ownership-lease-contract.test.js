'use strict';

/**
 * Contract: Sync ownership lease — shared-store path.
 *
 * Asserts that:
 *  - SyncOwnershipLease uses resolveStoreTarget for local-file vs shared detection.
 *  - The shared-store lease path has acquire/renew/release with TTL and renewal.
 *  - KanbanDatabase has the sync_lease table methods.
 *  - The lease constants match the plan (60s TTL, 20s renewal).
 *
 * Run with:
 *   node src/test/sync-ownership-lease-contract.test.js
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
    console.log('\nsync-ownership-lease-contract\n');

    // ── 1. SyncOwnershipLease uses store-target resolution ────────────────

    const leaseSrc = fs.readFileSync(path.join(ROOT, 'src', 'services', 'SyncOwnershipLease.ts'), 'utf8');

    check('SyncOwnershipLease imports resolveStoreTarget', () => {
        assert.ok(/import.*resolveStoreTarget.*from.*storeTarget/.test(leaseSrc), 'must import resolveStoreTarget');
    });

    check('_isLocalFileStore uses resolveStoreTarget', () => {
        assert.ok(/resolveStoreTarget\(\)/.test(leaseSrc), 'must call resolveStoreTarget()');
        assert.ok(/target\.kind === 'local-file'/.test(leaseSrc), 'must check for local-file kind');
    });

    // ── 2. Lease constants match the plan ───────────────────────────────

    check('TTL is 60 seconds', () => {
        assert.ok(/TTL_SECONDS\s*=\s*60/.test(leaseSrc), 'TTL must be 60 seconds');
    });

    check('Renewal interval is 20 seconds', () => {
        assert.ok(/RENEW_INTERVAL_MS\s*=\s*20\s*\*\s*1000/.test(leaseSrc), 'renewal must be 20 seconds');
    });

    // ── 3. Shared-store lease path exists ────────────────────────────────

    check('Shared-store lease path: _checkSharedLease', () => {
        assert.ok(/_checkSharedLease/.test(leaseSrc), 'must have _checkSharedLease method');
    });

    check('Shared-store lease path: _acquireSharedLease', () => {
        assert.ok(/_acquireSharedLease/.test(leaseSrc), 'must have _acquireSharedLease method');
    });

    check('Shared-store lease path: _releaseSharedLease', () => {
        assert.ok(/_releaseSharedLease/.test(leaseSrc), 'must have _releaseSharedLease method');
    });

    check('Shared-store lease path: renewal timer', () => {
        assert.ok(/_startRenewalTimer/.test(leaseSrc), 'must have _startRenewalTimer method');
    });

    check('Shared-store lease checks owner_id and expires_at', () => {
        assert.ok(/owner_id/.test(leaseSrc), 'must check owner_id');
        assert.ok(/expires_at/.test(leaseSrc), 'must check expires_at');
    });

    // ── 4. KanbanDatabase has sync_lease table methods ──────────────────

    const kanbanSrc = fs.readFileSync(path.join(ROOT, 'src', 'services', 'KanbanDatabase.ts'), 'utf8');

    check('KanbanDatabase has ensureSharedLeaseTable', () => {
        assert.ok(/public async ensureSharedLeaseTable/.test(kanbanSrc), 'must have ensureSharedLeaseTable');
    });

    check('KanbanDatabase has getSharedLeaseRow', () => {
        assert.ok(/public async getSharedLeaseRow/.test(kanbanSrc), 'must have getSharedLeaseRow');
    });

    check('KanbanDatabase has acquireSyncLease with CAS', () => {
        assert.ok(/public async acquireSyncLease/.test(kanbanSrc), 'must have acquireSyncLease');
        assert.ok(/BEGIN IMMEDIATE/.test(kanbanSrc), 'must use BEGIN IMMEDIATE for CAS');
        assert.ok(/COMMIT/.test(kanbanSrc), 'must COMMIT');
        assert.ok(/ROLLBACK/.test(kanbanSrc), 'must ROLLBACK on error');
    });

    check('KanbanDatabase has releaseSyncLease', () => {
        assert.ok(/public async releaseSyncLease/.test(kanbanSrc), 'must have releaseSyncLease');
    });

    check('sync_lease table has single-row constraint (id = 1)', () => {
        assert.ok(/id INTEGER PRIMARY KEY CHECK \(id = 1\)/.test(kanbanSrc), 'must have single-row constraint');
    });

    // ── 5. Attribution (user_id) is wired ─────────────────────────────────

    check('machineAttribution has resolveUserId with source tracking', () => {
        const machSrc = fs.readFileSync(path.join(ROOT, 'src', 'services', 'machineAttribution.ts'), 'utf8');
        assert.ok(/export function resolveUserId/.test(machSrc), 'must export resolveUserId');
        assert.ok(/source.*setting.*git-config.*unknown/.test(machSrc), 'must track source: setting, git-config, unknown');
    });

    check('KanbanDatabase uses resolveUserId in plan_events INSERTs', () => {
        assert.ok(/resolveUserId/.test(kanbanSrc), 'must call resolveUserId');
        assert.ok(/user_id/.test(kanbanSrc), 'must write user_id column');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run();
