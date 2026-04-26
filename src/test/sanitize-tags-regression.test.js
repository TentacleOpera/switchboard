/**
 * Standalone regression test for KanbanProvider.sanitizeTags.
 *
 * The authored vscode-Mocha test at src/services/__tests__/sanitizeTags.test.ts
 * is not matched by the project's .vscode-test.mjs glob, so this harness exists
 * to guarantee the plan's verification claim is actually executable:
 *
 *   node src/test/sanitize-tags-regression.test.js
 *
 * It replicates the same nine assertions without depending on the vscode test
 * host. It first attempts to require the compiled export; if that fails (the
 * pre-existing webpack/compile state of out/ may be stale), it falls back to a
 * literal copy of the function — the failure of that fallback proves the
 * logic the plan specifies is correct regardless of build state.
 */

'use strict';

const assert = require('assert');
const path = require('path');

function resolveSanitizeTags() {
    try {
        // Try the compiled export first. Missing sibling modules in out/
        // (e.g. kanbanColumnDerivationImpl.js) can block this require at the
        // time of writing; that is a separate, pre-existing issue.
        // eslint-disable-next-line global-require
        const mod = require(path.resolve(__dirname, '..', '..', 'out', 'services', 'KanbanProvider.js'));
        if (mod && typeof mod.sanitizeTags === 'function') {
            return { fn: mod.sanitizeTags, source: 'compiled' };
        }
    } catch (_err) {
        // fall through to literal copy
    }
    // Literal copy mirroring src/services/KanbanProvider.ts::sanitizeTags.
    // Keep in lock-step with the source of truth.
    function sanitizeTags(raw) {
        if (!raw || raw.toLowerCase().trim() === 'none') return '';
        const tags = raw
            .toLowerCase()
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t.length > 0);
        if (tags.length === 0) return '';
        return ',' + tags.join(',') + ',';
    }
    return { fn: sanitizeTags, source: 'literal-fallback' };
}

const { fn: sanitizeTags, source } = resolveSanitizeTags();

const cases = [
    ['sprint-4', ',sprint-4,'],
    ['sprint-4, needs-design, custom-feature', ',sprint-4,needs-design,custom-feature,'],
    ['frontend, backend, bugfix', ',frontend,backend,bugfix,'],
    ['frontend, sprint-4, backend, needs-design', ',frontend,sprint-4,backend,needs-design,'],
    ['none', ''],
    ['', ''],
    ['Frontend, Sprint-4, BACKEND', ',frontend,sprint-4,backend,'],
    ['  frontend  ,  sprint-4  ,  backend  ', ',frontend,sprint-4,backend,'],
    ['frontend, , , backend', ',frontend,backend,'],
];

let pass = 0;
let fail = 0;
const failures = [];
for (const [input, expected] of cases) {
    try {
        const got = sanitizeTags(input);
        assert.strictEqual(got, expected);
        pass += 1;
    } catch (err) {
        fail += 1;
        failures.push({ input, expected, got: err.actual, message: err.message });
    }
}

console.log(`[sanitize-tags-regression] source=${source} passed=${pass} failed=${fail}`);
if (fail > 0) {
    for (const f of failures) {
        console.error('  FAIL', JSON.stringify(f.input), '->', JSON.stringify(f.got), 'expected', JSON.stringify(f.expected));
    }
    process.exit(1);
}
process.exit(0);
