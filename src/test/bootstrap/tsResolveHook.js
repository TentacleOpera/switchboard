'use strict';

/**
 * Lets a test `await import()` a raw `.ts` source file the way Node's native
 * type-stripping expects: with an explicit extension.
 *
 * src/ imports relative modules WITHOUT an extension (`from './clearReadiness'`) —
 * the form the whole codebase uses and the only one `npm run compile-tests`
 * accepts, since `allowImportingTsExtensions` is incompatible with
 * tsconfig.test.json's `noEmit: false`. Node's ESM resolver does no extension
 * search, so those specifiers do not resolve on their own. This hook supplies
 * the `.ts`.
 *
 * Require this BEFORE the first dynamic import of a TypeScript module.
 */
const path = require('path');
const { registerHooks } = require('module');

let installed = false;

function installTsResolveHook() {
    if (installed) { return; }
    installed = true;
    registerHooks({
        resolve(specifier, context, nextResolve) {
            if (/^\.{1,2}\//.test(specifier) && !path.extname(specifier)) {
                try { return nextResolve(specifier + '.ts', context); } catch { /* fall through */ }
            }
            return nextResolve(specifier, context);
        },
    });
}

module.exports = { installTsResolveHook };
