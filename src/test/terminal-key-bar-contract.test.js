'use strict';

/**
 * Contract: the mobile command view's terminal key bar.
 *
 * The plan: "A phone keyboard has no arrow keys, so no menu can be answered."
 * The mobile command view was a read-only terminal stream — it rendered
 * output into a <pre> and stripped ANSI escapes, with no input path. A
 * phone operator could see an agent but could not type into it, navigate
 * a menu, or interrupt a run.
 *
 * This file pins the structural properties that would silently un-fix it:
 *
 *   - Each arrow emits ESC [ X in normal cursor mode and ESC O X in
 *     application cursor mode (DECCKM).
 *   - Ctrl-C emits \x03.
 *   - Cursor mode is read at PRESS time, not captured once at attach.
 *   - Every key goes through encodeInputFrame, not paste.
 *   - command.js sends on the terminal socket (no regression to zero
 *     ws.send calls).
 *   - The command view uses the shared viewport (SwitchboardTerminalViewport),
 *     not a second hand-rolled client.
 *   - No textContent += stream box remains.
 *   - The viewport features actually fire in the command-view embedding:
 *     sends resize on connect, requests replay through lastSeq, arms
 *     answerback suppression.
 *   - The key bar is absent on fine-pointer viewports and present on
 *     coarse-pointer viewports.
 *   - command.html loads terminalViewport.js and the xterm/addon scripts.
 *   - Both standalone and extension template paths inject body.dataset.ptyHostOrigin
 *     and body.dataset.terminalToken for the command panel.
 *
 * Requires `npm run compile-tests` (loads compiled output from out/).
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}\n     ${e.message}`);
        failed++;
    }
}

function block(code, startMarker, endMarker) {
    const start = code.indexOf(startMarker);
    assert.ok(start !== -1, `marker not found: ${startMarker}`);
    const end = code.indexOf(endMarker, start);
    assert.ok(end !== -1, `end marker not found: ${endMarker}`);
    return code.substring(start, end);
}

const commandJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'command.js'), 'utf8');
const commandHtml = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'command.html'), 'utf8');
const keyBarJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'terminalKeyBar.js'), 'utf8');
const viewportJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'terminalViewport.js'), 'utf8');
const headlessSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'headlessPanelHtml.ts'), 'utf8');
const bootstrapSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'bootstrap.ts'), 'utf8');
const taskViewerSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');

console.log('\n── Mobile terminal key bar contract ──');

// ── Key bar: DECCKM-aware arrows ──────────────────────────────────────

test('arrow sequences are DECCKM-aware: ESC [ X normal, ESC O X application', () => {
    const fn = block(keyBarJs, 'function arrowSeq(letter)', 'function ctrlLetter(');
    assert.ok(fn.includes("mode === 'application'"), 'arrowSeq must branch on application mode');
    assert.ok(fn.includes("'\\x1bO'"), 'application cursor mode sends ESC O X');
    assert.ok(fn.includes("'\\x1b['"), 'normal cursor mode sends ESC [ X');
});

test('cursor mode is read at press time, not captured once', () => {
    // getCursorMode is called inside arrowSeq, not hoisted to a captured
    // variable at attach time. The call must be inside the function body.
    const fn = block(keyBarJs, 'function arrowSeq(letter)', 'function ctrlLetter(');
    assert.ok(fn.includes('getCursorMode()'),
        'arrowSeq must call getCursorMode() on every press — a value captured at attach goes stale when the operator enters vim/less/fzf');
});

test('Ctrl-C emits \\x03', () => {
    assert.ok(keyBarJs.includes("case 'ctrl-c':   deliver('\\x03')"),
        'Ctrl-C must deliver the ETX control character (\\x03), the SIGINT byte');
});

test('every key goes through deliver(), not paste', () => {
    // deliver() is the single send path. No term.paste call may exist.
    // A CALL, not a mention: the module's own header comment says "never
    // term.paste", so a bare substring test can never pass and pins nothing.
    const keyBarCode = keyBarJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\.paste\s*\(/.test(keyBarCode),
        'the key bar must never paste — a paste lands as bracketed-paste text, not a keystroke, and a TUI reading a single arrow sees the whole bracketed block');
    assert.ok(keyBarJs.includes('function deliver(bytes)'),
        'deliver() must be the single send path for every synthesized key');
    // Every key case routes through deliver.
    // End marker is the function that FOLLOWS handlePress. `setCtrlArmed` is
    // declared above it, so it was never found after the start marker and
    // block() threw on correct code.
    const cases = block(keyBarJs, 'function handlePress(key)', 'function applyCtrlLatch(');
    for (const key of ['up', 'down', 'left', 'right', 'enter', 'esc', 'tab', 'ctrl-c']) {
        assert.ok(cases.includes(`case '${key}'`),
            `handlePress must have a case for ${key}`);
    }
});

test('key buttons use pointerdown + preventDefault (do not dismiss the soft keyboard)', () => {
    assert.ok(keyBarJs.includes("'pointerdown'"),
        'key buttons must use pointerdown — a click handler fires after the soft keyboard blur, dismissing the keyboard');
    assert.ok(/e\.preventDefault\(\)/.test(keyBarJs),
        'pointerdown must preventDefault to suppress the focus shift that triggers the keyboard blur');
});

test('key bar is hidden on fine-pointer viewports, present on coarse-pointer', () => {
    const sync = block(keyBarJs, 'function syncVisibility()', 'function deliver(');
    assert.ok(sync.includes('isCoarsePointer()'),
        'syncVisibility must read isCoarsePointer()');
    assert.ok(sync.includes('sb-keybar-hidden'),
        'the bar must toggle the sb-keybar-hidden class');
    assert.ok(sync.includes('sb-keybar-visible'),
        'the bar must toggle the sb-keybar-visible class');
    // The CSS must hide the bar when the hidden class is present.
    assert.ok(commandHtml.includes('.sb-keybar.sb-keybar-hidden {'),
        'command.html CSS must hide .sb-keybar.sb-keybar-hidden');
});

test('the key bar exposes window.SwitchboardTerminalKeyBar.create', () => {
    assert.ok(keyBarJs.includes('window.SwitchboardTerminalKeyBar = { create: createTerminalKeyBar }'),
        'terminalKeyBar.js must expose window.SwitchboardTerminalKeyBar.create');
});

// ── command.js: input path through the shared viewport ───────────────

test('command.js sends on the terminal socket through encodeInputFrame (no regression to zero ws.send)', () => {
    assert.ok(commandJs.includes('terminalViewport.encodeInputFrame(bytes)'),
        'command.js must send through the viewport\'s encodeInputFrame — the same framing the desktop terminals panel uses');
    assert.ok(commandJs.includes('entry.ws.send('),
        'command.js must send on the active terminal\'s WebSocket — a regression to zero ws.send calls means typed input never reaches the seat');
});

test('command.js uses the shared viewport, not a second hand-rolled client', () => {
    assert.ok(commandJs.includes('window.SwitchboardTerminalViewport'),
        'command.js must use window.SwitchboardTerminalViewport — the shared module, not a second hand-rolled client');
    assert.ok(commandJs.includes('terminalViewport.createTerminalView('),
        'command.js must call createTerminalView to build the xterm view');
    assert.ok(commandJs.includes('terminalViewport.destroyTerminalView('),
        'command.js must call destroyTerminalView to tear down the xterm view on seat switch');
});

test('no textContent += stream box remains in command.js', () => {
    assert.ok(!/terminalStreamOutput\.textContent\s*\+=/.test(commandJs),
        'the hand-rolled <pre> stream box (textContent +=) must be gone — the shared viewport renders output through xterm');
    assert.ok(!commandJs.includes('terminalStreamOutput'),
        'no terminalStreamOutput reference may remain — the element was removed from command.html');
});

test('command.js reads DECCKM at press time for the key bar', () => {
    assert.ok(commandJs.includes('function getCursorMode()'),
        'command.js must expose getCursorMode() so the key bar reads DECCKM at press time');
    assert.ok(commandJs.includes('applicationCursorKeys'),
        'getCursorMode must read the DECCKM state');
});

test('getCursorMode prefers the PUBLIC xterm modes API and does not miss silently', () => {
    // term.modes.applicationCursorKeysMode is public (IModes, xterm.d.ts) and is
    // implemented by the vendored bundle. Reading only the private
    // coreService.decPrivateModes path and returning 'normal' on a miss is the
    // banned fallback shape: a wrong arrow form looks correct and does nothing
    // in exactly the full-screen menus the bar exists for.
    const fn = block(commandJs, 'function getCursorMode()', 'function buildFleetRoster()');
    assert.ok(fn.includes('modes.applicationCursorKeysMode'),
        'getCursorMode must read the public term.modes.applicationCursorKeysMode first');
    const publicAt = fn.indexOf('modes.applicationCursorKeysMode');
    const privateAt = fn.indexOf('decPrivateModes');
    assert.ok(publicAt !== -1 && privateAt !== -1 && publicAt < privateAt,
        'the public modes read must come BEFORE the private decPrivateModes fallback');
    assert.ok(/console\.(error|warn)/.test(fn),
        'a DECCKM read that neither API answers must be logged, not silently defaulted to normal');
    // The vendored bundle must actually implement the public getter.
    const vendored = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'vendor', 'xterm', 'xterm.js'), 'utf8');
    assert.ok(vendored.includes('applicationCursorKeysMode'),
        'the vendored xterm bundle must implement modes.applicationCursorKeysMode');
});

test('the command view supplies a REAL fit ladder and renderer resync, not no-ops', () => {
    // ensureSizeVote returns early once entry.sizeVoteActive is set, so
    // deps.startFitLadder is the only path that re-measures the box after a
    // settled resize — and on a phone the soft keyboard resizes the viewport on
    // every interaction. deps.resyncPaneRenderer is what rebuilds xterm's WebGL
    // glyph atlas after a cols/rows change; a no-op leaves overprinted glyphs.
    const bag = block(commandJs, 'function buildTerminalViewportDeps()', 'function sendTerminalInput(');
    assert.ok(!/startFitLadder:\s*\(\s*\)\s*=>\s*\{\s*\}/.test(bag),
        'startFitLadder must not be a no-op — nothing else re-fits the terminal after the soft keyboard opens or the phone rotates');
    assert.ok(!/resyncPaneRenderer:\s*\(\s*\)\s*=>\s*\{\s*\}/.test(bag),
        'resyncPaneRenderer must not be a no-op — fitAndReportSize calls it to rebuild the glyph atlas after every real resize');
    assert.ok(commandJs.includes('function runTerminalFitLadder('),
        'command.js must implement a fit ladder');
    assert.ok(commandJs.includes('terminalViewport.fitAndReportSize('),
        'the fit ladder must re-fit through the viewport\'s fitAndReportSize');
    assert.ok(commandJs.includes('clearTextureAtlas'),
        'the renderer resync must rebuild the texture atlas, as the terminals panel does');
});

test('sticky Ctrl is consumed on the outgoing data path, not left as a highlight', () => {
    assert.ok(keyBarJs.includes('function applyCtrlLatch(data)'),
        'the key bar must expose applyCtrlLatch — a Ctrl latch that only highlights is a UI lie');
    assert.ok(/code & 0x1f/.test(keyBarJs),
        'applyCtrlLatch must map the latched character to its control code');
    assert.ok(viewportJs.includes('deps.transformInput'),
        'the viewport must offer the transformInput seam the latch is consumed on');
    assert.ok(/if \(typeof deps\.transformInput === 'function'\)/.test(viewportJs),
        'transformInput must be OPTIONAL and guarded — the terminals panel passes none');
    assert.ok(commandJs.includes('applyCtrlLatch(data)'),
        'command.js must install the key bar latch on the viewport\'s transformInput seam');
});

test('the extension host does not hand the phone surface a loopback pty origin', () => {
    // data-pty-host-origin="ws://127.0.0.1:<port>" resolves to the PHONE when the
    // command view is opened over the LAN, which is the only way it is opened.
    const site = taskViewerSrc.indexOf('ptyOriginAttr');
    assert.ok(site > -1, 'TaskViewerProvider.ts must compute ptyOriginAttr');
    const arm = taskViewerSrc.slice(site - 400, site + 400);
    assert.ok(/id !== 'command'/.test(arm),
        'the extension host must omit data-pty-host-origin for the command panel — loopback is unreachable from the phone the surface exists for');
});

test('command.js builds the seat switcher from the full fleet, with ungrouped seats', () => {
    assert.ok(commandJs.includes('function buildFleetRoster()'),
        'command.js must build a fleet roster from ptyListTerminals');
    assert.ok(commandJs.includes('ungrouped'),
        'the fleet roster must include an ungrouped section for seats not assigned to a team');
    assert.ok(commandJs.includes("'Ungrouped'"),
        'the seat switcher must render an "Ungrouped" section label');
});

test('command.js switches seats by destroying the prior viewport before creating the new one', () => {
    const open = block(commandJs, 'function openTerminalViewer(', 'function buildSeatSwitcher(');
    assert.ok(open.includes('destroyTerminalViewer()'),
        'openTerminalViewer must destroy the prior viewport before creating the new one — no window with two simultaneous sockets');
});

// ── command.html: loads the shared viewport + key bar + xterm ─────────

test('command.html loads terminalViewport.js and terminalKeyBar.js', () => {
    assert.ok(commandHtml.includes('src="/static/webview/terminalViewport.js"'),
        'command.html must load terminalViewport.js');
    assert.ok(commandHtml.includes('src="/static/webview/terminalKeyBar.js"'),
        'command.html must load terminalKeyBar.js');
});

test('command.html loads the xterm CSS stylesheet', () => {
    assert.ok(commandHtml.includes('href="{{XTERM_CSS_URI}}"'),
        'command.html must link the xterm CSS stylesheet (template-substituted by getCommandHtml)');
});

test('command.html has the xterm host container and key bar container', () => {
    assert.ok(commandHtml.includes('id="terminal-xterm-host"'),
        'command.html must have the xterm host container (#terminal-xterm-host)');
    assert.ok(commandHtml.includes('id="terminal-key-bar"'),
        'command.html must have the key bar container (#terminal-key-bar)');
});

test('command.html body carries is-solo so the viewport adds &solo=1', () => {
    assert.ok(/<body class="is-solo">/.test(commandHtml),
        'command.html body must carry is-solo so the viewport module adds &solo=1 to the WS URL (single-terminal viewer)');
});

test('the RENDERED command panel keeps is-solo once a theme class is applied', () => {
    // The source-file check above is not sufficient and was green while the
    // served page was wrong: applyThemeClass REPLACES the body class attribute
    // wholesale, and both hosts always pass a non-empty theme class, so the
    // template's own class="is-solo" was erased on every real render and the
    // phone silently stopped sending &solo=1.
    const { getPanelHtmlById } = require(path.join(REPO_ROOT, 'out', 'services', 'headlessPanelHtml.js'));
    for (const theme of [undefined, 'cyber-theme-enabled', 'theme-claudify']) {
        const result = getPanelHtmlById('command', REPO_ROOT, REPO_ROOT, {}, theme);
        const headEnd = result.html.search(/<\/head\s*>/i);
        const tag = /<body\b[^>]*>/i.exec(result.html.slice(headEnd))[0];
        assert.ok(/class="[^"]*\bis-solo\b[^"]*"/.test(tag),
            `the rendered command body must keep is-solo (themeClass=${theme}); got: ${tag.slice(0, 200)}`);
        if (theme) {
            assert.ok(tag.includes(theme),
                `the rendered command body must still carry the theme class ${theme}`);
        }
    }
});

test('command.html has no read-only <pre> stream box', () => {
    assert.ok(!commandHtml.includes('id="terminal-stream-output"'),
        'the read-only <pre> stream box (#terminal-stream-output) must be gone');
    assert.ok(!commandHtml.includes('terminal-stream-box'),
        'the terminal-stream-box class must be gone');
});

// ── headlessPanelHtml.ts: getCommandHtml injects xterm URIs ───────────

test('getCommandHtml substitutes the xterm CSS URI', () => {
    const fn = block(headlessSrc, 'export function getCommandHtml(', 'export interface PanelManifestEntry');
    // Matched WITHOUT braces: the substitution is written as an escaped regex
    // literal (/\{\{XTERM_CSS_URI\}\}/g), so the literal text "{{XTERM_CSS_URI}}"
    // never appears in the TypeScript source.
    assert.ok(fn.includes('XTERM_CSS_URI'),
        'getCommandHtml must substitute the xterm CSS URI');
    assert.ok(fn.includes('/static/webview/vendor/xterm/xterm.css'),
        'getCommandHtml must resolve the xterm CSS URI to the vendor path');
});

test('getCommandHtml injects xterm/addon body data-attributes', () => {
    const fn = block(headlessSrc, 'export function getCommandHtml(', 'export interface PanelManifestEntry');
    assert.ok(fn.includes('data-xterm-uri'),
        'getCommandHtml must inject data-xterm-uri so the viewport can lazy-load xterm.js');
    assert.ok(fn.includes('data-xterm-fit-uri'),
        'getCommandHtml must inject data-xterm-fit-uri');
    assert.ok(fn.includes('data-xterm-webgl-uri'),
        'getCommandHtml must inject data-xterm-webgl-uri');
    assert.ok(fn.includes('data-canvas-addon-uri'),
        'getCommandHtml must inject data-canvas-addon-uri');
});

// ── Both hosts inject the terminal token for the command panel ───────

test('the standalone host injects the terminal token for the command panel', () => {
    assert.ok(/id === 'command'/.test(bootstrapSrc),
        'bootstrap.ts must include the command panel in the terminal token injection (id === \'command\')');
    const site = bootstrapSrc.indexOf("id === 'command'");
    assert.ok(site > -1, 'bootstrap.ts must reference the command panel id');
    // Scoped to the whole injection arm, not a hand-guessed byte window: the
    // attribute sits ~2.6 KB past the id test, behind the block comment that
    // explains the CSP reasoning. A 800-byte window stopped short and the
    // assertion failed on correct code.
    const arm = bootstrapSrc.slice(site, site + 4000);
    assert.ok(/data-terminal-token/.test(arm),
        'the standalone host must inject data-terminal-token for the command panel — without it every /ws/terminal upgrade 401s');
});

test('the extension host injects the terminal token for the command panel', () => {
    assert.ok(/id === 'command'/.test(taskViewerSrc),
        'TaskViewerProvider.ts must include the command panel in the terminal token injection');
    const site = taskViewerSrc.indexOf("id === 'command'");
    assert.ok(site > -1, 'TaskViewerProvider.ts must reference the command panel id');
    // Same reasoning as the standalone check above: the attribute is ~3.2 KB
    // past the id test, behind the CSP block comment.
    const arm = taskViewerSrc.slice(site, site + 4000);
    assert.ok(/data-terminal-token/.test(arm),
        'the extension host must inject data-terminal-token for the command panel');
});

// ── Viewport features fire in the command-view embedding ──────────────

test('the viewport sends resize on connect with t:resize, cols/rows >= 1', () => {
    // The viewport module's fitAndReportSize sends the resize frame. This
    // is the same code path the desktop terminals panel uses; the command
    // view's deps bag provides a real fitLadderGen and terminalsMap, so
    // the resize vote fires.
    assert.ok(viewportJs.includes("t: 'resize'"),
        'the viewport module must send t:resize frames');
    const fn = block(viewportJs, 'function fitAndReportSize(', 'function releaseSizeVote(');
    assert.ok(fn.includes('cols') && fn.includes('rows'),
        'fitAndReportSize must report cols and rows');
});

test('the viewport requests replay through lastSeq', () => {
    assert.ok(viewportJs.includes('lastSeq'),
        'the viewport module must track lastSeq for replay');
    assert.ok(viewportJs.includes('&lastSeq='),
        'the viewport module must request replay through &lastSeq= on reconnect');
});

test('the viewport arms answerback suppression during replay', () => {
    assert.ok(viewportJs.includes('suppressAnswerback'),
        'the viewport module must arm answerback suppression during scrollback replay');
    assert.ok(viewportJs.includes('isAnswerback'),
        'the viewport module must have an answerback detector to filter replies during replay');
});

// ── Rendered output: the command panel carries the xterm attributes ──

test('the rendered command panel carries the xterm body data-attributes', () => {
    const { getPanelHtmlById } = require(path.join(REPO_ROOT, 'out', 'services', 'headlessPanelHtml.js'));
    const result = getPanelHtmlById('command', REPO_ROOT, REPO_ROOT, {});
    assert.ok(result && result.html, 'the command panel must render');
    const html = result.html;
    assert.ok(/data-xterm-uri="\/static\/webview\/vendor\/xterm\/xterm\.js"/.test(html),
        'the rendered command panel must carry data-xterm-uri on the body tag');
    assert.ok(/data-xterm-fit-uri/.test(html),
        'the rendered command panel must carry data-xterm-fit-uri');
    assert.ok(/data-canvas-addon-uri/.test(html),
        'the rendered command panel must carry data-canvas-addon-uri');
    assert.ok(/data-panel="command"/.test(html),
        'the rendered command panel must carry data-panel="command"');
});

test('the rendered command panel carries the terminal token on the real body tag', () => {
    const { getPanelHtmlById, injectBodyAttributes } = require(path.join(REPO_ROOT, 'out', 'services', 'headlessPanelHtml.js'));
    const result = getPanelHtmlById('command', REPO_ROOT, REPO_ROOT, {}, 'cyber-theme-enabled');
    const html = injectBodyAttributes(result.html, `data-terminal-token="${'a'.repeat(64)}"`);
    const headEnd = html.search(/<\/head\s*>/i);
    assert.ok(headEnd > -1, 'panel HTML must have a </head>');
    const bodyMatch = /<body\b[^>]*>/i.exec(html.slice(headEnd));
    assert.ok(bodyMatch, 'panel HTML must have a <body> tag after </head>');
    const tag = bodyMatch[0];
    assert.ok(/data-terminal-token="a{64}"/.test(tag),
        'the command panel must render the token on its real body tag — command.js reads document.body.dataset.terminalToken, and without it every /ws/terminal upgrade 401s');
    assert.ok(!/data-terminal-token/.test(html.slice(0, headEnd)),
        'the token must not be injected into <head>');
});

if (failed > 0) {
    console.error(`\n${failed} contract check(s) failed.\n`);
    process.exit(1);
}
console.log(`\nAll ${passed} mobile terminal key bar checks passed.\n`);
