'use strict';
/**
 * Browser-panel runtime surface contract.
 *
 * Every assertion here pins a defect that SHIPPED in 1.7.13 and that no existing
 * test could see, because each one is a mismatch between two files that are
 * individually valid:
 *
 *   1. terminals.js called `term.onFocus(...)` / `term.onBlur(...)`. Those emitters
 *      exist in the vendored xterm bundle, but only on the INTERNAL CoreTerminal
 *      subclass — the public `Terminal` the panel constructs does not expose them.
 *      The call threw `TypeError: term.onFocus is not a function` from the middle of
 *      materializeTerminalView, and because connectTerminalSocket() is BELOW that
 *      point the throw took the WebSocket with it: every pane rendered a blank xterm
 *      and reported `connecting` forever. So: the set of `term.on*` handlers this
 *      panel subscribes to must be a subset of what the vendored public class
 *      actually exposes.
 *
 *   2. tickets.html shipped a hand-written CSP with NO `connect-src`, so
 *      `default-src 'none'` governed connections and every transport.js fetch() plus
 *      the state WebSocket was blocked — the browser Tickets panel rendered fully and
 *      then reached no source at all. getTicketsHtml's widening rewrite targets the
 *      literal `connect-src https:`, which the new CSP did not contain, so it was a
 *      silent no-op. So: every panel HTML served to a browser must declare a
 *      connect-src the host can widen, or already list the loopback origins itself.
 *
 *   3. The `.localhost` CSP rule was enforced over headlessPanelHtml.ts and
 *      shell.html only, so terminals.html and memo.html kept a connect-src that
 *      allowed `ws://localhost:*` and not `ws://*.localhost:*`. The sweep now covers
 *      every webview HTML.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const WEBVIEW = path.join(ROOT, 'src', 'webview');

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ok  ${name}`);
    } catch (err) {
        failures++;
        console.error(`  FAIL ${name}\n       ${err.message}`);
    }
}

console.log('Browser-panel runtime surface contract');

// ------------------------------------------------- 1. xterm public API subset
check('terminals.js subscribes only to xterm events the VENDORED public Terminal exposes', () => {
    const bundle = fs.readFileSync(path.join(WEBVIEW, 'vendor', 'xterm', 'xterm.js'), 'utf8');
    const panel = fs.readFileSync(path.join(WEBVIEW, 'terminals.js'), 'utf8');

    // The public class is the one carrying `get textarea()` alongside its event
    // getters — the internal CoreTerminal subclass has no helper textarea. Locate it
    // by that pair rather than by minified identifier, which changes every build.
    const classStarts = [...bundle.matchAll(/class [A-Za-z_$][\w$]* extends [A-Za-z_$][\w$.]*\{/g)];
    let publicGetters = null;
    for (const m of classStarts) {
        const body = bundle.slice(m.index, m.index + 4000);
        const getters = [...body.matchAll(/get ([A-Za-z_$][\w$]*)\(\)/g)].map(g => g[1]);
        if (getters.includes('textarea') && getters.includes('buffer') && getters.some(g => g.startsWith('on'))) {
            publicGetters = getters;
            break;
        }
    }
    assert.ok(publicGetters, 'could not locate the public Terminal class in the vendored bundle');

    const exposed = new Set(publicGetters.filter(g => /^on[A-Z]/.test(g)));
    // Sanity-pin the locator itself: if this ever fails the class match drifted, and a
    // silently-empty `exposed` set would make the real assertion below vacuous.
    assert.ok(exposed.has('onData'), `public Terminal must expose onData; found: ${[...exposed].join(', ')}`);

    // `term` is the local name materializeTerminalView binds the instance to.
    const used = new Set([...panel.matchAll(/\bterm\.(on[A-Z][\w$]*)\s*\(/g)].map(m => m[1]));
    const missing = [...used].filter(u => !exposed.has(u));
    assert.deepStrictEqual(
        missing,
        [],
        `terminals.js calls term.${missing.join('/term.')}, which the vendored public Terminal does not expose. ` +
        'These throw at runtime from inside materializeTerminalView, and connectTerminalSocket() runs AFTER that ' +
        'point — so the pane renders a blank xterm and reports "connecting" forever. ' +
        `Exposed: ${[...exposed].sort().join(', ')}`
    );
});

// ----------------------------------------- 2. browser panels can open connections
//
// The panel ids the shell mounts as iframes, mapped to their HTML. Each one runs
// transport.js, which reaches the host over fetch() and a WebSocket.
const BROWSER_PANELS = {
    board: 'kanban.html',
    project: 'project.html',
    memo: 'memo.html',
    tickets: 'tickets.html',
    planning: 'planning.html',
    design: 'design.html',
    setup: 'setup.html',
    terminals: 'terminals.html',
};

// The literal getTicketsHtml/getPlanningHtml/... rewrite to widen a webview CSP for
// the browser. Must stay in step with headlessPanelHtml.ts.
const WIDENED_TARGET = 'connect-src https:';

check('every browser panel HTML declares a connect-src the host can widen', () => {
    for (const [id, file] of Object.entries(BROWSER_PANELS)) {
        const src = fs.readFileSync(path.join(WEBVIEW, file), 'utf8');
        const meta = /<meta[^>]*Content-Security-Policy[^>]*>/i.exec(src);
        // No meta CSP at all is fine: the page then inherits no connection
        // restriction in the browser (kanban.html / setup.html are like this).
        if (!meta) { continue; }
        const csp = meta[0];
        if (!/connect-src/i.test(csp)) {
            assert.fail(
                `${file} (panel "${id}") has a meta CSP with NO connect-src, so default-src governs ` +
                'connections. In the browser cockpit that blocks every transport.js fetch() and the ' +
                'state WebSocket: the panel renders fully and then reaches nothing. Add ' +
                `"${WIDENED_TARGET}" (which headlessPanelHtml rewrites to the loopback origins) or list ` +
                'the loopback origins directly.'
            );
        }
        const widenable = csp.includes(WIDENED_TARGET);
        const selfHosted = /connect-src[^;]*ws:\/\/127\.0\.0\.1:\*/.test(csp);
        assert.ok(
            widenable || selfHosted,
            `${file} (panel "${id}") declares a connect-src that is neither the rewritable literal ` +
            `"${WIDENED_TARGET}" nor an explicit loopback list. headlessPanelHtml's widening is a plain ` +
            'string replace — a reworded directive makes it a silent no-op.'
        );

        // The rewrite is `String.replace(literal, …)`: FIRST match only. A second
        // occurrence anywhere earlier in the file — a comment quoting the directive is
        // the obvious one, and it happened — absorbs the rewrite and leaves the real
        // CSP unwidened, which is the original bug wearing a different hat.
        if (widenable) {
            const occurrences = src.split(WIDENED_TARGET).length - 1;
            assert.strictEqual(
                occurrences,
                1,
                `${file} contains "${WIDENED_TARGET}" ${occurrences} times. headlessPanelHtml rewrites only ` +
                'the FIRST, so any earlier occurrence (e.g. a comment quoting it) steals the rewrite and the ' +
                'real CSP is never widened. Keep exactly one.'
            );
        }
    }
});

// ------------------------------------- 2b. panel pushes must reach the browser
//
// A panel provider's BroadcastHub needs the LocalApiServer to reach a browser at
// all; with `apiServer: null` it delivers to the editor webview only. Tickets was
// constructed with `undefined` for that argument and had no setter, so in the
// cockpit every push-shaped reply it made was dropped — the panel rendered, its
// HTTP-body verbs answered, and nothing that replies by push ever arrived.
//
// This has to be a SOURCE assertion. The headless verb harness builds its own
// `new BroadcastHub({ webview: fakeWebview, apiServer: null })`, so it exercises
// the webview path by construction and can never observe the production wiring.
check('every panel provider with a browser surface is handed the LocalApiServer', () => {
    const tvp = fs.readFileSync(path.join(ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');

    // Registration order is not guaranteed, so BOTH sites must wire it: the setter
    // that registers the provider, and the block that creates the server.
    const REGISTRARS = [
        ['setDesignPanelProvider', '_designPanelProvider'],
        ['setPlanningPanelProvider', '_planningPanelProvider'],
        ['setTicketsPanelProvider', '_ticketsPanelProvider'],
    ];
    for (const [setter, field] of REGISTRARS) {
        const start = tvp.indexOf(`public ${setter}(`);
        assert.ok(start !== -1, `TaskViewerProvider.${setter} not found`);
        // To the next member, NOT a fixed byte window: a comment inside the method
        // must not be able to push the call being asserted out of view (it did).
        const after = tvp.slice(start + 1);
        const nextMember = after.search(/\n    (?:public|private|protected|\/\*\*)/);
        const body = nextMember === -1 ? after : after.slice(0, nextMember);
        assert.ok(
            /setApiServer\(this\._localApiServer\)/.test(body),
            `${setter} must hand the provider this._localApiServer when one already exists — ` +
            'otherwise a provider registered after the server starts never gets it, and its ' +
            'pushes are dropped for the browser cockpit.'
        );
        assert.ok(
            new RegExp(`${field}\\s*=`).test(body),
            `${setter} should assign ${field} (guards against this check matching the wrong method)`
        );
    }

    // The server-creation block: find where the api server is pushed out to panels
    // and require every browser-surface provider in it.
    const anchor = tvp.indexOf('this._broadcaster?.setApiServer(this._localApiServer)');
    assert.ok(anchor !== -1, 'could not locate the LocalApiServer fan-out block');
    const fanout = tvp.slice(anchor, anchor + 2000);
    for (const field of ['_kanbanProvider', '_setupPanelProvider', '_designPanelProvider', '_planningPanelProvider', '_ticketsPanelProvider']) {
        assert.ok(
            fanout.includes(field),
            `${field} is missing from the LocalApiServer fan-out. Its pushes will reach the editor ` +
            'webview and be silently dropped for the browser.'
        );
    }

    // And the receiving end has to exist at all.
    const tickets = fs.readFileSync(path.join(ROOT, 'src', 'services', 'TicketsPanelProvider.ts'), 'utf8');
    assert.ok(
        /public setApiServer\([^)]*\)\s*:\s*void\s*\{/.test(tickets),
        'TicketsPanelProvider must expose setApiServer — extension.ts passes `undefined` for the ' +
        'constructor argument, so the setter is the only route by which its pushes reach a browser.'
    );
    assert.ok(
        /this\._broadcaster\?\.setApiServer\(/.test(tickets),
        'setApiServer must forward to the already-built broadcaster, not only store the field — the ' +
        'hub is created on the first verb and would keep its null transport otherwise.'
    );
});

// ------------------------------------- 2c. no workspace picker in the Tickets tab
//
// Tickets are global: the panel shows one ticket source for the machine, and
// `ticketsWorkspaceRoot` is only a file-save destination. planning.html carried the
// element with `display:none`; the extraction copied it and un-hid it as scaffolding
// ("Later slices may re-introduce the hide" — none did), and rewired it onto the
// all-roots list, which is also what broke provider resolution. Hidden is not good
// enough: the element and its machinery are deleted, and must stay deleted.
check('the Tickets panel has no workspace picker, hidden or otherwise', () => {
    const html = fs.readFileSync(path.join(WEBVIEW, 'tickets.html'), 'utf8');
    const js = fs.readFileSync(path.join(WEBVIEW, 'tickets.js'), 'utf8');

    // Ignore comment bodies — the explanatory notes name these deliberately.
    const stripComments = (src) => src
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

    for (const id of ['tickets-workspace-filter', 'tickets-workspace-label', 'tickets-workspace-picker']) {
        assert.ok(
            !stripComments(html).includes(id),
            `tickets.html still contains "${id}". The Tickets tab must not have a workspace ` +
            'picker — not visible, and not present-but-hidden.'
        );
        assert.ok(
            !stripComments(js).includes(id),
            `tickets.js still references "${id}" outside a comment. Delete the code, not just the control.`
        );
    }
    for (const sym of ['registerWorkspaceDropdown', 'populateWorkspaceDropdown', 'updateTicketsWorkspacePicker']) {
        assert.ok(
            !stripComments(js).includes(sym),
            `tickets.js still carries "${sym}". It exists only to drive the deleted picker; ` +
            'a helper with no caller is the dead code this panel already shipped once.'
        );
    }
});

// ------------------------------------------------------ 3. the .localhost sweep
check('every webview CSP that allows ws://localhost also allows ws://*.localhost', () => {
    const files = fs.readdirSync(WEBVIEW)
        .filter(f => f.endsWith('.html'))
        .map(f => path.join(WEBVIEW, f))
        .concat([path.join(ROOT, 'src', 'services', 'headlessPanelHtml.ts')]);

    for (const file of files) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
            if (!line.includes('ws://localhost:*')) { return; }
            assert.ok(
                line.includes('ws://*.localhost:*') && line.includes('wss://*.localhost:*'),
                `${path.basename(file)}:${i + 1} allows ws://localhost:* but not ws://*.localhost:* — ` +
                'a board served via --hostname switchboard.localhost renders and then never connects'
            );
        });
    }
});

// ------------------------------------- 4. markdown editor paints its own surface
//
// The shared markdown editor (markdownEditor.js) is mounted in four panels
// (planning/design/project/tickets) across both hosts. Its editing surface was
// keyed off --panel-bg, which is #000000 in every host panel — pure black under
// body text for an entire editing session. The fix: the editor owns its own
// dark-grey surface via var(--md-editor-bg, #1a1a1a), and BOTH halves (the edit
// textarea's shell and the live-preview pane) must paint the same value or split
// view (the default mode) shows a visible seam. This assertion is structural: it
// fails if either rule re-adopts a --panel-bg* token, or if the two halves
// diverge — while staying green through any deliberate retune of the grey.
//
// It also pins the textarea's `background: transparent`, which is what makes the
// shell's colour reach the operator at all. Every host panel ships its own
// .markdown-editor background (#000 hardcoded in project.html, var(--panel-bg)
// in the other three); the injected (0,2,1) selector out-scores them and paints
// nothing, so the shell shows through. Paint the textarea directly and the shell
// fix is cosmetically dead in all eleven textareas while every other assertion
// here stays green.
check('markdown editor paints its own surface, and both halves share it', () => {
    const src = fs.readFileSync(path.join(WEBVIEW, 'markdownEditor.js'), 'utf8');
    const ruleBody = (selector) => {
        const i = src.indexOf(`${selector} {`);
        assert.ok(i !== -1, `${selector} rule not found in markdownEditor.js`);
        const open = src.indexOf('{', i);
        const close = src.indexOf('}', open);
        return src.slice(open + 1, close);
    };
    const backgroundOf = (selector) => {
        const m = ruleBody(selector).match(/(?:^|\n)\s*background:\s*([^;]+);/);
        assert.ok(m, `${selector} declares no background`);
        return m[1].trim();
    };
    const shell = backgroundOf('.md-editor-shell');
    const preview = backgroundOf('.md-live-preview');
    for (const [name, value] of [['.md-editor-shell', shell], ['.md-live-preview', preview]]) {
        assert.ok(!/--panel-bg\b/.test(value) && !/--panel-bg2\b/.test(value),
            `${name} must not key its surface off the panel background tokens ` +
            `(--panel-bg is #000000 and --panel-bg2 is #0a0a0a in every host panel) — got: ${value}`);
    }
    assert.strictEqual(shell, preview,
        `the edit half and the preview half must paint the same surface or split view ` +
        `(the default mode) shows a seam — shell=${shell} preview=${preview}`);

    const textarea = backgroundOf('.md-body > textarea.markdown-editor');
    assert.strictEqual(textarea, 'transparent',
        `.md-body > textarea.markdown-editor must stay background: transparent so the ` +
        `shell owns the editing surface — painting it here re-hides the shell behind ` +
        `whatever the host panel wants (#000 in project.html, var(--panel-bg) = #000000 ` +
        `in the other three) — got: ${textarea}`);
});

if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
}
console.log('\nAll browser-panel runtime surface assertions passed.');
