'use strict';

/**
 * Storage verification gap · Proposed Change 12 (scripts parity)
 * ==============================================================
 *
 * Every `test:contract:*` script in package.json must have a corresponding step in
 * `.github/workflows/integration-tests.yml` (or a reasoned KNOWN_UNWIRED entry). A script that exists but
 * is not wired into CI is a silent gap — the test runs green locally but never
 * blocks a regression.
 *
 * This test parses package.json and the workflow YAML, extracts the script names
 * and the `npm run` commands, and asserts that every `test:contract:db-*` script
 * has a matching workflow step.
 *
 * Run with:
 *   npm run compile-tests && npm run test:contract:storage-scripts-parity
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function run() {
    const repoRoot = process.cwd();
    const pkgPath = path.join(repoRoot, 'package.json');
    const workflowPath = path.join(repoRoot, '.github', 'workflows', 'integration-tests.yml');

    const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf8'));
    const workflow = await fs.promises.readFile(workflowPath, 'utf8');

    // WIDENED from `test:contract:db-*` to EVERY `test:contract:*`.
    //
    // The narrow prefix was itself the hole. `storage-topology`,
    // `board-read-endpoints` and `plan-tickets` all landed as real contract tests
    // outside the `db-` prefix, and two of the three were never invoked by CI — one
    // had no package.json script at all. The gate that exists to catch
    // "defined but never run" reported green throughout, because the thing it
    // checks is a naming convention rather than the set of tests.
    //
    // Anything genuinely not meant to run belongs on KNOWN_UNWIRED with a reason, so
    // the exclusion is a visible decision rather than an accident.
    const KNOWN_UNWIRED = new Map([
        [
            'test:contract:terminal-operations-no-periodic-reopen',
            'Fails STALE on main — its fourth assertion pins three identifiers that no longer '
            + 'exist in implementation.html. Deliberately excluded; see the note in integration-tests.yml.'
        ],
        [
            'test:contract:tmux-view-chrome',
            'Never wired since it was written; unrelated to any storage work. Wire or delete it '
            + 'in the terminal-view ticket rather than here.'
        ],
    ]);

    const contractScripts = Object.keys(pkg.scripts || {}).filter(s => s.startsWith('test:contract:'));
    assert.ok(contractScripts.length >= 100, `expected at least 100 contract scripts, found ${contractScripts.length}`);

    const dbScripts = contractScripts.filter(s => s.startsWith('test:contract:db-'));
    assert.ok(dbScripts.length >= 7, `expected at least 7 db-* contract scripts, found ${dbScripts.length}`);

    // Extract every `npm run test:contract:*` command from the workflow YAML.
    const workflowRunPattern = /npm run (test:contract:[a-z0-9:-]+)/g;
    const workflowScripts = new Set();
    let match;
    while ((match = workflowRunPattern.exec(workflow)) !== null) {
        workflowScripts.add(match[1]);
    }

    const missing = contractScripts.filter(s => !workflowScripts.has(s) && !KNOWN_UNWIRED.has(s));
    assert.deepStrictEqual(
        missing,
        [],
        `contract scripts defined in package.json but never invoked by integration-tests.yml `
        + `(a test that CI does not run is green-by-never-running — wire it, or add it to `
        + `KNOWN_UNWIRED with a reason): ${missing.join(', ')}`
    );

    // A workflow step naming a script that does not exist fails the run with
    // "Missing script", so pin that direction too.
    const scriptNames = new Set(contractScripts);
    const dangling = [...workflowScripts].filter(s => !scriptNames.has(s));
    assert.deepStrictEqual(dangling, [], `integration-tests.yml invokes scripts absent from package.json: ${dangling.join(', ')}`);

    // An entry that has since been wired should leave KNOWN_UNWIRED, or the list
    // becomes a place exclusions go to be forgotten.
    const staleExclusions = [...KNOWN_UNWIRED.keys()].filter(s => workflowScripts.has(s));
    assert.deepStrictEqual(staleExclusions, [], `KNOWN_UNWIRED names scripts that ARE wired — remove them: ${staleExclusions.join(', ')}`);

    console.log(`Pass: all ${contractScripts.length - KNOWN_UNWIRED.size} wired test:contract:* scripts have matching workflow steps`);
    console.log(`      (${KNOWN_UNWIRED.size} deliberately unwired: ${[...KNOWN_UNWIRED.keys()].join(', ')})`);
    console.log('\nAll storage-scripts-parity contract tests passed.');
}

run().catch((err) => {
    console.error('Test failed:', err && err.stack ? err.stack : err);
    process.exit(1);
});
