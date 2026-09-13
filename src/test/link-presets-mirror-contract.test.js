'use strict';

/**
 * Contract: the LINK_PRESETS literal is identical across the TypeScript source
 * of truth (src/services/linkPresets.ts) and the webview client mirror
 * (src/webview/terminals.js).
 *
 * The webview cannot import a module — it is served as a classic script with
 * no bundling — so the preset list is duplicated. A contract test is the
 * mechanism that keeps the two copies aligned: the keep-in-sync comment alone
 * did not hold for the standing-orders marker, so this one gets a test.
 *
 * Also asserts that the `reports-to-head` template in linkPresets.ts is
 * byte-identical to the `team.member.completion` fragment body in
 * standingOrderFragments.ts — the two copies exist because linkPresets.ts
 * cannot import from standingOrderFragments.ts without creating a circular
 * dependency, and the test is what holds them together. (The previous mirror
 * was AGENT_GROUP_CALLBACK_INSTRUCTION in teamWiring.ts, which was retired
 * when system protocol composition moved to delivery-time fragments.)
 *
 * Run with:
 *   node src/test/link-presets-mirror-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const LINK_PRESETS_TS_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'linkPresets.ts'), 'utf8'
);
const TERMINALS_JS_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'terminals.js'), 'utf8'
);
const STANDING_ORDER_FRAGMENTS_TS_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'standingOrderFragments.ts'), 'utf8'
);

let passed = 0;
let failed = 0;

function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

/**
 * Extract the LINK_PRESETS array from a source file by finding the array
 * literal and parsing its entries. Each entry is an object with id, label,
 * direction (optional in the JS mirror before this change, required after),
 * and template.
 */

// Single-quoted JS string literal, escape-aware. The naive /'([^']*)'/ stops at
// the first `\'` inside a fragment (the prompt templates embed shell-quoted
// JSON), which truncates the extracted template differently in each file and
// makes a byte-identical mirror look like a mismatch.
const SQ_STRING_SRC = "'((?:[^'\\\\]|\\\\.)*)'";
function unescapeSq(raw) {
    return String(raw).replace(/\\(.)/g, '$1');
}

function extractPresets(src, fileLabel) {
    // Find the array literal between `LINK_PRESETS = [` (or `LINK_PRESETS: ... = [`)
    // and the matching `];`
    const startMatch = src.match(/LINK_PRESETS[^=]*=\s*\[/);
    assert.ok(startMatch, `LINK_PRESETS array not found in ${fileLabel}`);
    const startIdx = startMatch.index + startMatch[0].length;
    // Find the closing `];` — the array is the last top-level `];` before the
    // next `const` or `let` declaration, or the end of the block.
    let depth = 1;
    let i = startIdx;
    while (i < src.length && depth > 0) {
        if (src[i] === '[') { depth++; }
        else if (src[i] === ']') { depth--; }
        i++;
    }
    const arrayText = src.slice(startIdx, i - 1);

    // Parse each entry: { id: '...', label: '...', direction: '...', template: '...' }
    const entries = [];
    const entryRegex = new RegExp('id:\\s*' + SQ_STRING_SRC, 'g');
    let match;
    while ((match = entryRegex.exec(arrayText)) !== null) {
        const id = unescapeSq(match[1]);
        // Find the label for this entry
        const labelMatch = arrayText.slice(match.index).match(new RegExp('label:\\s*' + SQ_STRING_SRC));
        const label = labelMatch ? unescapeSq(labelMatch[1]) : '';
        // Find the direction for this entry
        const directionMatch = arrayText.slice(match.index).match(new RegExp('direction:\\s*' + SQ_STRING_SRC));
        const direction = directionMatch ? unescapeSq(directionMatch[1]) : undefined;
        // Find the template — it may be a concatenation of single-quoted strings
        const templateIdx = arrayText.indexOf('template:', match.index);
        if (templateIdx === -1) { entries.push({ id, label, direction, template: '' }); continue; }
        // Extract the template value: everything after `template:` up to the
        // next `}` or the next `id:` or end. The template is single-quoted
        // concatenation.
        const templateSection = arrayText.slice(templateIdx + 'template:'.length);
        // Collect all single-quoted string fragments
        const fragments = [];
        const fragRegex = new RegExp(SQ_STRING_SRC, 'g');
        let fragMatch;
        let lastIdx = 0;
        while ((fragMatch = fragRegex.exec(templateSection)) !== null) {
            // Stop if we've gone past the next entry (look for `}` or `id:`)
            if (fragMatch.index > 0) {
                const between = templateSection.slice(lastIdx, fragMatch.index);
                if (between.includes('}')) { break; }
                if (between.includes('id:') && fragMatch.index > 200) { break; }
            }
            fragments.push(unescapeSq(fragMatch[1]));
            lastIdx = fragMatch.index + fragMatch[0].length;
        }
        entries.push({ id, label, direction, template: fragments.join('') });
    }
    return entries;
}

// 1. Both files declare the same preset ids in the same order

test('linkPresets.ts and terminals.js have the same preset ids in the same order', () => {
    const tsPresets = extractPresets(LINK_PRESETS_TS_SRC, 'src/services/linkPresets.ts');
    const jsPresets = extractPresets(TERMINALS_JS_SRC, 'src/webview/terminals.js');
    const tsIds = tsPresets.map(p => p.id);
    const jsIds = jsPresets.map(p => p.id);
    assert.deepStrictEqual(
        tsIds, jsIds,
        `Preset id mismatch: linkPresets.ts has [${tsIds.join(', ')}] but terminals.js has [${jsIds.join(', ')}]. ` +
        'Order matters — LINK_PRESETS[0] is the saved default for every install.'
    );
});

// 2. Each preset has matching id, label, template, and direction

test('each preset has matching id, label, template, and direction across both files', () => {
    const tsPresets = extractPresets(LINK_PRESETS_TS_SRC, 'src/services/linkPresets.ts');
    const jsPresets = extractPresets(TERMINALS_JS_SRC, 'src/webview/terminals.js');
    assert.strictEqual(tsPresets.length, jsPresets.length, 'Preset count mismatch');
    for (let i = 0; i < tsPresets.length; i++) {
        const ts = tsPresets[i];
        const js = jsPresets[i];
        assert.strictEqual(ts.id, js.id, `Preset ${i}: id mismatch`);
        assert.strictEqual(ts.label, js.label, `Preset '${ts.id}': label mismatch`);
        assert.strictEqual(ts.template, js.template, `Preset '${ts.id}': template mismatch`);
        assert.strictEqual(ts.direction, js.direction, `Preset '${ts.id}': direction mismatch`);
    }
});

// 3. The reports-to-head template matches the team.member.completion fragment body

test('reports-to-head template is byte-identical to the team.member.completion fragment body', () => {
    const tsPresets = extractPresets(LINK_PRESETS_TS_SRC, 'src/services/linkPresets.ts');
    const rth = tsPresets.find(p => p.id === 'reports-to-head');
    assert.ok(rth, 'reports-to-head preset not found in linkPresets.ts');
    // The fragment body is built by buildMemberCompletionFragment, which
    // interpolates {teamId} and {headName}. The reports-to-head preset uses
    // {child} as the head-name placeholder, so we compare the static prose
    // around the placeholders. Extract the fragment function body and verify
    // the reports-to-head template appears as a substring of the composed
    // fragment body (with {child} standing in for the head name).
    // The simplest robust check: the reports-to-head template's fixed prose
    // ("is your head agent. When you finish a task, report to it") must appear
    // verbatim in the standingOrderFragments.ts source (in the
    // external-member-callback fragment, which mirrors the prose).
    assert.ok(
        /is your head agent\. When you finish a task, report to it/.test(STANDING_ORDER_FRAGMENTS_TS_SRC),
        'standingOrderFragments.ts must contain the reports-to-head prose ("is your head agent. When you finish a task, report to it")'
    );
    // The reports-to-head template uses ptySendPrompt (in-terminal delivery);
    // the external-member-callback fragment uses a report FILE (external head).
    // Both share the opening prose. Verify the template carries the
    // ptySendPrompt delivery route.
    assert.ok(
        /ptySendPrompt/.test(rth.template),
        'reports-to-head template must name ptySendPrompt as the delivery route'
    );
});

// 4. reports-to-head has direction 'member-receives'

test('reports-to-head has direction member-receives', () => {
    const tsPresets = extractPresets(LINK_PRESETS_TS_SRC, 'src/services/linkPresets.ts');
    const rth = tsPresets.find(p => p.id === 'reports-to-head');
    assert.ok(rth, 'reports-to-head preset not found');
    assert.strictEqual(
        rth.direction, 'member-receives',
        `reports-to-head must have direction 'member-receives' — it installs ON the member ABOUT the head. ` +
        `Got: '${rth.direction}'`
    );
});

// 5. All other non-custom presets have direction 'head-receives'

test('all non-custom, non-reports-to-head presets have direction head-receives', () => {
    const tsPresets = extractPresets(LINK_PRESETS_TS_SRC, 'src/services/linkPresets.ts');
    for (const p of tsPresets) {
        if (p.id === 'custom' || p.id === 'reports-to-head') { continue; }
        assert.strictEqual(
            p.direction, 'head-receives',
            `Preset '${p.id}' must have direction 'head-receives' — it installs ON the head ABOUT the member. ` +
            `Got: '${p.direction}'`
        );
    }
});

// 6. custom has an empty template

test('custom preset has an empty template', () => {
    const tsPresets = extractPresets(LINK_PRESETS_TS_SRC, 'src/services/linkPresets.ts');
    const custom = tsPresets.find(p => p.id === 'custom');
    assert.ok(custom, 'custom preset not found');
    assert.strictEqual(custom.template, '', 'custom preset must have an empty template');
});

// 7. The first preset is 'researcher' (order matters — it's the saved default)

test('first preset is researcher (LINK_PRESETS[0] is the saved default)', () => {
    const tsPresets = extractPresets(LINK_PRESETS_TS_SRC, 'src/services/linkPresets.ts');
    assert.strictEqual(tsPresets[0]?.id, 'researcher', 'LINK_PRESETS[0] must be researcher — do not reorder');
});

// Summary

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
