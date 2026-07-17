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
        h.includes('<li>see <a href="https://example.com">docs</a></li>'));

    // Code fence containing a list-like line is NOT converted to a list.
    check('code fence not list', '```\n* foo\n- bar\n```', (h) =>
        h.includes('<pre><code>') && !h.includes('<ul>') && !h.includes('<li>'));

    // Thematic break (---) is not treated as a list item.
    check('thematic break not list', '---\n- real item', (h) =>
        !h.includes('<li>--</li>') && h.includes('<li>real item</li>'));

    // Loose list (blank lines between items) still produces a single <ul>.
    check('loose list', '- a\n\n- b\n\n- c', (h) =>
        h.includes('<ul>') && h.includes('<li>a</li>') && h.includes('<li>c</li>'));

    // List adjacent to a table does not produce stray <p> artifacts.
    check('list then table', '- a\n- b\n| H1 | H2 |\n| -- | -- |\n| x | y |', (h) =>
        h.includes('<ul>') && h.includes('<table>') && !h.includes('<p></p>'));
    check('table then list', '| H1 | H2 |\n| -- | -- |\n| x | y |\n- a\n- b', (h) =>
        h.includes('<table>') && h.includes('<ul>') && !h.includes('<p></p>'));

    console.log(`\n${passed} assertions passed.\n`);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
