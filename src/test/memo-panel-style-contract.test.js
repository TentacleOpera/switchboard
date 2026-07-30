'use strict';
/**
 * Contract: the browser Memo panel uses the shared panel token set, and the
 * DEFAULT theme class does not repaint it.
 *
 * The regression this locks down: `cyber-theme-enabled` is what
 * getThemeBodyClass() returns for afterburner — the DEFAULT theme — so any
 * text/background/accent override under that selector ships as the look most
 * users see. memo.html previously repainted all text cyan and the accent pink.
 */
const assert = require('assert');
const path = require('path');
const { getMemoHtml } = require('../../out/services/headlessPanelHtml');

const REPO_ROOT = path.join(__dirname, '..', '..');
const { html } = getMemoHtml(REPO_ROOT, '/tmp/ws', undefined, 'cyber-theme-enabled');

// Canonical tokens present; ad-hoc ones gone.
assert.match(html, /--accent-primary:\s*#00e5ff/i);
assert.match(html, /--font-mono:/);
assert.match(html, /--accent-green:\s*#4ec9b0/i);
assert.match(html, /--accent-red:\s*#f85149/i);
assert.ok(!/#00f0ff/i.test(html), 'non-canonical accent #00f0ff still present');
assert.ok(!/#d97706/i.test(html), 'amber claudify accent still present (canon: #D97757)');
assert.ok(!/strip-btn/.test(html), 'ad-hoc .strip-btn still present');

// The default theme class must not override text/bg/accent.
const cyberBlock = (html.match(/body\.cyber-theme-enabled\s*{[^}]*}/) || [''])[0];
assert.ok(!/--text-primary|--bg-color|--accent-teal|--text-secondary/.test(cyberBlock),
    'cyber-theme-enabled (the DEFAULT theme class) repaints the panel');

// Claudify redeclares the derived teal family, not just the primary.
const claudifyBlock = (html.match(/body\.theme-claudify\s*{[^}]*}/) || [''])[0];
assert.match(claudifyBlock, /--accent-teal:\s*#D97757/i);
// ...and neutralises the teal-green section label (setup.html:53-56 pattern).
assert.match(html, /body\.theme-claudify\s+\.section-label\s*{[^}]*color:/i);

// Ids memo.js and transport.js select on.
for (const id of ['memo-textarea', 'memo-status', 'memo-clear-btn', 'memo-copy-btn', 'memo-send-btn']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
}
// Transport shim anchor survives.
assert.ok(html.includes('/static/webview/transport.js'), 'transport shim not injected');
// The injected body attributes still land (bare <body> in source).
assert.match(html, /<body[^>]*data-initial-workspace-root=/);

console.log('memo-panel-style-contract: OK');
