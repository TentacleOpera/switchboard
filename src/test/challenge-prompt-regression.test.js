/**
 * Regression tests for optional inline challenge prompt wiring.
 * Run with: node src/test/challenge-prompt-regression.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
const webviewPath = path.join(__dirname, '..', 'webview', 'implementation.html');
const packagePath = path.join(__dirname, '..', '..', 'package.json');

const providerSource = fs.readFileSync(providerPath, 'utf8');
const webviewSource = fs.readFileSync(webviewPath, 'utf8');
const packageSource = fs.readFileSync(packagePath, 'utf8');

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
    console.log('\nRunning challenge prompt regression tests\n');

    test('provider parses with-challenge instruction flag', () => {
        expectRegex(
            providerSource,
            /private\s+_parsePromptInstruction\(instruction\?:\s*string\):\s*\{\s*baseInstruction\?:\s*string;\s*includeInlineChallenge:\s*boolean\s*\}/,
            'Expected TaskViewerProvider to expose prompt instruction parsing for optional challenge mode.'
        );
        expectRegex(
            providerSource,
            /if\s*\(\s*instruction\s*===\s*'with-challenge'\s*\)\s*\{\s*return\s*\{\s*baseInstruction:\s*undefined,\s*includeInlineChallenge:\s*true\s*\};/s,
            'Expected a bare with-challenge instruction to enable inline challenge without changing the base action.'
        );
    });

    test('lead challenge option is resolved through lead-only prompt settings', () => {
        expectRegex(
            providerSource,
            /private\s+_getPromptInstructionOptions\(role:\s*string,\s*instruction\?:\s*string\):\s*\{\s*baseInstruction\?:\s*string;\s*includeInlineChallenge:\s*boolean\s*\}/,
            'Expected TaskViewerProvider to expose a role-aware helper for challenge prompt options.'
        );
        expectRegex(
            providerSource,
            /if\s*\(\s*role\s*!==\s*'lead'\s*\)\s*\{\s*return\s*\{\s*baseInstruction:\s*parsedInstruction\.baseInstruction,\s*includeInlineChallenge:\s*false\s*\};/s,
            'Expected inline challenge to be disabled for non-lead roles, including coder.'
        );
        expectRegex(
            providerSource,
            /this\._isLeadInlineChallengeEnabled\(\)/,
            'Expected the role-aware prompt helper to honor the persisted Lead Coder setting.'
        );
        expectRegex(
            providerSource,
            /get<boolean>\('leadCoder\.inlineChallenge',\s*false\)/,
            'Expected the Lead Coder challenge setting to be read from workspace configuration.'
        );
    });

    test('setup stores a lead-only challenge option instead of dedicated dispatch buttons', () => {
        expectRegex(
            webviewSource,
            /id="lead-challenge-toggle"/,
            'Expected the setup UI to expose a Lead Coder challenge toggle.'
        );
        expectRegex(
            webviewSource,
            /type:\s*'getLeadChallengeSetting'/,
            'Expected the setup panel to request the saved Lead Coder challenge setting.'
        );
        expectRegex(
            webviewSource,
            /leadChallengeEnabled/,
            'Expected the setup save payload to include the Lead Coder challenge setting.'
        );
        assert.ok(
            !/challengeBtn\.innerText\s*=\s*'WITH CHALLENGE';/.test(webviewSource),
            'Implementation view should not render a dedicated WITH CHALLENGE action button.'
        );
        assert.ok(
            !/instruction:\s*'with-challenge'/.test(webviewSource),
            'Implementation view should not dispatch with-challenge directly from the action buttons.'
        );
    });

    test('package configuration declares the lead-only challenge option', () => {
        expectRegex(
            packageSource,
            /"switchboard\.leadCoder\.inlineChallenge"\s*:\s*\{/,
            'Expected package.json to contribute a lead-only inline challenge setting.'
        );
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run();
