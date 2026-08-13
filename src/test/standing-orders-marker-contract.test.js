'use strict';

/**
 * Contract: the standing-orders marker literal is byte-identical across the
 * TypeScript writer (src/services/standingOrders.ts) and the webview client
 * mirror (src/webview/terminals.js).
 *
 * The marker is the cross-boundary de-duplication token: when a prompt is
 * processed by both the client and the host, `prompt.includes(MARKER)` stops
 * a second standing-orders block from being appended. A one-sided rename
 * breaks de-duplication and delivers two blocks in one prompt. The two
 * declarations are currently held in sync by a comment alone — this test
 * enforces it mechanically so the next rename cannot silently diverge.
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js src/test/standing-orders-marker-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const STANDING_ORDERS_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'standingOrders.ts'), 'utf8'
);
const TERMINALS_JS_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'terminals.js'), 'utf8'
);

let passed = 0;
let failed = 0;

function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

/** Extract the single-quoted string value from a `const STANDING_ORDERS_MARKER = '...';` line. */
function extractMarker(src, fileLabel) {
    const m = src.match(/STANDING_ORDERS_MARKER\s*=\s*'([^']*)'/);
    assert.ok(m, `STANDING_ORDERS_MARKER literal not found in ${fileLabel}`);
    return m[1];
}

// 1. Byte-identity across both declaration sites

test('standingOrders.ts and terminals.js declare the same marker literal', () => {
    const tsMarker = extractMarker(STANDING_ORDERS_SRC, 'src/services/standingOrders.ts');
    const jsMarker = extractMarker(TERMINALS_JS_SRC, 'src/webview/terminals.js');
    assert.strictEqual(
        tsMarker, jsMarker,
        `Marker mismatch: standingOrders.ts has '${tsMarker}' but terminals.js has '${jsMarker}'. ` +
        'A one-sided rename breaks cross-boundary de-duplication and delivers two standing-order blocks.'
    );
});

// 2. The marker is not the retired product-named string

test('marker does not contain the retired "SWITCHBOARD" prefix', () => {
    const marker = extractMarker(STANDING_ORDERS_SRC, 'src/services/standingOrders.ts');
    assert.ok(
        !marker.includes('SWITCHBOARD'),
        `Marker still contains 'SWITCHBOARD': '${marker}'. The block header names the thing, not the product.`
    );
});

// 3. The marker is wrapped in the === delimiters

test('marker is wrapped in === delimiters', () => {
    const marker = extractMarker(STANDING_ORDERS_SRC, 'src/services/standingOrders.ts');
    assert.ok(
        marker.startsWith('=== ') && marker.endsWith(' ==='),
        `Marker must be wrapped in '=== ... ===' delimiters, got: '${marker}'`
    );
});

// 4. validateInstruction rejects a string containing the marker

test('validateInstruction rejects an instruction containing the marker', () => {
    const marker = extractMarker(STANDING_ORDERS_SRC, 'src/services/standingOrders.ts');
    // Source-level assertion: the validateInstruction function dereferences the
    // constant, so this is a structural check that the guard exists.
    assert.ok(
        STANDING_ORDERS_SRC.includes('text.includes(STANDING_ORDERS_MARKER)'),
        'validateInstruction must guard against the marker via text.includes(STANDING_ORDERS_MARKER)'
    );
    // Sanity: the marker we extracted is a non-empty string.
    assert.ok(marker.length > 0, 'Marker must not be empty');
});

// Summary

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
