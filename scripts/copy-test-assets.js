#!/usr/bin/env node
'use strict';

/**
 * Copy the plain-`.js` sources under `src/` into `out/`, after `tsc`.
 *
 * WHY THIS EXISTS. `compile-tests` is `tsc -p tsconfig.test.json`, and that
 * config sets no `allowJs` — so TypeScript does not see a `.js` file under
 * `src/`, let alone emit one. `src/services/kanbanColumnDerivationImpl.js` is
 * exactly that: a plain `.js` module, `require`d at load time by the compiled
 * `out/services/kanbanColumnDerivation.js`, which `KanbanProvider` imports at
 * the top of the file.
 *
 * So on any tree where `out/` was not hand-patched, every contract suite that
 * drives the real compiled services dies before its first assertion:
 *
 *     Error: Cannot find module './kanbanColumnDerivationImpl.js'
 *
 * That is not hypothetical. Several suites already carry a hand-rolled copy
 * shim in their own preamble to work around it, and CI runs only
 * `npm run compile-tests` — nothing there has ever produced the file, so the
 * suites that lack the shim are red on a fresh checkout for a reason that has
 * nothing to do with what they assert. Copying the file once, here, is the fix
 * those shims were each approximating.
 *
 * Deliberately narrow: `src/services/**` + `.js`, mirrored to `out/services/**`,
 * and nothing else. That is the only tree whose plain `.js` files are `require`d
 * by compiled output. The two trees left alone are left alone ON PURPOSE:
 *
 *   - `src/test/**` — the suites run straight from `src/`, and `.vscode-test.mjs`
 *     globs `out/test/*.test.js`. Copying there would silently enrol a set of
 *     suites into the VS Code test job that has never run them.
 *   - `src/webview/**` — webpack owns those; nothing `require`s them from `out/`.
 *
 * A file that TypeScript DID emit is never overwritten — if both `x.ts` and
 * `x.js` exist, the compiler's output wins and the copy is skipped, so this can
 * never clobber a build artifact with a stale sibling.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'services');
const OUT = path.join(ROOT, 'out', 'services');

/** Every `.js` file under `dir`, recursively, as paths relative to SRC. */
function collect(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { collect(full, acc); continue; }
        if (!entry.isFile() || !entry.name.endsWith('.js')) { continue; }
        acc.push(path.relative(SRC, full));
    }
    return acc;
}

if (!fs.existsSync(SRC)) {
    console.error('[copy-test-assets] no src/services directory — nothing to copy');
    process.exit(1);
}
if (!fs.existsSync(OUT)) {
    // `tsc` emitted nothing, which is a compile failure the caller already saw.
    // Saying so beats creating an empty tree that looks like a successful build.
    console.error('[copy-test-assets] no out/services directory — run compile-tests first');
    process.exit(1);
}

let copied = 0;
let skipped = 0;
for (const rel of collect(SRC)) {
    // A `.js` beside its own `.ts` is TypeScript's output, not an asset.
    if (fs.existsSync(path.join(SRC, rel.replace(/\.js$/, '.ts')))) { skipped++; continue; }
    const dest = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(SRC, rel), dest);
    copied++;
}

console.log(`[copy-test-assets] copied ${copied} plain .js file(s) into out/services/${skipped ? ` (${skipped} skipped — tsc owns them)` : ''}`);
