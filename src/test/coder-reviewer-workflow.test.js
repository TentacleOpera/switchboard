/**
 * Regression tests for Coder -> Reviewer workflow wiring.
 * Run with: node src/test/coder-reviewer-workflow.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const taskViewerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
const webviewPath = path.join(__dirname, '..', 'webview', 'implementation.html');

const taskViewerSource = fs.readFileSync(taskViewerPath, 'utf8');
const webviewSource = fs.readFileSync(webviewPath, 'utf8');

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
    console.log('\nRunning coder-reviewer workflow regression tests\n');

    test('double-start guard is present', () => {
        expectRegex(
            taskViewerSource,
            /if\s*\(\s*this\._coderReviewerSessions\.has\(sessionId\)\s*\)\s*\{\s*vscode\.window\.showErrorMessage\('Coder → Reviewer workflow is already running for this session\.'\);/s,
            'Expected duplicate session guard with user-facing error.'
        );
    });

    test('stale signal files are rejected using workflow start timestamp', () => {
        expectRegex(
            taskViewerSource,
            /workflowStartTs\s*=\s*Date\.now\(\);[\s\S]*const\s+stat\s*=\s*await\s+fs\.promises\.stat\(signalFilePath\);[\s\S]*if\s*\(\s*stat\.mtimeMs\s*<\s*workflowStartTs\s*\)\s*\{\s*return;\s*\}/s,
            'Expected mtime guard against stale signal files.'
        );
    });

    test('timeout is capped at 30 minutes and reports timeout phase', () => {
        expectRegex(
            taskViewerSource,
            /const\s+MAX_POLL_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000;/,
            'Expected 30 minute max poll cap.'
        );
        expectRegex(
            taskViewerSource,
            /stopWorkflow\('timeout'\);[\s\S]*Timed out waiting for signal file/s,
            'Expected timeout phase and user-facing timeout error.'
        );
    });

    test('reviewer dispatch posts phase and cleans up signal file', () => {
        expectRegex(
            taskViewerSource,
            /postPhase\('reviewer_dispatched'\);[\s\S]*_handleTriggerAgentActionInternal\('reviewer',\s*sessionId\)/s,
            'Expected reviewer dispatch phase before reviewer trigger.'
        );
        expectRegex(
            taskViewerSource,
            /await\s+fs\.promises\.unlink\(signalFilePath\);[\s\S]*stopWorkflow\('done'\);/s,
            'Expected signal unlink and done phase completion.'
        );
    });

    test('stop and dispose paths clear workflow timers', () => {
        expectRegex(
            taskViewerSource,
            /timers\.forEach\(t\s*=>\s*\{\s*clearTimeout\(t\);\s*clearInterval\(t\);\s*\}\);/s,
            'Expected both timeout and interval handles to be cleared.'
        );
        expectRegex(
            taskViewerSource,
            /this\._coderReviewerSessions\.forEach\(\(_, sessionId\) => this\._stopCoderReviewerWorkflow\(sessionId\)\);/,
            'Expected dispose cleanup across all active sessions.'
        );
    });

    test('webview shows polling elapsed timer and updates every second', () => {
        expectRegex(
            webviewSource,
            /phaseText\s*=\s*`Waiting for signal \(\$\{minutes\}m \$\{seconds\}s\)`;/,
            'Expected waiting label to include elapsed minutes/seconds.'
        );
        expectRegex(
            webviewSource,
            /coderReviewerPollingTicker\s*=\s*setInterval\(\(\)\s*=>\s*\{\s*renderAgentList\(\);\s*\},\s*1000\);/s,
            'Expected 1-second UI ticker for polling updates.'
        );
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run();
