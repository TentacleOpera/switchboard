'use strict';
/**
 * Contract: every browser-served panel styles its own scrollbars, the token its
 * thumb points at actually exists in that file, and the standard scrollbar
 * properties stay behind their @supports gate.
 *
 * Scrollbar CSS in this repo is per-panel inline CSS — there is no shared
 * stylesheet to inherit from (the one attempt, {{SHARED_TABS_CSS_URI}}, is dead
 * wiring) and CSS does not cross the shell's iframe boundary. A new panel route
 * that forgets the block ships light OS scrollbars on a black surface, which is
 * invisible to every other test.
 *
 * The gate assertion is the important one. In Chromium 121+ and Safari 17.4+, a
 * scroller that declares `scrollbar-width` or `scrollbar-color` has ALL of its
 * ::-webkit-scrollbar-* rules ignored. So a well-meaning future edit that hoists
 * `scrollbar-width: thin` to top level — a one-line "cross-browser improvement" —
 * silently deletes the 6px styling on every panel at once, with no error, no
 * warning, and no other test noticing.
 *
 * Reads src/, never dist/ — same reasoning as tempRepoWith() in
 * webview-shim-injection-contract.test.js: dist is a build artefact, and a stale
 * copy would make this test green against source that was never changed.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const WEBVIEW_SRC = path.join(repoRoot, 'src', 'webview');
const HTML_MODULE = path.join(repoRoot, 'src', 'services', 'headlessPanelHtml.ts');

/** Files this plan brings up to standard. The rest are a known, tracked gap. */
const PENDING = new Set(['kanban.html', 'planning.html', 'design.html']);

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

/** Browser-served panel HTML, parsed from the module that serves it. */
function browserServedHtmlFiles() {
    const src = fs.readFileSync(HTML_MODULE, 'utf8');
    const re = /path\.join\(repoRoot, 'src', 'webview', '([^']+\.html)'\)/g;
    const files = new Set();
    let m;
    while ((m = re.exec(src)) !== null) { files.add(m[1]); }
    return [...files];
}

/** Innermost custom property in a `var(--a, var(--b))` chain. */
function innermostToken(decl) {
    const all = [...decl.matchAll(/var\(\s*(--[\w-]+)/g)].map(x => x[1]);
    return all.length ? all[all.length - 1] : null;
}

/** Strip every `@supports not selector(::-webkit-scrollbar) { … }` block (brace-matched). */
function withoutWebkitGate(css) {
    const OPEN = /@supports\s+not\s+selector\(\s*::-webkit-scrollbar\s*\)\s*\{/g;
    let out = css, m;
    while ((m = OPEN.exec(out)) !== null) {
        let i = m.index + m[0].length, depth = 1;
        while (i < out.length && depth > 0) {
            if (out[i] === '{') { depth++; }
            else if (out[i] === '}') { depth--; }
            i++;
        }
        out = out.slice(0, m.index) + out.slice(i);
        OPEN.lastIndex = 0;
    }
    return out;
}

const FILES = browserServedHtmlFiles();

test('the panel list parsed from headlessPanelHtml.ts is plausible', () => {
    assert.ok(FILES.length >= 7, `expected >= 7 browser-served HTML files, parsed ${FILES.length}: ${FILES.join(', ')}`);
    assert.ok(!FILES.includes('implementation.html'), 'implementation.html has no browser route — the parse is picking up the wrong thing');
});

for (const file of FILES) {
    const content = fs.readFileSync(path.join(WEBVIEW_SRC, file), 'utf8');

    test(`${file}: exactly one bare ::-webkit-scrollbar rule`, () => {
        const count = (content.match(/^\s*::-webkit-scrollbar\s*\{/gm) || []).length;
        assert.strictEqual(count, 1, `expected exactly 1 (a second block makes the next edit ambiguous), found ${count}`);
    });

    test(`${file}: the thumb's fallback token is defined in this file`, () => {
        const m = content.match(/^\s*::-webkit-scrollbar-thumb\s*\{([^}]*)\}/m);
        assert.ok(m, 'no bare ::-webkit-scrollbar-thumb rule');
        const token = innermostToken(m[1]);
        assert.ok(token, `thumb background declares no var(): ${m[1].trim()}`);
        assert.ok(new RegExp(`${token}\\s*:`).test(content),
            `thumb falls back to ${token}, which this file never defines — the thumb renders transparent, i.e. an invisible scrollbar`);
    });

    test(`${file}: no standard scrollbar property outside the @supports gate`, () => {
        const ungated = withoutWebkitGate(content);
        const leaks = (ungated.match(/scrollbar-(?:width|color)\s*:/g) || []);
        assert.deepStrictEqual(leaks, [],
            'scrollbar-width/scrollbar-color at top level makes Chromium 121+ and Safari 17.4+ ignore EVERY ' +
            '::-webkit-scrollbar rule on that scroller — it silently deletes the 6px styling. Keep them inside ' +
            '@supports not selector(::-webkit-scrollbar).');
    });

    if (!PENDING.has(file)) {
        test(`${file}: declares color-scheme: dark`, () => {
            assert.match(content, /color-scheme:\s*dark/,
                'without it a plain browser paints the light native scrollbar and form-control palette on a black panel');
        });

        test(`${file}: carries the Firefox @supports block`, () => {
            assert.match(content, /@supports\s+not\s+selector\(\s*::-webkit-scrollbar\s*\)/,
                'Gecko ignores ::-webkit-scrollbar entirely and needs the standard properties');
        });
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
