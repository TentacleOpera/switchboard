'use strict';
/**
 * Verb transport timeout contract.
 *
 * Asserts structural invariants in src/webview/transport.js:
 *  1. Every `fetch(` call includes `signal:` in its options.
 *  2. VERB_SIGNAL_TIMEOUT_MS and VERB_ABORT_TIMEOUT_MS exist as named numeric constants.
 *  3. AbortController is instantiated and used.
 *  4. The .catch() handler surfaces failures to UI (showTransportError or showStatusMessage),
 *     distinguishes AbortError, and does not just console.error.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const TRANSPORT_SRC = path.join(repoRoot, 'src', 'webview', 'transport.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(e && e.stack ? e.stack : e);
        failed++;
    }
}

console.log('Verb transport timeout contract');

const content = fs.readFileSync(TRANSPORT_SRC, 'utf8');

test('VERB_SIGNAL_TIMEOUT_MS exists as a named numeric constant', () => {
    const match = content.match(/const\s+VERB_SIGNAL_TIMEOUT_MS\s*=\s*(\d+);/);
    assert(match, 'Expected const VERB_SIGNAL_TIMEOUT_MS = <number> in transport.js');
    const val = Number(match[1]);
    assert(Number.isFinite(val) && val > 0, 'VERB_SIGNAL_TIMEOUT_MS must be a positive finite number');
    assert.strictEqual(val, 5000, 'VERB_SIGNAL_TIMEOUT_MS should be 5000ms');
});

test('VERB_ABORT_TIMEOUT_MS exists as a named numeric constant', () => {
    const match = content.match(/const\s+VERB_ABORT_TIMEOUT_MS\s*=\s*(\d+);/);
    assert(match, 'Expected const VERB_ABORT_TIMEOUT_MS = <number> in transport.js');
    const val = Number(match[1]);
    assert(Number.isFinite(val) && val > 0, 'VERB_ABORT_TIMEOUT_MS must be a positive finite number');
    assert.strictEqual(val, 60000, 'VERB_ABORT_TIMEOUT_MS should be 60000ms');
});

test('AbortController is used in transport.js', () => {
    assert(content.includes('new AbortController()'), 'Expected new AbortController() in transport.js');
    assert(content.includes('controller.abort()'), 'Expected controller.abort() call in transport.js');
});

test('Every fetch() in transport.js includes signal option', () => {
    // Find each occurrence of fetch( and check that its argument block includes signal:
    let idx = 0;
    let count = 0;
    while ((idx = content.indexOf('fetch(', idx)) !== -1) {
        count++;
        // Look ahead 500 chars to find closing ) of fetch call options
        const snippet = content.slice(idx, idx + 500);
        assert(/signal\s*:/.test(snippet), `fetch call starting at index ${idx} must pass signal option`);
        idx += 6;
    }
    assert(count > 0, 'Expected at least one fetch() call in transport.js');
});

test('showTransportPending and clearTransportPending are defined and used', () => {
    assert(content.includes('function showTransportPending('), 'Expected function showTransportPending');
    assert(content.includes('function clearTransportPending('), 'Expected function clearTransportPending');
    assert(content.includes('showTransportPending(verb)'), 'Expected call to showTransportPending(verb)');
    assert(content.includes('clearTransportPending()'), 'Expected call to clearTransportPending()');
});

test('The postMessage .catch() handler surfaces errors to UI and distinguishes AbortError', () => {
    const fetchCatchRegex = /\.catch\(function\s*\(err\)\s*\{[\s\S]*?cleanupVerbTimers\(\);[\s\S]*?\}\);/;
    const match = content.match(fetchCatchRegex);
    assert(match, 'Expected postMessage fetch .catch(function (err) { ... }) in transport.js');
    const catchBody = match[0];

    assert(catchBody.includes('AbortError'), 'catch block must check for AbortError');
    assert(catchBody.includes('showTransportError'), 'catch block must reference showTransportError');
    assert(catchBody.includes('showStatusMessage'), 'catch block must reference showStatusMessage');
    assert(catchBody.includes('cleanupVerbTimers'), 'catch block must invoke cleanupVerbTimers');
});

if (failed > 0) {
    process.exit(1);
}
