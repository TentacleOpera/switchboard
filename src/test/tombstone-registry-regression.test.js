/**
 * Regression tests for plan tombstone registry wiring.
 * Run with: node src/test/tombstone-registry-regression.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
const source = fs.readFileSync(providerPath, 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (error) {
        console.error(`  FAIL ${name}: ${error.message}`);
        failed++;
    }
}

function expectRegex(regex, message) {
    assert.match(source, regex, message);
}

function run() {
    console.log('\nRunning tombstone registry regression tests\n');

    test('tombstone load is initialized through a dedicated ensure helper', () => {
        expectRegex(
            /private _ensureTombstonesLoaded\(workspaceRoot: string\): Promise<void> \{[\s\S]*_seedTombstones\(workspaceRoot\);[\s\S]*_loadTombstones\(workspaceRoot\);[\s\S]*\}/s,
            'Expected _ensureTombstonesLoaded to seed and load tombstones.'
        );
    });

    test('brain watcher setup initializes tombstones before mirroring', () => {
        expectRegex(
            /void this\._ensureTombstonesLoaded\(workspaceRoot\)\.catch\(/,
            'Expected watcher setup pre-load call.'
        );
        expectRegex(
            /await this\._ensureTombstonesLoaded\(workspaceRoot\);[\s\S]*await this\._mirrorBrainPlan\(fullPath\);/s,
            'Expected watcher debounce callback to await tombstone readiness before mirroring.'
        );
    });

    test('mirror path also ensures tombstones are loaded', () => {
        expectRegex(
            /private async _mirrorBrainPlan\(brainFilePath: string\): Promise<void> \{[\s\S]*await this\._ensureTombstonesLoaded\(workspaceRoot\);/s,
            'Expected _mirrorBrainPlan to ensure tombstones before hash gate.'
        );
    });

    test('seed creates the tombstone file via tmp rename even when empty', () => {
        expectRegex(
            /private async _seedTombstones\(workspaceRoot: string\): Promise<void> \{[\s\S]*const tmpPath = filePath \+ '\.tmp';[\s\S]*writeFile\(tmpPath,[\s\S]*\);[\s\S]*rename\(tmpPath, filePath\);/s,
            'Expected seed path to use atomic tmp write + rename.'
        );
    });

    test('add tombstone validates hash and only updates in-memory set after durable write', () => {
        expectRegex(
            /if \(!this\._isValidTombstoneHash\(hash\)\) return;/,
            'Expected hash validation in _addTombstone.'
        );
        expectRegex(
            /writeFile\(tmpPath,[\s\S]*\);[\s\S]*rename\(tmpPath, filePath\);[\s\S]*this\._tombstones\.add\(hash\);/s,
            'Expected in-memory tombstone update after file rename.'
        );
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run();
