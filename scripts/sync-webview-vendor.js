#!/usr/bin/env node
/**
 * Sync vendored browser-panel assets out of node_modules.
 *
 * WHY THIS EXISTS
 * The Terminals panel loads xterm.js with plain `<script nonce>` tags (no bundler
 * — see the panel plan's resolved assumptions), and `_handleServeStatic` resolves
 * `/static/webview/...` against `dist/webview` THEN `src/webview`. So a dev flow
 * with no dist build needs the assets under `src/webview/vendor/`, while the
 * shipped package needs them under `dist/webview/vendor/`.
 *
 * The tempting fix — hand-copy the files into `src/` and commit them — creates two
 * copies that silently diverge the moment `@xterm/xterm` is bumped: webpack's
 * CopyPlugin refreshes dist, nothing refreshes src. That is exactly what the plan
 * forbade. So: node_modules is the ONE source of truth, both destinations are
 * GENERATED, and `src/webview/vendor/` is gitignored. Bumping the dependency and
 * re-running the build refreshes both, or fails loudly here.
 *
 * Run automatically by `npm run compile` / `watch` / `pretest`.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

/** [from-node_modules-relative, to-vendor-relative] */
const ASSETS = [
    ['@xterm/xterm/lib/xterm.js', 'xterm/xterm.js'],
    ['@xterm/xterm/css/xterm.css', 'xterm/xterm.css'],
    ['@xterm/addon-fit/lib/addon-fit.js', 'xterm/addon-fit.js'],
];

// src/ ONLY. `dist/webview/vendor/` is owned by webpack's CopyPlugin, which is
// already part of the build pipeline — one writer per destination, both fed from
// the same node_modules source. Writing dist here as well would leave two writers
// for one path and no way to tell which produced a given file.
const DESTS = [
    path.join(REPO_ROOT, 'src', 'webview', 'vendor'),
];

let copied = 0;
const missing = [];

for (const [rel, dest] of ASSETS) {
    const src = path.join(REPO_ROOT, 'node_modules', rel);
    if (!fs.existsSync(src)) {
        missing.push(rel);
        continue;
    }
    for (const root of DESTS) {
        const target = path.join(root, dest);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(src, target);
        copied++;
    }
}

if (missing.length > 0) {
    // Loud, not silent: a missing vendor asset renders the Terminals panel inert
    // with only a console warning in the browser. Better to fail the build.
    console.error(`[sync-webview-vendor] MISSING from node_modules:\n  ${missing.join('\n  ')}`);
    console.error('[sync-webview-vendor] Run `npm install` (xterm packages are regular dependencies).');
    process.exit(1);
}

console.log(`[sync-webview-vendor] synced ${copied} file(s) into src/webview/vendor from node_modules (dist is handled by webpack CopyPlugin).`);
