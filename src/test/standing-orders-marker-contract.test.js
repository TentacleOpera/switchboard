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

// 5. Cap lockstep — the client mirror truncates and counts against the SAME
//    numbers as the server. A client cap larger than the server's renders a
//    counter that says "fine" for text the route rejects; a client MAX_BLOCK
//    larger than the server's makes the Shift-drop paste and the dispatched
//    prompt disagree about where the block ends.

/** Extract a numeric `const NAME = 1234` (TS `export const` or JS `const`). */
function extractNumber(src, name, fileLabel) {
    const m = src.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
    assert.ok(m, `${name} literal not found in ${fileLabel}`);
    return Number(m[1]);
}

for (const capName of ['MAX_BLOCK_CHARS', 'MAX_INSTRUCTION_CHARS']) {
    test(`${capName} matches across standingOrders.ts and terminals.js`, () => {
        const tsVal = extractNumber(STANDING_ORDERS_SRC, capName, 'src/services/standingOrders.ts');
        const jsVal = extractNumber(TERMINALS_JS_SRC, capName, 'src/webview/terminals.js');
        assert.strictEqual(
            tsVal, jsVal,
            `${capName} mismatch: standingOrders.ts has ${tsVal} but terminals.js has ${jsVal}. ` +
            'A larger client cap makes the modal counter lie about what the route accepts; ' +
            'a larger client block cap makes Shift-drop and dispatch truncate at different points.'
        );
    });
}

// 6. Delivery-site coverage — the enumerable guarantee that replaces
//    "remember to hook all the sites". Both hosts have exactly ONE chokepoint;
//    a new bare call site is how this feature silently half-ships.

/** Blank out `//` and block comments so prose mentions do not count as code. */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const BOOTSTRAP_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'standalone', 'bootstrap.ts'), 'utf8'
);
const TASKVIEWER_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts'), 'utf8'
);

test('bootstrap.ts calls sendPromptToPty ONLY inside the deliverPrompt wrapper', () => {
    const code = stripComments(BOOTSTRAP_SRC);
    const calls = [...code.matchAll(/sendPromptToPty\s*\(/g)].map(m => m.index);
    assert.strictEqual(
        calls.length, 1,
        `Expected exactly 1 sendPromptToPty(...) call in bootstrap.ts, found ${calls.length}. ` +
        'Every standalone delivery must route through deliverPrompt, or that path silently ' +
        'drops the standing-orders block (the standalone board dispatch is the classic miss).'
    );
    const wrapperStart = code.indexOf('const deliverPrompt');
    assert.ok(wrapperStart >= 0, 'deliverPrompt wrapper not found in bootstrap.ts');
    // The wrapper is the first arrow function after that declaration; the single
    // call must live after it and before the next top-level `const secrets =`.
    const wrapperEnd = code.indexOf('const secrets', wrapperStart);
    assert.ok(wrapperEnd > wrapperStart, 'could not bound the deliverPrompt wrapper');
    assert.ok(
        calls[0] > wrapperStart && calls[0] < wrapperEnd,
        'The sole sendPromptToPty call is outside the deliverPrompt wrapper body.'
    );
});

test('TaskViewerProvider routes every /api/pty/ request through _ptyHostVerb', () => {
    const code = stripComments(TASKVIEWER_SRC);
    const hookStart = code.indexOf('private async _ptyHostVerb(');
    assert.ok(hookStart >= 0, '_ptyHostVerb not found in TaskViewerProvider.ts');
    // End of the method = the next member declaration at class-body indentation.
    const after = code.slice(hookStart + 1);
    const relEnd = after.search(/\n {4}(?:private|public|protected)\s/);
    const hookEnd = relEnd === -1 ? code.length : hookStart + 1 + relEnd;

    const requests = [...code.matchAll(/\/api\/pty\//g)].map(m => m.index);
    assert.ok(requests.length >= 2, 'expected the two /api/pty/ request builders');
    for (const idx of requests) {
        assert.ok(
            idx > hookStart && idx < hookEnd,
            'An /api/pty/ request is built outside _ptyHostVerb. That bypasses the ' +
            'standing-orders append hook, so the delivery it performs ships bare.'
        );
    }
});

test('the two pty-verb chokepoints carry a standingOrders opt-out guard', () => {
    assert.ok(
        /standingOrders !== false/.test(TASKVIEWER_SRC),
        'TaskViewerProvider._ptyHostVerb must gate the append on payload.standingOrders !== false'
    );
    assert.ok(
        /standingOrders !== false/.test(BOOTSTRAP_SRC),
        'bootstrap.ts ptySendPrompt must pass payload.standingOrders !== false to deliverPrompt'
    );
});

// 7. Resolver behaviour — the module is transpiled and executed, so these are
//    real assertions about output, not source scans.

const tsc = require('typescript');
const resolverModule = { exports: {} };
new Function('exports', 'module', 'require', tsc.transpileModule(STANDING_ORDERS_SRC, {
    compilerOptions: { module: tsc.ModuleKind.CommonJS, target: tsc.ScriptTarget.ES2020 }
}).outputText)(resolverModule.exports, resolverModule, require);

const { applyStandingOrders, validateInstruction, STANDING_ORDERS_MARKER, MAX_BLOCK_CHARS, MAX_INSTRUCTION_CHARS } = resolverModule.exports;

const order = (parent, child, instruction) => ({ id: `${parent}->${child}`, parent, child, instruction, createdAt: 0 });
const LIVE = new Set(['child-1', 'child-2']);

test('applyStandingOrders: empty prompt is returned unchanged', () => {
    assert.strictEqual(applyStandingOrders('', 'p', [order('p', 'child-1', 'x')], LIVE), '');
});

test('applyStandingOrders: a prompt already carrying the marker is not re-blocked', () => {
    const already = `task\n\n${STANDING_ORDERS_MARKER}\n- Regarding terminal "child-1": x\n`;
    assert.strictEqual(applyStandingOrders(already, 'p', [order('p', 'child-1', 'x')], LIVE), already);
});

test('applyStandingOrders: no order for this parent leaves the prompt bare', () => {
    assert.strictEqual(applyStandingOrders('task', 'other', [order('p', 'child-1', 'x')], LIVE), 'task');
});

test('applyStandingOrders: an order whose child is dead is skipped, not deleted', () => {
    assert.strictEqual(applyStandingOrders('task', 'p', [order('p', 'ghost', 'x')], LIVE), 'task');
});

test('applyStandingOrders: multiple orders render in creation order under one header', () => {
    const out = applyStandingOrders('task', 'p', [
        order('p', 'child-1', 'first'),
        order('p', 'child-2', 'second'),
    ], LIVE);
    assert.strictEqual((out.match(new RegExp(STANDING_ORDERS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1,
        'exactly one marker block');
    assert.ok(out.indexOf('first') < out.indexOf('second'), 'orders must render in creation order');
    assert.ok(out.startsWith('task'), 'the original prompt must be preserved verbatim at the head');
});

test('applyStandingOrders: an over-cap block truncates with a visible notice', () => {
    const long = 'y'.repeat(MAX_INSTRUCTION_CHARS);
    const out = applyStandingOrders('task', 'p', [
        order('p', 'child-1', long),
        order('p', 'child-2', long),
        order('p', 'child-1', long),
    ], LIVE);
    const block = out.slice('task'.length);
    assert.ok(block.includes('[standing orders truncated]'), 'truncation must announce itself');
    assert.ok(block.length <= MAX_BLOCK_CHARS + 40, `block grew to ${block.length}, cap is ${MAX_BLOCK_CHARS}`);
});

test('validateInstruction: empty, over-length and marker-bearing text are rejected; normal text passes', () => {
    assert.ok(validateInstruction(''), 'empty must be rejected');
    assert.ok(validateInstruction('   '), 'whitespace-only must be rejected');
    assert.ok(validateInstruction(undefined), 'non-string must be rejected');
    assert.ok(validateInstruction('z'.repeat(MAX_INSTRUCTION_CHARS + 1)), 'over-length must be rejected');
    assert.ok(validateInstruction(`hi ${STANDING_ORDERS_MARKER} there`), 'marker forgery must be rejected');
    assert.strictEqual(validateInstruction('be the researcher for terminal 2'), null);
});

// Summary

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
