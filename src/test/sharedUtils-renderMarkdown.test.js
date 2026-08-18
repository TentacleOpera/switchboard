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

    // ── Live Preview Renderer Parity Contract Checks ──

    // 1. Source check: sharedUtilityVerbs.ts includes markdown: content in okRes (pushed object) and errRes
    const verbsSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'services', 'sharedUtilityVerbs.ts'), 'utf8');
    assert.ok(
        /const okRes = \{[\s\S]*?markdown:\s*content/.test(verbsSource),
        'handleRenderMarkdownLive must include markdown: content on okRes object'
    );
    assert.ok(
        /const errRes = \{[\s\S]*?markdown:\s*content/.test(verbsSource),
        'handleRenderMarkdownLive must include markdown: content on errRes object'
    );

    // 2. Source check: markdownEditor.js includes .md-live-preview .md-li-loose CSS rule
    const editorSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'webview', 'markdownEditor.js'), 'utf8');
    assert.ok(
        /\.md-live-preview\s+\.md-li-loose\s*\{/.test(editorSource),
        'markdownEditor.js must include .md-live-preview .md-li-loose CSS rule'
    );

    // 3. Source check: project.js must NOT use renderMarkdown
    const projectSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'webview', 'project.js'), 'utf8');
    assert.ok(
        !projectSource.includes('renderMarkdown('),
        'project.js must remain commonmark (no renderMarkdown calls)'
    );

    // 4. Source check: tickets.js, planning.js, design.js renderPreview bodies use renderMarkdown
    const ticketsWebviewSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'webview', 'tickets.js'), 'utf8');
    const planningWebviewSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'webview', 'planning.js'), 'utf8');
    const designWebviewSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'webview', 'design.js'), 'utf8');

    assert.ok(
        ticketsWebviewSource.includes('resolve(renderMarkdown('),
        'tickets.js renderPreview must resolve via renderMarkdown'
    );
    assert.ok(
        !/renderPreview:\s*\([^)]*\)\s*=>\s*new Promise\(\(resolve,\s*reject\)/.test(ticketsWebviewSource),
        'tickets.js renderPreview must not have reject parameter'
    );

    assert.ok(
        planningWebviewSource.includes('renderPreview: (markdown) => Promise.resolve(renderMarkdown(markdown))'),
        'planning.js doc editor renderPreview must resolve locally'
    );
    assert.ok(
        planningWebviewSource.includes('resolve(renderMarkdown('),
        'planning.js ticket editor renderPreview must resolve via renderMarkdown'
    );

    assert.ok(
        designWebviewSource.includes('renderPreview: (markdown) => Promise.resolve(renderMarkdown(markdown))'),
        'design.js renderPreview must resolve locally'
    );

    // 4b. The round-tripping sites keep the duplicate-push guard and lost the reject
    // path (plan verification item 6). The browser host mirrors one WS push to every
    // panel surface, so removeEventListener is what makes the duplicate arrivals
    // harmless — deleting it turns a tolerated duplicate into a repeated re-render.
    for (const [label, src] of [['tickets.js', ticketsWebviewSource], ['planning.js', planningWebviewSource]]) {
        const body = src.slice(
            src.indexOf('renderPreview: (markdown) => new Promise((resolve) => {'),
            src.indexOf('onAttachImage:', src.indexOf('renderPreview: (markdown) => new Promise((resolve) => {'))
        );
        assert.ok(
            body.includes("window.removeEventListener('message', handler);"),
            `${label} round-tripping renderPreview must still removeEventListener before resolving`
        );
        assert.ok(
            !/\breject\(/.test(body),
            `${label} round-tripping renderPreview must have no reject path`
        );
    }

    // 5. externalizeAnchors idempotence (plan verification item 5). externalizeAnchors
    // lives in sharedUtils.js — already eval'd onto the jsdom window above — NOT in
    // markdownEditor.js. Asserted unconditionally: a `typeof === function` guard here
    // would silently skip the check the moment the symbol moved, which is how this
    // assertion spent its first pass not running at all.
    const externalizeAnchors = window.externalizeAnchors;
    assert.strictEqual(typeof externalizeAnchors, 'function',
        'externalizeAnchors should be exposed on the window by sharedUtils.js');
    const htmlWithLink = renderMarkdown('- see [docs](https://example.com)');
    assert.ok(htmlWithLink.includes('<a '), 'fixture must actually contain an anchor to be a test');
    const externalizedOnce = externalizeAnchors(htmlWithLink);
    const externalizedTwice = externalizeAnchors(externalizedOnce);
    assert.strictEqual(externalizedOnce, externalizedTwice,
        'externalizeAnchors must be idempotent on renderMarkdown output');
    assert.strictEqual((externalizedTwice.match(/target=/g) || []).length, 1,
        'externalizeAnchors must not double-apply target= to a renderMarkdown anchor');
    assert.strictEqual((externalizedTwice.match(/rel=/g) || []).length, 1,
        'externalizeAnchors must not double-apply rel= to a renderMarkdown anchor');
    console.log('  ok - externalizeAnchors idempotence');
    passed++;

    // 6. BEHAVIOURAL: the `markdown` field must reach the object handleRenderMarkdownLive
    // PUSHES, and must carry the IMAGE-REWRITTEN content — not msg.content. Every webview
    // call site reads the push, never the HTTP body, so a field added only to the `return`
    // spread leaves all four switched sites falling back to un-rewritten source and
    // rendering with broken images, with no error raised anywhere. The source regex above
    // pins the shape; this pins the behaviour.
    const { handleRenderMarkdownLive } = require(
        path.join(process.cwd(), 'out', 'services', 'sharedUtilityVerbs.js'));

    const makeDeps = (pushes, rendered) => ({
        seams: () => ({ commands: { executeCommand: async () => rendered } }),
        resolveWorkspaceRoot: () => '/ws',
        push: (m) => pushes.push(m),
        findTicketFilePath: async () => '/ws/.switchboard/tickets/linear/ABC-1.md',
        rewriteLocalImagePaths: (content) => content.replace('](img.png)', '](https://host/img.png)'),
        getTicketDocumentDirs: () => [],
        getLinearSyncService: () => null
    });

    {
        const pushes = [];
        const res = await handleRenderMarkdownLive(
            makeDeps(pushes, '<p>html</p>'),
            { content: '![a](img.png)', requestId: 7, provider: 'linear', id: 'ABC-1' }
        );
        assert.strictEqual(pushes.length, 1, 'handleRenderMarkdownLive must push exactly one reply');
        const pushed = pushes[0];
        for (const field of ['html', 'htmlContent', 'markdown']) {
            assert.ok(field in pushed, `pushed markdownLiveRendered must carry ${field}`);
        }
        assert.strictEqual(pushed.markdown, '![a](https://host/img.png)',
            'pushed markdown must be the IMAGE-REWRITTEN content, not msg.content');
        assert.strictEqual(pushed.html, '<p>html</p>', 'pushed html must stay for the Project panel');
        assert.strictEqual(res.markdown, pushed.markdown, 'the in-body return must agree with the push');
        assert.strictEqual(res.success, true, 'the success branch must return success:true');
        console.log('  ok - markdown field is on the PUSHED object, image-rewritten');
        passed++;
    }

    {
        // Standalone host: markdown.api.render is a VS Code built-in, so executeCommand
        // resolves undefined WITHOUT throwing. The success branch runs with html:undefined,
        // and `markdown` is the only thing keeping the browser-host preview alive.
        const pushes = [];
        await handleRenderMarkdownLive(makeDeps(pushes, undefined), { content: '- a\n- b\n\n- c', requestId: 8 });
        assert.strictEqual(pushes[0].html, undefined, 'standalone host: markdown.api.render yields undefined');
        assert.strictEqual(pushes[0].markdown, '- a\n- b\n\n- c',
            'standalone host: the source markdown must survive so the preview is not blank');
        console.log('  ok - browser host keeps a renderable payload with no markdown.api.render');
        passed++;
    }

    {
        // The catch branch must carry the source too — `content` is declared outside the
        // try for exactly this reason (plan verification item 3).
        const pushes = [];
        const deps = makeDeps(pushes, '<p>x</p>');
        deps.findTicketFilePath = async () => { throw new Error('boom'); };
        const res = await handleRenderMarkdownLive(deps, { content: '# raw', requestId: 9, provider: 'linear', id: 'ABC-1' });
        assert.strictEqual(pushes[0].markdown, '# raw', 'errRes must carry the source markdown');
        assert.strictEqual(res.success, false, 'the failure branch must return success:false');
        console.log('  ok - error branch carries the source markdown');
        passed++;
    }

    console.log(`\n${passed} assertions passed.\n`);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
