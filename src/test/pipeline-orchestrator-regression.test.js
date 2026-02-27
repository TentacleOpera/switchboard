/**
 * Regression tests for Pipeline orchestrator wiring/logic.
 * Run with: node src/test/pipeline-orchestrator-regression.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const orchestratorPath = path.join(__dirname, '..', 'services', 'PipelineOrchestrator.ts');
const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');

const orchestratorSource = fs.readFileSync(orchestratorPath, 'utf8');
const providerSource = fs.readFileSync(providerPath, 'utf8');

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

function expectRegex(source, regex, message) {
    assert.match(source, regex, message);
}

function run() {
    console.log('\nRunning pipeline orchestrator regression tests\n');

    test('advance excludes completed run sheets before stage detection', () => {
        expectRegex(
            orchestratorSource,
            /const\s+activeSheets\s*=\s*sheets\.filter\(\(sheet:\s*any\)\s*=>\s*sheet\?\.completed\s*!==\s*true\);/,
            'Expected completed runsheets to be filtered out before stage computation.'
        );
    });

    test('zero active plans keeps pipeline running idle', () => {
        expectRegex(
            orchestratorSource,
            /if\s*\(\s*activeSheets\.length\s*===\s*0\s*\)\s*\{[\s\S]*this\._pendingCount\s*=\s*0;[\s\S]*this\._secondsRemaining\s*=\s*this\._intervalSeconds;[\s\S]*return;[\s\S]*\}/s,
            'Expected no-active-plan branch to keep timer cadence instead of auto-stop.'
        );
    });

    test('restore validates non-completed plans and restores paused state', () => {
        expectRegex(
            orchestratorSource,
            /const\s+nonCompletedSheets\s*=\s*sheets\.filter\(\(sheet:\s*any\)\s*=>\s*sheet\?\.completed\s*!==\s*true\);[\s\S]*if\s*\(\s*nonCompletedSheets\.length\s*===\s*0\s*\)\s*\{[\s\S]*_clearPersisted\(\);[\s\S]*return;[\s\S]*\}/s,
            'Expected restore to clear stale state when no non-completed runsheets exist.'
        );
        expectRegex(
            orchestratorSource,
            /this\._paused\s*=\s*this\._globalState\?\.get<boolean>\('pipeline\.paused',\s*false\)\s*\?\?\s*false;/,
            'Expected restore to hydrate paused flag from persisted state.'
        );
    });

    test('stop clears pendingCount for clean stopped state', () => {
        expectRegex(
            orchestratorSource,
            /stop\(\):\s*void\s*\{[\s\S]*this\._pendingCount\s*=\s*0;[\s\S]*\}/s,
            'Expected stop() to clear pendingCount.'
        );
    });

    test('provider pipeline callback throws when sidebar dispatch fails', () => {
        expectRegex(
            providerSource,
            /this\._pipeline\s*=\s*new\s+PipelineOrchestrator\([\s\S]*const\s+dispatched\s*=\s*await\s+this\._handleTriggerAgentActionInternal\(role,\s*sessionId,\s*instruction\);[\s\S]*if\s*\(\s*!dispatched\s*\)\s*\{[\s\S]*throw\s+new\s+Error\(`Pipeline dispatch failed for role '\$\{role\}' in session '\$\{sessionId\}'\.`\);[\s\S]*\}/s,
            'Expected pipeline dispatch callback to propagate failure.'
        );
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run();
