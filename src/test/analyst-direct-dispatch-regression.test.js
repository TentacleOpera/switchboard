/**
 * Regression tests for analyst direct terminal dispatch.
 * Run with: node src/test/analyst-direct-dispatch-regression.test.js
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

function extractMethodBody(tsSource, methodName) {
    const marker = `private async ${methodName}(`;
    const start = tsSource.indexOf(marker);
    if (start < 0) {
        throw new Error(`Method '${methodName}' not found`);
    }

    const bodyStart = tsSource.indexOf('{', start);
    if (bodyStart < 0) {
        throw new Error(`Method '${methodName}' body not found`);
    }

    let depth = 0;
    for (let i = bodyStart; i < tsSource.length; i++) {
        const ch = tsSource[i];
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        if (depth === 0) {
            return tsSource.slice(bodyStart, i + 1);
        }
    }

    throw new Error(`Method '${methodName}' closing brace not found`);
}

function run() {
    console.log('\nRunning analyst direct dispatch regression tests\n');

    const methodSource = extractMethodBody(source, '_handleSendAnalystMessage');

    test('uses robust terminal injection instead of inbox writes', () => {
        assert.match(
            methodSource,
            /await\s+sendRobustText\(terminal,\s*messageText,\s*true\);/,
            'Expected analyst messages to be sent via sendRobustText.'
        );
        assert.doesNotMatch(methodSource, /inbox/i, 'Expected no inbox path usage in analyst handler.');
        assert.doesNotMatch(methodSource, /_attachDispatchAuthEnvelope\(/, 'Expected no auth envelope attachment.');
        assert.doesNotMatch(methodSource, /_getSessionToken\(/, 'Expected no session token lookup.');
    });

    test('preserves terminal focus fallback behavior with awaited command', () => {
        assert.match(
            methodSource,
            /const\s+focused\s*=\s*await\s+this\._focusTerminalByName\(targetAgent\);[\s\S]*if\s*\(!focused\)\s*\{[\s\S]*await\s+vscode\.commands\.executeCommand\('switchboard\.focusTerminalByName',\s*targetAgent\);[\s\S]*\}/s,
            'Expected awaited fallback focus command after local focus miss.'
        );
    });

    test('logs analyst dispatch success and failure for activity visibility', () => {
        assert.match(
            methodSource,
            /event:\s*'analyst_dispatch_sent'/,
            'Expected analyst dispatch success event logging.'
        );
        assert.match(
            methodSource,
            /event:\s*'analyst_dispatch_failed'/,
            'Expected analyst dispatch failure event logging.'
        );
    });

    test('guards top-level failures with catch path that posts failed action', () => {
        assert.match(
            methodSource,
            /try\s*\{[\s\S]*\}\s*catch\s*\(e\)\s*\{[\s\S]*postAnalystResult\(false\);/s,
            'Expected top-level catch to post failed analyst action state.'
        );
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run();
