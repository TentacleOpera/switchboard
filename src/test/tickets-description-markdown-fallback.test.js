'use strict';

/**
 * Ticket description must never degrade to escaped plaintext.
 *
 * `renderedDescriptionHtml` is produced by `markdown.api.render`, a VS Code built-in.
 * It is unreachable in the standalone host, so the field arrives empty there and the
 * old fallback — `escapeHtml(md).replace(/\n/g, '<br>')` — painted the literal source
 * text: `![](https://…)` instead of the image, `## Heading` instead of a heading.
 *
 * The fix has two halves and BOTH must stay in place; either one alone leaves a hole:
 *   1. Ingestion (`linearTaskDetailsLoaded` / `clickupTaskDetailsLoaded`) normalises the
 *      empty field to `renderMarkdown(source)`, so every downstream consumer — renderers,
 *      edit mode, redraw suppression, both detail caches — sees one value.
 *   2. The two detail renderers keep a middle branch that renders source markdown, which
 *      is what covers the pre-fetch card-click stub (`{ issue, detailsFetched: false }`)
 *      that never passes through ingestion at all.
 *
 * Plus two regression guards with teeth:
 *   - `localDescription` must stay `false` on the normalised value. Setting it true means
 *     "the local file outranks the remote payload", which would pin the first render
 *     forever and make every later remote edit invisible.
 *   - the ingested source must be trimmed. `renderMarkdown('\n')` returns `'<p><br></p>'`,
 *     which is truthy — an untrimmed whitespace-only description would take the
 *     host-HTML branch and paint an empty paragraph instead of 'No description provided.'
 *
 * Run via: npm run test:contract:tickets-description-fallback
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

function sliceArm(source, startMarker, endMarker, label) {
    const start = source.indexOf(startMarker);
    assert.notStrictEqual(start, -1, `${label}: expected to find ${startMarker}`);
    const end = source.indexOf(endMarker, start);
    assert.notStrictEqual(end, -1, `${label}: expected to find ${endMarker} after ${startMarker}`);
    return source.slice(start, end);
}

function testRendererBranches(ticketsJs) {
    // Both renderers must be three-branch: host HTML -> locally rendered markdown ->
    // empty state. The escaped-plaintext limb must be gone from both.
    const cases = [
        {
            label: 'Linear',
            state: 'selectedLinearIssue',
            marker: 'if (selectedLinearIssue.renderedDescriptionHtml) {',
            sourceChain: /const descSrc = \(selectedLinearIssue\.descriptionMarkdown \|\| issue\.description \|\| ''\)\.trim\(\);/,
        },
        {
            label: 'ClickUp',
            state: 'selectedClickUpIssue',
            marker: 'if (selectedClickUpIssue.renderedDescriptionHtml) {',
            sourceChain: /const descSrc = \(selectedClickUpIssue\.descriptionMarkdown \|\| task\.markdownDescription \|\| task\.description \|\| ''\)\.trim\(\);/,
        },
    ];

    for (const c of cases) {
        const idx = ticketsJs.indexOf(c.marker);
        assert.notStrictEqual(idx, -1, `${c.label} renderer must branch on ${c.state}.renderedDescriptionHtml`);
        const block = ticketsJs.slice(idx, idx + 700);

        assert.ok(
            block.includes(`externalizeAnchors(${c.state}.renderedDescriptionHtml)`),
            `${c.label}: host-rendered HTML must stay the preferred branch, via externalizeAnchors`
        );
        assert.match(
            block,
            c.sourceChain,
            `${c.label}: branch 2 must derive trimmed source markdown from descriptionMarkdown, then the raw payload fields`
        );
        assert.ok(
            block.includes('contentHtml += renderMarkdown(descSrc);'),
            `${c.label}: branch 2 must render the source with renderMarkdown, not escape it`
        );
        assert.ok(
            block.includes("contentHtml += '<p>No description provided.</p>';"),
            `${c.label}: branch 3 must be the empty-state paragraph`
        );
        // The exact shape of the bug. If this limb comes back, so does the symptom.
        assert.ok(
            !/escapeHtml\([^)]*description[^)]*\)[\s\S]{0,80}replace\(\/\\n\/g, '<br>'\)/i.test(block),
            `${c.label}: the escapeHtml(...).replace(/\\n/g,'<br>') description limb must not return`
        );
    }
}

function testIngestionNormalisation(ticketsJs) {
    const cases = [
        {
            label: 'Linear',
            arm: sliceArm(ticketsJs, "case 'linearTaskDetailsLoaded': {", "case 'clickupTaskDetailsLoaded': {", 'Linear ingestion'),
            src: /const _linearSrc = \(message\.issue\.description \|\| ''\)\.trim\(\);/,
            normalise: /renderedDescriptionHtml: _keepLinearDesc \? _prevLinear\.renderedDescriptionHtml : \(message\.renderedDescriptionHtml \|\| renderMarkdown\(_linearSrc\)\)/,
            keepFlag: /localDescription: _keepLinearDesc \|\| false/,
            markdownField: /descriptionMarkdown: _keepLinearDesc \? _prevLinear\.descriptionMarkdown : \(message\.issue\.description \|\| ''\)/,
        },
        {
            label: 'ClickUp',
            arm: sliceArm(ticketsJs, "case 'clickupTaskDetailsLoaded': {", "case 'subtaskConverted': {", 'ClickUp ingestion'),
            src: /const _clickUpSrc = \(message\.task\.markdownDescription \|\| message\.task\.description \|\| ''\)\.trim\(\);/,
            normalise: /renderedDescriptionHtml: _keepClickUpDesc \? _prevClickUp\.renderedDescriptionHtml : \(message\.renderedDescriptionHtml \|\| renderMarkdown\(_clickUpSrc\)\)/,
            keepFlag: /localDescription: _keepClickUpDesc \|\| false/,
            markdownField: /descriptionMarkdown: _keepClickUpDesc \? _prevClickUp\.descriptionMarkdown : \(message\.task\.markdownDescription \|\| message\.task\.description \|\| ''\)/,
        },
    ];

    for (const c of cases) {
        assert.match(c.arm, c.src, `${c.label} ingestion must trim the source markdown before rendering it`);
        assert.match(
            c.arm,
            c.normalise,
            `${c.label} ingestion must fall back to renderMarkdown when the host returns empty renderedDescriptionHtml`
        );
        // The single most damaging way to get this change wrong: localDescription true
        // means "local file wins over the remote payload", which freezes the description.
        assert.match(
            c.arm,
            c.keepFlag,
            `${c.label} ingestion must NOT set localDescription for a locally-RENDERED REMOTE description — it would pin the first render forever`
        );
        assert.match(
            c.arm,
            c.markdownField,
            `${c.label} ingestion must keep descriptionMarkdown as the untouched raw source (edit mode reads it)`
        );
    }
}

function testProviderCatchComments() {
    const files = [
        path.join(__dirname, '../services/TicketsPanelProvider.ts'),
        path.join(__dirname, '../services/TaskViewerProvider.ts'),
    ];
    for (const file of files) {
        const src = fs.readFileSync(file, 'utf8');
        const hits = (src.match(/markdown\.api\.render is a VS Code built-in and is unavailable on hosts/g) || []).length;
        assert.strictEqual(
            hits,
            2,
            `${path.basename(file)} must document, at both markdown.api.render catch sites, that an empty result is expected off-VS-Code and the webview renders the source itself`
        );
        assert.ok(
            !src.includes('Fallback handled natively by the frontend'),
            `${path.basename(file)}: the old "frontend handles the fallback" comment was false (the fallback was escapeHtml) and must not return`
        );
    }
}

function testRenderMarkdownBehaviour(window) {
    const renderMarkdown = window.renderMarkdown;
    assert.strictEqual(typeof renderMarkdown, 'function', 'renderMarkdown must be exposed on the window');

    // 1. The reported symptom: an inline image must become an <img>, not literal source.
    const img = renderMarkdown('![](https://example.test/a.png)');
    assert.ok(img.includes('<img src="https://example.test/a.png"'), 'inline image must render as an <img> tag');
    assert.ok(!img.includes('![]('), 'inline image must not survive as literal markdown source');

    // 2. Formatting survives, and links stay externalised.
    const rich = renderMarkdown('## Head\n\n- one\n- two\n\n[link](https://example.test/x)\n\n```\ncode\n```');
    assert.ok(rich.includes('<h2>Head</h2>'), 'headings must render');
    assert.ok(rich.includes('<ul>') && rich.includes('<li>one</li>'), 'lists must render');
    assert.ok(rich.includes('<pre><code>'), 'fenced code must render');
    assert.ok(
        rich.includes('target="_blank"') && rich.includes('rel="noopener noreferrer"'),
        'links must carry target=_blank and rel=noopener noreferrer'
    );

    // 3. No widened injection surface: renderMarkdown escapes on the way in and routes
    //    every URL through sanitizeUrl, so swapping escapeHtml for it is not a regression.
    const hostile = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1))');
    assert.ok(!hostile.includes('<script>'), 'raw HTML must stay escaped');
    assert.ok(!/href="javascript:/i.test(hostile), 'javascript: URLs must be neutralised by sanitizeUrl');

    // 4. The whitespace trap the ingestion trim exists for. Bare '' is falsy already;
    //    '\n' is NOT — it renders as a truthy '<p><br></p>'. Trimming at the call site is
    //    what keeps a whitespace-only description on the 'No description provided.' branch.
    assert.strictEqual(renderMarkdown(''), '', "renderMarkdown('') must stay empty so the empty-state branch fires");
    assert.ok(renderMarkdown('\n'), "renderMarkdown('\\n') is truthy — this is why callers must trim (guards the fix's reason for existing)");
    assert.strictEqual(renderMarkdown('\n'.trim()), '', 'a trimmed whitespace-only description must render empty');
    assert.strictEqual(renderMarkdown('  \n\t\n  '.trim()), '', 'trimmed mixed whitespace must render empty');
}

async function run() {
    console.log('\nRunning ticket description markdown-fallback contract tests\n');

    const ticketsJs = fs.readFileSync(path.join(__dirname, '../webview/tickets.js'), 'utf8');

    testRendererBranches(ticketsJs);
    testIngestionNormalisation(ticketsJs);
    testProviderCatchComments();

    const sharedUtils = fs.readFileSync(path.join(__dirname, '../webview/sharedUtils.js'), 'utf8');
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only' });
    dom.window.eval(sharedUtils);
    testRenderMarkdownBehaviour(dom.window);

    console.log('tickets-description-markdown-fallback.test.js passed.\n');
}

if (require.main === module) {
    run().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { run };
