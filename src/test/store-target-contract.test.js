'use strict';

/**
 * Contract: Store-target abstraction — per-target binding resolution.
 *
 * Asserts that:
 *  - storeTarget.ts exists with the right exports.
 *  - libSqlDriver.ts exists and implements ISqliteDriver.
 *  - KanbanDatabase uses openDriver for per-target resolution.
 *  - libsql is declared as an optionalDependency (pinned exact).
 *  - The LibSqlDriver supports embedded-replica sync.
 *
 * Run with:
 *   node src/test/store-target-contract.test.js
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
    console.log('\nstore-target-contract\n');

    // ── 1. storeTarget.ts exists with the right exports ──────────────────

    const storeTargetSrc = fs.readFileSync(path.join(ROOT, 'src', 'services', 'storeTarget.ts'), 'utf8');

    check('storeTarget.ts exports resolveStoreTarget, openDriver, checkLibSqlAvailability', () => {
        assert.ok(/export function resolveStoreTarget/.test(storeTargetSrc), 'must export resolveStoreTarget');
        assert.ok(/export function openDriver/.test(storeTargetSrc), 'must export openDriver');
        assert.ok(/export function checkLibSqlAvailability/.test(storeTargetSrc), 'must export checkLibSqlAvailability');
    });

    check('StoreTargetKind includes local-file and libsql', () => {
        assert.ok(/local-file/.test(storeTargetSrc), 'must include local-file kind');
        assert.ok(/libsql/.test(storeTargetSrc), 'must include libsql kind');
    });

    check('openDriver lazily requires LibSqlDriver for libsql targets', () => {
        assert.ok(/require\('\.\/libSqlDriver'\)/.test(storeTargetSrc), 'must lazily require libSqlDriver');
    });

    check('checkLibSqlAvailability surfaces binding errors', () => {
        assert.ok(/available: false/.test(storeTargetSrc), 'must return available: false on error');
        assert.ok(/reason/.test(storeTargetSrc), 'must include a reason string');
    });

    // ── 2. libSqlDriver.ts exists and implements ISqliteDriver ────────────

    const libSqlSrc = fs.readFileSync(path.join(ROOT, 'src', 'services', 'libSqlDriver.ts'), 'utf8');

    check('libSqlDriver.ts exports LibSqlDriver class', () => {
        assert.ok(/export class LibSqlDriver implements ISqliteDriver/.test(libSqlSrc), 'must export LibSqlDriver');
    });

    check('LibSqlDriver implements all ISqliteDriver methods', () => {
        for (const method of ['prepare', 'run', 'get', 'all', 'exec', 'transaction', 'readOnlyTransaction', 'close', 'backup', 'getRowsModified', 'isOpen', 'onMutation']) {
            assert.ok(new RegExp(`public\\s+(async\\s+)?${method}\\b`).test(libSqlSrc), `must implement ${method}`);
        }
    });

    check('LibSqlDriver supports embedded-replica sync', () => {
        assert.ok(/syncUrl/.test(libSqlSrc), 'must support syncUrl option');
        assert.ok(/public sync\(\)/.test(libSqlSrc), 'must have public sync method');
        assert.ok(/db\.sync\(\)/.test(libSqlSrc), 'must call db.sync()');
    });

    check('LibSqlDriver lazily requires libsql', () => {
        assert.ok(/require\('libsql'\)/.test(libSqlSrc), 'must lazily require libsql');
    });

    check('LibSqlDriver sets WAL pragmas', () => {
        assert.ok(/PRAGMA journal_mode = WAL/.test(libSqlSrc), 'must set WAL journal mode');
        assert.ok(/PRAGMA synchronous = NORMAL/.test(libSqlSrc), 'must set synchronous=NORMAL');
        assert.ok(/PRAGMA foreign_keys = ON/.test(libSqlSrc), 'must enable foreign keys');
    });

    check('LibSqlDriver reuses BetterSqliteStatementShim for cursor compatibility', () => {
        assert.ok(/BetterSqliteStatementShim/.test(libSqlSrc), 'must reuse the cursor shim');
    });

    // ── 3. KanbanDatabase uses openDriver for per-target resolution ──────

    const kanbanSrc = fs.readFileSync(path.join(ROOT, 'src', 'services', 'KanbanDatabase.ts'), 'utf8');

    check('KanbanDatabase imports openDriver from storeTarget', () => {
        assert.ok(/import.*openDriver.*from.*storeTarget/.test(kanbanSrc), 'must import openDriver');
    });

    check('KanbanDatabase uses openDriver instead of new BetterSqliteDriver for main DB', () => {
        // The main DB opening paths should use openDriver, not new BetterSqliteDriver
        const openDriverCount = (kanbanSrc.match(/openDriver\(/g) || []).length;
        assert.ok(openDriverCount >= 2, `must use openDriver at least twice (found ${openDriverCount})`);
    });

    // ── 4. libsql is declared as an optionalDependency (pinned exact) ────

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    check('libsql is declared as an optionalDependency', () => {
        assert.ok(pkg.optionalDependencies, 'must have optionalDependencies');
        assert.ok(pkg.optionalDependencies.libsql, 'must declare libsql as optional dependency');
    });

    check('libsql is pinned to an exact version (no ^ or ~)', () => {
        const ver = pkg.optionalDependencies.libsql;
        assert.ok(!/^[~^]/.test(ver), `must be pinned exact (found "${ver}")`);
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run();
