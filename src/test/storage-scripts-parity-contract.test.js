'use strict';

/**
 * Storage verification gap · Proposed Change 12 (scripts parity)
 * ==============================================================
 *
 * Every `test:contract:db-*` script in package.json must have a corresponding
 * step in `.github/workflows/integration-tests.yml`. A script that exists but
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

    // Extract all test:contract:db-* script names from package.json.
    const dbScripts = Object.keys(pkg.scripts || {}).filter(s => s.startsWith('test:contract:db-'));
    assert.ok(dbScripts.length >= 7, `expected at least 7 db-* contract scripts, found ${dbScripts.length}`);

    // Extract all `npm run test:contract:db-*` commands from the workflow YAML.
    const workflowRunPattern = /npm run (test:contract:db-[a-z0-9-]+)/g;
    const workflowScripts = new Set();
    let match;
    while ((match = workflowRunPattern.exec(workflow)) !== null) {
        workflowScripts.add(match[1]);
    }

    // Assert every db-* script has a workflow step.
    const missing = dbScripts.filter(s => !workflowScripts.has(s));
    assert.deepStrictEqual(missing, [], `db-* scripts missing from integration-tests.yml: ${missing.join(', ')}`);

    console.log(`Pass: all ${dbScripts.length} test:contract:db-* scripts have matching workflow steps`);
    console.log('\nAll storage-scripts-parity contract tests passed.');
}

run().catch((err) => {
    console.error('Test failed:', err && err.stack ? err.stack : err);
    process.exit(1);
});
