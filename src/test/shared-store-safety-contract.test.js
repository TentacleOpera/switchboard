'use strict';

/**
 * Contract: Shared-store safety — migration lock, version gate, offline posture.
 *
 * Asserts that:
 *  - sharedStoreSafety.ts exists with the right exports.
 *  - Migration lock has CAS acquire/release with TTL.
 *  - Version gate checks store version against client and refuses ahead.
 *  - Offline posture checks sync reachability.
 *
 * Run with:
 *   node src/test/shared-store-safety-contract.test.js
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
    console.log('\nshared-store-safety-contract\n');

    const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'sharedStoreSafety.ts'), 'utf8');

    // ── 1. Exports ────────────────────────────────────────────────────────

    check('exports acquireMigrationLock, releaseMigrationLock', () => {
        assert.ok(/export function acquireMigrationLock/.test(src), 'must export acquireMigrationLock');
        assert.ok(/export function releaseMigrationLock/.test(src), 'must export releaseMigrationLock');
    });

    check('exports checkSchemaVersion, recordSchemaVersion', () => {
        assert.ok(/export function checkSchemaVersion/.test(src), 'must export checkSchemaVersion');
        assert.ok(/export function recordSchemaVersion/.test(src), 'must export recordSchemaVersion');
    });

    check('exports checkOnlineStatus', () => {
        assert.ok(/export function checkOnlineStatus/.test(src), 'must export checkOnlineStatus');
    });

    // ── 2. Migration lock ─────────────────────────────────────────────────

    check('migration lock uses CAS (BEGIN IMMEDIATE + read + write + COMMIT)', () => {
        assert.ok(/BEGIN IMMEDIATE/.test(src), 'must use BEGIN IMMEDIATE');
        assert.ok(/COMMIT/.test(src), 'must COMMIT');
        assert.ok(/ROLLBACK/.test(src), 'must ROLLBACK on error');
    });

    check('migration lock has TTL (5 minutes default)', () => {
        assert.ok(/5\s*\*\s*60\s*\*\s*1000/.test(src), 'must have 5-minute TTL default');
    });

    check('migration lock table has single-row constraint', () => {
        assert.ok(/id INTEGER PRIMARY KEY CHECK \(id = 1\)/.test(src), 'must have single-row constraint');
    });

    check('migration lock checks expiry before taking over', () => {
        assert.ok(/Date\.now\(\)\s*>=\s*existingExpiresAt/.test(src), 'must check expiry');
    });

    // ── 3. Version gate ──────────────────────────────────────────────────

    check('version gate returns safe when store <= client', () => {
        assert.ok(/safe:\s*storeVersion\s*<=\s*clientVersion/.test(src), 'must return safe when store <= client');
    });

    check('version gate returns ahead when store > client', () => {
        assert.ok(/ahead:\s*storeVersion\s*>\s*clientVersion/.test(src), 'must return ahead when store > client');
    });

    check('version gate uses ON CONFLICT for upsert', () => {
        assert.ok(/ON CONFLICT\(id\)\s*DO UPDATE/.test(src), 'must use ON CONFLICT for upsert');
    });

    // ── 4. Offline posture ───────────────────────────────────────────────

    check('offline posture checks sync reachability', () => {
        assert.ok(/driver\.sync\(\)/.test(src), 'must call driver.sync()');
    });

    check('offline posture returns online: true for local-file (no sync method)', () => {
        assert.ok(/typeof driver\.sync !== 'function'/.test(src), 'must check for sync method');
        assert.ok(/online: true/.test(src), 'must return online: true for local-file');
    });

    check('offline posture returns error message when offline', () => {
        assert.ok(/online: false/.test(src), 'must return online: false when offline');
        assert.ok(/error/.test(src), 'must include error message');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run();
