'use strict';

/**
 * Contract: Reconcile and delete stale local ticket markdown files on fetch.
 *
 * Source-level assertions against TaskViewerProvider.ts, per the plan:
 *  1. _collectDeletionCandidates no longer skips files with parentId: frontmatter.
 *  2. The prune's locally-modified preservation is gated on !authoritative.
 *
 * Run with:
 *   node src/test/tickets-reconcile-stale-files-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', '..', 'src', 'services', 'TaskViewerProvider.ts');
const source = fs.readFileSync(SRC, 'utf8');

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
    console.log('\ntickets-reconcile-stale-files-contract\n');

    // ── 1. parentId skip removed from _collectDeletionCandidates ────────

    check('_collectDeletionCandidates no longer skips parentId files', () => {
        // The old skip was: if (/^parentId:\s*\S+/m.test(head)) { continue; }
        // It must NOT appear inside _collectDeletionCandidates.
        const fnStart = source.indexOf('_collectDeletionCandidates');
        assert.ok(fnStart >= 0, '_collectDeletionCandidates must exist');
        // Find the end of the function (next private method or closing brace at depth 0)
        const fnBody = source.slice(fnStart, fnStart + 3000);
        assert.ok(!/parentId.*\\s.*\\S.*continue/.test(fnBody),
            'must not skip parentId files — they are nominated and probed individually');
        assert.ok(!/not a sidebar entry and must not be nominated/.test(fnBody),
            'the old comment justifying the skip must be gone');
    });

    // ── 2. prune locally-modified preservation gated on !authoritative ───

    check('prune locally-modified preservation gated on !authoritative', () => {
        // The old code: if (dbEntry && dbEntry.lastSyncedAt) {
        // The new code: if (!authoritative && dbEntry && dbEntry.lastSyncedAt) {
        // Find the prune block
        const pruneStart = source.indexOf('!isDelta && targetDir && fetchIsAuthoritative');
        assert.ok(pruneStart >= 0, 'prune block must exist');
        const pruneBody = source.slice(pruneStart, pruneStart + 2000);
        assert.ok(/!authoritative\s*&&\s*dbEntry\s*&&\s*dbEntry\.lastSyncedAt/.test(pruneBody),
            'locally-modified preservation must be gated on !authoritative');
    });

    // ── 3. subtask files still nominated with remoteIds guard ──────────

    check('subtask files nominated with remoteIds.has guard intact', () => {
        const fnStart = source.indexOf('_collectDeletionCandidates');
        const fnBody = source.slice(fnStart, fnStart + 3000);
        // The add() function with remoteIds.has(remoteId) guard must still be present
        assert.ok(/remoteIds\.has\(remoteId\)/.test(fnBody),
            'remoteIds.has(remoteId) guard must still spare subtasks present in remote payload');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run();
