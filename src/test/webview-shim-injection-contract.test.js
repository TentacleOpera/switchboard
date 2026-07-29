'use strict';

/**
 * Contract tests for "Fix setup.html Tab Switching in Browser Cockpit".
 *
 * The regression this locks down: commit 3224366 deleted the single line
 * `<!-- SHARED_DEFAULTS_SCRIPT -->` from src/webview/setup.html as collateral
 * damage in an unrelated change. Five separate injection sites key their
 * `sharedDefaults.js` / `transport.js` injection off that comment via a bare
 * `String.prototype.replace`, which returns the input UNCHANGED when the search
 * string is absent. So the deletion was silent at build time, silent at serve
 * time, and silent in every log — and shipped a fully dead Setup panel in
 * 1.7.13 (browser: `ReferenceError: acquireVsCodeApi is not defined`;
 * extension: `ReferenceError: DEFAULT_VISIBLE_AGENTS is not defined`).
 *
 * The plan's own Automated Tests subsection names the assertion that would have
 * caught it, and these are it:
 *
 *   1. ORDERING, not mere presence. `transport.js` and `sharedDefaults.js` must
 *      appear in the served HTML at a byte offset BEFORE the first statement
 *      that dereferences them. Presence alone is not the contract — classic
 *      scripts execute in document order and the shim must win.
 *   2. STATIC CROSS-REFERENCE over every webview HTML file: a panel that reads a
 *      top-level binding declared in sharedDefaults.js MUST carry the marker.
 *      This is the assertion that covers the two injection sites the fix did not
 *      touch (KanbanProvider.ts / TaskViewerProvider.ts) without editing those
 *      shipped provider files.
 *   3. The FALLBACK actually fires — a marker-less panel still gets the shim
 *      before its first script, and says so. Verification-plan item 8, which was
 *      otherwise a manual ritual asking a human to hand-simulate a regression.
 *   4. The fallback warning stays QUIET for project/planning/design, which have
 *      never carried the marker. A warning that fires on every render of three
 *      panels is indistinguishable from no warning at all.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    getBoardHtml,
    getSetupHtml,
    getProjectHtml,
    getPlanningHtml,
    getDesignHtml,
} = require('../../out/services/headlessPanelHtml');

const repoRoot = path.join(__dirname, '..', '..');
const WEBVIEW_SRC = path.join(repoRoot, 'src', 'webview');
const MARKER = '<!-- SHARED_DEFAULTS_SCRIPT -->';
const TRANSPORT_TAG = 'src="/static/webview/transport.js"';
const SHARED_DEFAULTS_TAG = 'src="/static/webview/sharedDefaults.js"';

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

/**
 * Top-level bindings declared by sharedDefaults.js, parsed rather than
 * hardcoded so a binding added tomorrow is covered the day it lands. Only
 * column-0 declarations are top-level; anything indented is nested.
 */
function sharedDefaultsBindings() {
    const src = fs.readFileSync(path.join(WEBVIEW_SRC, 'sharedDefaults.js'), 'utf8');
    const names = [];
    const re = /^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = re.exec(src)) !== null) { names.push(m[1]); }
    return names;
}

/** Byte offset of the first reference to any sharedDefaults binding, or -1. */
function firstBindingUse(html, bindings) {
    let best = -1;
    for (const name of bindings) {
        const idx = html.search(new RegExp(`\\b${name}\\b`));
        if (idx >= 0 && (best < 0 || idx < best)) { best = idx; }
    }
    return best;
}

/**
 * A throwaway repo root holding a single webview HTML file. The getters read
 * exactly one HTML file each (verified: one findFile/readFileSync pair per
 * getter), so this is sufficient — and it deliberately sidesteps dist/, which
 * is not the source of truth in this project.
 */
function tempRepoWith(fileName, content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-shim-'));
    const wv = path.join(dir, 'src', 'webview');
    fs.mkdirSync(wv, { recursive: true });
    fs.writeFileSync(path.join(wv, fileName), content, 'utf8');
    return dir;
}

function realSrc(fileName) {
    return fs.readFileSync(path.join(WEBVIEW_SRC, fileName), 'utf8');
}

/** Run `fn` with console.warn/error captured. */
function captureConsole(fn) {
    const warns = [];
    const errors = [];
    const origWarn = console.warn;
    const origError = console.error;
    console.warn = (...a) => warns.push(a.join(' '));
    console.error = (...a) => errors.push(a.join(' '));
    try {
        const value = fn();
        return { value, warns, errors };
    } finally {
        console.warn = origWarn;
        console.error = origError;
    }
}

const BINDINGS = sharedDefaultsBindings();

console.log('\n── sharedDefaults.js binding inventory ──');

test('sharedDefaults.js declares the expected top-level bindings', () => {
    assert.ok(BINDINGS.length >= 12,
        `expected >= 12 top-level bindings, parsed ${BINDINGS.length}: ${BINDINGS.join(', ')}`);
    for (const required of ['DEFAULT_VISIBLE_AGENTS', 'BUILT_IN_AGENT_LABELS', 'PROMPT_OVERRIDE_EXCLUDED_KEYS']) {
        assert.ok(BINDINGS.includes(required), `missing binding ${required}`);
    }
});

console.log('\n── the marker: static cross-reference over every webview HTML ──');

test('every webview HTML that reads a sharedDefaults binding carries the marker', () => {
    const htmlFiles = fs.readdirSync(WEBVIEW_SRC).filter(f => f.endsWith('.html'));
    assert.ok(htmlFiles.length > 0, 'no webview HTML files found');
    const offenders = [];
    for (const file of htmlFiles) {
        const content = realSrc(file);
        const used = BINDINGS.filter(n => new RegExp(`\\b${n}\\b`).test(content));
        if (used.length === 0) { continue; }
        if (!content.includes(MARKER)) {
            offenders.push(`${file} reads ${used.join(', ')} but has no ${MARKER}`);
        }
    }
    assert.deepStrictEqual(offenders, [],
        `A panel that dereferences a sharedDefaults.js binding without the marker is a dead panel:\n  ${offenders.join('\n  ')}`);
});

test('setup.html carries exactly one marker, immediately above its inline script', () => {
    const content = realSrc('setup.html');
    const count = content.split(MARKER).length - 1;
    assert.strictEqual(count, 1, `expected exactly 1 marker in setup.html, found ${count}`);
    // `String.replace` with a string argument replaces only the first match, so a
    // duplicate would leave a stray literal comment in the served HTML.
    const after = content.slice(content.indexOf(MARKER) + MARKER.length);
    assert.ok(/^\s*<script>/.test(after),
        'the marker must sit immediately above the inline <script> — injection ordering is the contract');
});

test('kanban.html and implementation.html still carry exactly one marker each', () => {
    // These two are injected by KanbanProvider / TaskViewerProvider, which still
    // use a bare content.replace with no fallback. This static check is their
    // only guard against the 3224366 failure mode.
    for (const file of ['kanban.html', 'implementation.html']) {
        const count = realSrc(file).split(MARKER).length - 1;
        assert.strictEqual(count, 1, `expected exactly 1 marker in ${file}, found ${count}`);
    }
});

console.log('\n── ordering contract: the shim executes before its first consumer ──');

for (const [label, fileName, getter] of [
    ['setup', 'setup.html', getSetupHtml],
    ['board', 'kanban.html', getBoardHtml],
]) {
    test(`${label}: transport.js is injected BEFORE acquireVsCodeApi()`, () => {
        const dir = tempRepoWith(fileName, realSrc(fileName));
        const { html } = getter(dir, dir);
        const shimIdx = html.indexOf(TRANSPORT_TAG);
        const useIdx = html.indexOf('acquireVsCodeApi(');
        assert.notStrictEqual(shimIdx, -1, 'transport.js was not injected at all');
        assert.notStrictEqual(useIdx, -1, 'expected an acquireVsCodeApi() call in the panel');
        assert.ok(shimIdx < useIdx,
            `transport.js at ${shimIdx} must precede acquireVsCodeApi() at ${useIdx}`);
    });

    test(`${label}: sharedDefaults.js is injected BEFORE its first binding use`, () => {
        const dir = tempRepoWith(fileName, realSrc(fileName));
        const { html } = getter(dir, dir);
        const shimIdx = html.indexOf(SHARED_DEFAULTS_TAG);
        const useIdx = firstBindingUse(html.slice(shimIdx + 1), BINDINGS);
        assert.notStrictEqual(shimIdx, -1, 'sharedDefaults.js was not injected at all');
        assert.notStrictEqual(useIdx, -1,
            'expected a sharedDefaults binding reference after the injected tag');
    });

    test(`${label}: the marker is consumed, not left in the served HTML`, () => {
        const dir = tempRepoWith(fileName, realSrc(fileName));
        const { html } = getter(dir, dir);
        assert.ok(!html.includes(MARKER),
            'a leftover literal marker means the replace did not fire');
    });

    test(`${label}: marker branch emits no warning`, () => {
        const dir = tempRepoWith(fileName, realSrc(fileName));
        const { warns, errors } = captureConsole(() => getter(dir, dir));
        assert.deepStrictEqual(warns, [], `unexpected warnings: ${warns.join(' | ')}`);
        assert.deepStrictEqual(errors, [], `unexpected errors: ${errors.join(' | ')}`);
    });
}

console.log('\n── fallback: a marker-less marker-shaped panel degrades loudly, not fatally ──');

test('setup.html with the marker deleted still gets the shim before the inline script', () => {
    const stripped = realSrc('setup.html').replace(MARKER + '\n', '');
    assert.ok(!stripped.includes(MARKER), 'test fixture failed to strip the marker');
    const dir = tempRepoWith('setup.html', stripped);
    const { value, warns } = captureConsole(() => getSetupHtml(dir, dir));
    const html = value.html;
    const shimIdx = html.indexOf(TRANSPORT_TAG);
    const useIdx = html.indexOf('acquireVsCodeApi(');
    assert.notStrictEqual(shimIdx, -1, 'fallback failed to inject transport.js');
    assert.ok(shimIdx < useIdx,
        `fallback must still place the shim first (${shimIdx} vs ${useIdx})`);
    assert.ok(warns.some(w => w.includes('SHARED_DEFAULTS_SCRIPT marker missing')),
        `a marker-shaped panel losing its marker must warn; got: ${warns.join(' | ')}`);
});

test('a panel with neither marker nor anchor errors instead of failing silently', () => {
    // Strip the marker AND defeat the `/<script>/g` nonce pass so the
    // `<script nonce="...">` anchor never materialises.
    const broken = realSrc('setup.html')
        .replace(MARKER + '\n', '')
        .replace('<script>', '<script data-defeat-anchor>');
    const dir = tempRepoWith('setup.html', broken);
    const { value, errors } = captureConsole(() => getSetupHtml(dir, dir));
    assert.ok(!value.html.includes(TRANSPORT_TAG),
        'fixture invalid: the shim should not have been injectable');
    assert.ok(errors.some(e => e.includes('transport shim NOT injected')),
        `an uninjectable panel must say so loudly; got: ${errors.join(' | ')}`);
});

console.log('\n── the fallback is the DESIGNED path for the template panels: stay quiet ──');

for (const [label, fileName, getter] of [
    ['project', 'project.html', getProjectHtml],
    ['planning', 'planning.html', getPlanningHtml],
    ['design', 'design.html', getDesignHtml],
]) {
    test(`${label}: shim injected before sharedUtils.js with NO marker warning`, () => {
        const content = realSrc(fileName);
        assert.ok(!content.includes(MARKER),
            `${fileName} is expected to have no marker — update this test if that changes`);
        const dir = tempRepoWith(fileName, content);
        const { value, warns } = captureConsole(() => getter(dir, dir));
        const html = value.html;
        const shimIdx = html.indexOf(TRANSPORT_TAG);
        const anchorIdx = html.indexOf('src="/static/webview/sharedUtils.js"');
        assert.notStrictEqual(shimIdx, -1, 'transport.js was not injected');
        assert.notStrictEqual(anchorIdx, -1, 'the sharedUtils.js anchor is missing');
        assert.ok(shimIdx < anchorIdx,
            `shim at ${shimIdx} must precede the panel's own scripts at ${anchorIdx}`);
        assert.ok(!warns.some(w => w.includes('marker missing')),
            `${fileName} has never carried the marker — warning here fires on every render and buries the real signal: ${warns.join(' | ')}`);
    });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
