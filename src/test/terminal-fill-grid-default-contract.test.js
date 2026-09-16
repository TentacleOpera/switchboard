'use strict';

/**
 * Contract: the FILL GRID form opens on 2x2, not on the current layout.
 *
 * Source-text contract, not behavioural: the panel is a browser-only IIFE with
 * no export surface. What CAN be pinned is the decision that fixed the defect —
 * mirroring `currentLayout` pre-selected 2x3 (6 agents, 750px min width) for a
 * dense workflow, so the form opened on the most expensive grid the operator
 * happened to be viewing.
 *
 * Run with: node src/test/terminal-fill-grid-default-contract.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'webview', 'terminals.js'), 'utf8');

let failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

test('DEFAULT_FILL_GRID_MODE is a LAYOUTS key, so the option always exists', () => {
    const m = SRC.match(/const DEFAULT_FILL_GRID_MODE = '([^']+)';/);
    assert.ok(m, 'DEFAULT_FILL_GRID_MODE must be declared as a named constant');
    const layoutKeys = (SRC.match(/const LAYOUTS = \{([\s\S]*?)\n    \};/) || [])[1] || '';
    assert.ok(
        layoutKeys.includes(`'${m[1]}'`),
        `DEFAULT_FILL_GRID_MODE ('${m[1]}') must be a key of LAYOUTS — otherwise the select silently falls back to the first option ('1')`
    );
    assert.strictEqual(m[1], '2x2', 'the default must be 2x2 (4 panes, 500x300 min)');
});

test('fill-grid mode default is 2x2, not currentLayout', () => {
    // Find the line that sets the fill-grid mode default.
    const m = SRC.match(/fillGridMode\.value\s*=\s*([^;]+);/);
    assert.ok(m, 'fillGridMode.value assignment not found');
    const rhs = m[1].trim();
    assert.ok(
        rhs.includes('DEFAULT_FILL_GRID_MODE') || rhs.includes("'2x2'") || rhs.includes('"2x2"'),
        `fill-grid mode default should be 2x2, found: ${rhs}`
    );
    assert.ok(
        !rhs.includes('currentLayout'),
        `fill-grid mode default must not mirror currentLayout, found: ${rhs}`
    );
});

test('the options are populated before the default is assigned', () => {
    // The populate-block MUST remain above the value-assignment: assigning first
    // makes the browser drop the value (no matching <option> yet) and fall back
    // to the first option, '1' — a silent regression with no error anywhere.
    const populateIdx = SRC.indexOf('for (const mode of LAYOUT_MODES)');
    const assignIdx = SRC.indexOf('fillGridMode.value = DEFAULT_FILL_GRID_MODE;');
    assert.ok(populateIdx !== -1, 'the LAYOUT_MODES populate loop must exist');
    assert.ok(assignIdx !== -1, 'the default assignment must exist');
    assert.ok(
        populateIdx < assignIdx,
        'the <option> populate loop must run BEFORE fillGridMode.value is set'
    );
});

console.log(failed === 0 ? '\nAll fill-grid default contracts passed.' : `\n${failed} contract(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
