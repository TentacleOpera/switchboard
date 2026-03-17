/**
 * Regression tests for review-comment terminal transport reliability.
 * Run with: node src/test/review-comment-transport-regression.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const extensionPath = path.join(__dirname, '..', 'extension.ts');
const terminalUtilsPath = path.join(__dirname, '..', 'services', 'terminalUtils.ts');
const extensionSource = fs.readFileSync(extensionPath, 'utf8');
const terminalUtilsSource = fs.readFileSync(terminalUtilsPath, 'utf8');

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

function extractCommandBody(tsSource, commandName) {
    const marker = `'${commandName}'`;
    const markerIndex = tsSource.indexOf(marker);
    if (markerIndex < 0) {
        throw new Error(`Command '${commandName}' not found`);
    }

    const asyncIndex = tsSource.indexOf('async (request', markerIndex);
    if (asyncIndex < 0) {
        throw new Error(`Command '${commandName}' handler not found`);
    }

    const bodyStart = tsSource.indexOf('{', asyncIndex);
    if (bodyStart < 0) {
        throw new Error(`Command '${commandName}' body start not found`);
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

    throw new Error(`Command '${commandName}' closing brace not found`);
}

function extractExportedFunctionBody(tsSource, functionName) {
    const marker = `export async function ${functionName}(`;
    const start = tsSource.indexOf(marker);
    if (start < 0) {
        throw new Error(`Function '${functionName}' not found`);
    }

    const bodyStart = tsSource.indexOf('{', start);
    if (bodyStart < 0) {
        throw new Error(`Function '${functionName}' body start not found`);
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

    throw new Error(`Function '${functionName}' closing brace not found`);
}

function run() {
    console.log('\nRunning review-comment transport regression tests\n');

    const reviewCommandSource = extractCommandBody(extensionSource, 'switchboard.sendReviewComment');
    const sharedHelperSource = extractExportedFunctionBody(terminalUtilsSource, 'sendRobustText');

    test('review comment command imports and uses the shared terminal helper', () => {
        assert.match(
            extensionSource,
            /import\s*\{\s*sendRobustText\s*\}\s*from\s*['"]\.\/services\/terminalUtils['"];?/,
            'Expected extension.ts to import sendRobustText from terminalUtils.'
        );
        assert.match(
            reviewCommandSource,
            /await\s+sendRobustText\(selectedTerminal,\s*payload,\s*true\);/,
            'Expected review comments to use the shared sendRobustText helper.'
        );
    });

    test('extension no longer carries a bespoke sendRobustText implementation', () => {
        assert.doesNotMatch(
            extensionSource,
            /async function sendRobustText\s*\(/,
            'Expected extension.ts to rely on the shared helper instead of a local duplicate.'
        );
    });

    test('shared helper preserves CLI submit behavior with repeated terminal submits', () => {
        assert.match(
            sharedHelperSource,
            /const\s+isCliAgent\s*=\s*\/\\b\(copilot\|gemini\|claude\|windsurf\|cursor\|cortex\)\\b\/i\.test\(terminal\.name\);/,
            'Expected shared helper to detect known CLI terminals that need extra submit behavior.'
        );
        assert.match(
            sharedHelperSource,
            /await\s+new\s+Promise\(r\s*=>\s*setTimeout\(r,\s*NEWLINE_DELAY\)\);\s*terminal\.sendText\('',\s*true\);/s,
            'Expected shared helper to submit via terminal.sendText("", true).'
        );
        assert.match(
            sharedHelperSource,
            /if\s*\(isCliAgent\)\s*\{[\s\S]*terminal\.sendText\('',\s*true\);[\s\S]*terminal\.sendText\('',\s*true\);[\s\S]*\}/s,
            'Expected shared helper to send extra submit presses for CLI terminals.'
        );
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run();
