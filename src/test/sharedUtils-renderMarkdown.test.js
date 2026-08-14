'use strict';

// Contract test for src/webview/sharedUtils.js -> renderMarkdown.
//
// sharedUtils.js is a browser-global webview script (no module.exports; declares
// functions as globals; references document/window outside renderMarkdown).
// renderMarkdown itself uses only string operations and no DOM, so we load the
// script into a jsdom environment (so document/window exist) and assert against
// window.renderMarkdown.
//
// Run via: npm run test:contract:rendermarkdown

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

async function run() {
    console.log('\nRunning renderMarkdown list-rendering contract tests\n');

    const scriptPath = path.join(process.cwd(), 'src', 'webview', 'sharedUtils.js');
    const scriptSource = fs.readFileSync(scriptPath, 'utf8');

    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        runScripts: 'outside-only',
    });
    const { window } = dom;
    // Execute the webview script in the jsdom window context so its top-level
    // function declarations land on window.
    window.eval(scriptSource);

    const renderMarkdown = window.renderMarkdown;
    assert.strictEqual(typeof renderMarkdown, 'function', 'renderMarkdown should be exposed on the window');

    let passed = 0;
    const check = (name, md, predicate) => {
        const out = renderMarkdown(md);
        assert.ok(predicate(out), `${name} FAILED\ninput:\n${md}\noutput:\n${out}\n`);
        console.log(`  ok - ${name}`);
        passed++;
    };

    // Unordered lists: -, *, + all recognized.
    check('unordered dash', '- a\n- b\n- c', (h) =>
        h.includes('<ul>') && h.includes('<li>a</li>') && h.includes('<li>c</li>') && !h.includes('- a'));
    check('unordered star', '* a\n* b', (h) =>
        h.includes('<ul>') && h.includes('<li>a</li>') && h.includes('<li>b</li>'));
    check('unordered plus', '+ a\n+ b', (h) =>
        h.includes('<ul>') && h.includes('<li>a</li>') && h.includes('<li>b</li>'));

    // Ordered lists: 1. and 1) both recognized and wrapped in <ol>.
    check('ordered dot', '1. a\n2. b\n3. c', (h) =>
        h.includes('<ol>') && h.includes('<li>a</li>') && h.includes('<li>c</li>') && !h.includes('1. a'));
    check('ordered paren', '1) a\n2) b', (h) =>
        h.includes('<ol>') && h.includes('<li>a</li>') && h.includes('<li>b</li>'));

    // Nested lists (mixed ordered/unordered) produce correct nesting.
    check('nested mixed', '- a\n  1. b\n  2. c\n- d', (h) =>
        h.includes('<ul>') && h.includes('<ol>') &&
        h.includes('<li>a<ol><li>b</li><li>c</li></ol></li>') && h.includes('<li>d</li>'));
    check('deep nest 3 levels', '- a\n  - b\n    - c\n  - d\n- e', (h) =>
        h.includes('<ul><li>a<ul><li>b<ul><li>c</li></ul></li><li>d</li></ul></li><li>e</li></ul>'));

    // Adjacent different-type lists with no blank line -> two separate elements.
    check('adjacent diff type', '* a\n* b\n1. c\n2. d', (h) =>
        h.includes('</ul><ol>') && h.includes('<li>b</li>') && h.includes('<li>c</li>'));

    // Inline bold/code/link inside list items renders.
    check('inline bold in list', '- **bold** item', (h) =>
        h.includes('<li><strong>bold</strong> item</li>'));
    check('inline code in list', '- use `foo` here', (h) =>
        h.includes('<li>use <code>foo</code> here</li>'));
    check('inline link in list', '- see [docs](https://example.com)', (h) =>
        h.includes('<li>see <a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a></li>'));

    // Code fence containing a list-like line is NOT converted to a list.
    check('code fence not list', '```\n* foo\n- bar\n```', (h) =>
        h.includes('<pre><code>') && !h.includes('<ul>') && !h.includes('<li>'));

    // Thematic break (---) is not treated as a list item.
    check('thematic break not list', '---\n- real item', (h) =>
        !h.includes('<li>--</li>') && h.includes('<li>real item</li>'));

    // Loose list (blank lines between items) still produces a single <ul>.
    // The items AFTER a blank line now carry `md-li-loose` (the per-item looseness
    // marker), so the closing tag is asserted rather than the bare `<li>c</li>`
    // shape — the run is still ONE <ul>, which is what this case guards.
    check('loose list', '- a\n\n- b\n\n- c', (h) =>
        h.includes('<ul>') && (h.match(/<ul>/g) || []).length === 1 &&
        h.includes('<li>a</li>') && h.includes('>c</li>'));

    // ── Loose-list spacing (per-ITEM `md-li-loose`) ──
    // A blank line between bullets in the source is a deliberate sub-group break.
    // The marker is a per-item CLASS, never a <p> wrapper: `li p { margin-bottom: 0 }`
    // ships in every panel stylesheet and would silently cancel a <p>-based gap.

    // A tight list is byte-for-byte unchanged — no class anywhere.
    check('tight list carries no looseness marker', '- a\n- b\n- c', (h) =>
        !h.includes('md-li-loose'));

    // Only the item that FOLLOWS the blank line is loose; the first item never is.
    check('only the post-blank item is loose', '- a\n- b\n\n- c', (h) =>
        h.includes('<li>a</li>') && h.includes('<li>b</li>') &&
        h.includes('<li class="md-li-loose">c</li>') &&
        (h.match(/md-li-loose/g) || []).length === 1);

    // Two blank lines are the same single gap as one — `looseBefore` is a boolean.
    check('double blank is one gap, not two', '- a\n- b\n\n\n- c', (h) =>
        (h.match(/md-li-loose/g) || []).length === 1 && (h.match(/<ul>/g) || []).length === 1);

    // Ordered lists get the identical treatment.
    check('ordered list loose item', '1. a\n\n2. b', (h) =>
        h.includes('<ol>') && h.includes('<li>a</li>') &&
        h.includes('<li class="md-li-loose">b</li>'));

    // A blank line before a DEEPER item applies at that item's own level and must
    // not break the sentinel's single-line invariant (a \n inside the emitted list
    // HTML becomes a <br> at the \n -> <br> pass).
    check('nested loose item emits no <br>', '- a\n\n  - b', (h) =>
        h.includes('<ul><li>a<ul><li class="md-li-loose">b</li></ul></li></ul>') &&
        !h.includes('<br>'));

    // Sentinel single-line invariant, asserted on the rendered output: the list
    // element must contain no raw newline and no <br> between its tags.
    check('list html is a single line', '- a\n\n- b\n\n- c', (h) => {
        const start = h.indexOf('<ul>');
        const end = h.indexOf('</ul>') + '</ul>'.length;
        const listHtml = h.slice(start, end);
        return !listHtml.includes('\n') && !listHtml.includes('<br>');
    });

    // The <p>-wrapper trap: a future "make it CommonMark-correct" refactor that
    // emits <li><p>…</p></li> renders identically to today, because the existing
    // `li p { margin-bottom: 0 }` rule cancels it. Fail loudly if it reappears.
    check('no <p> inside <li>', '- a\n\n- b', (h) =>
        !/<li[^>]*><p>/.test(h));

    // List adjacent to a table does not produce stray <p> artifacts.
    check('list then table', '- a\n- b\n| H1 | H2 |\n| -- | -- |\n| x | y |', (h) =>
        h.includes('<ul>') && h.includes('<table>') && !h.includes('<p></p>'));
    check('table then list', '| H1 | H2 |\n| -- | -- |\n| x | y |\n- a\n- b', (h) =>
        h.includes('<table>') && h.includes('<ul>') && !h.includes('<p></p>'));

    // ── Editor round trip (src/webview/tickets.js) ──
    //
    // The renderer fix alone silently un-fixes itself: the tickets editor's
    // HTML -> markdown serialiser used to emit one \n per <li>, so a save flattened
    // a loose list to a tight one IN THE FILE — and push sends the local body as a
    // full replacement of the remote description, making that permanent.
    //
    // tickets.js is a browser-global IIFE that cannot be loaded wholesale here, so
    // the two serialiser functions are sliced out of the raw source by their
    // declarations and evaluated against the same jsdom window (they need only
    // `document`). A rename of either function fails loudly rather than silently
    // skipping the check.
    const ticketsSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'webview', 'tickets.js'), 'utf8');
    const serialiserStart = ticketsSource.indexOf('    function nodeToMarkdown(node) {');
    const serialiserEnd = ticketsSource.indexOf('    function flashCopyBtn(btn) {');
    assert.ok(
        serialiserStart !== -1 && serialiserEnd > serialiserStart,
        'could not slice nodeToMarkdown/htmlToMarkdown out of src/webview/tickets.js — ' +
        'were they renamed or moved? The round-trip contract below depends on them.'
    );
    window.eval(ticketsSource.slice(serialiserStart, serialiserEnd));
    const htmlToMarkdown = window.htmlToMarkdown;
    assert.strictEqual(typeof htmlToMarkdown, 'function', 'htmlToMarkdown should be exposed on the window');

    const roundTrip = (md) => htmlToMarkdown(renderMarkdown(md));
    const rtCheck = (name, md, predicate) => {
        const out = roundTrip(md);
        assert.ok(predicate(out), `${name} FAILED\ninput:\n${md}\nround-tripped:\n${out}\n`);
        console.log(`  ok - ${name}`);
        passed++;
    };

    // A loose boundary survives md -> render -> serialise. Bullet-marker
    // normalisation (`*   ` -> `- `) is pre-existing and acceptable; blank-line
    // loss is not.
    rtCheck('round trip preserves the loose boundary', '- a\n- b\n\n- c', (m) =>
        /- b\n\n- c/.test(m));
    // ...and a tight list round-trips with no blank lines introduced.
    rtCheck('round trip keeps a tight list tight', '- a\n- b\n- c', (m) =>
        m.includes('- a\n- b\n- c') && !/\n\n/.test(m));
    // htmlToMarkdown collapses /\n{3,}/ -> '\n\n', so the serialiser must emit
    // exactly one blank line — never three newlines that survive as a double gap.
    rtCheck('double blank collapses to one', '- a\n\n\n- b', (m) => !/\n\n\n/.test(m));

    console.log(`\n${passed} assertions passed.\n`);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
