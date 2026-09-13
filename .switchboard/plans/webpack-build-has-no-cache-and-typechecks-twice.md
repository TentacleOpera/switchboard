# The Webpack Build Has No Cache, Type-Checks Everything Twice, and Always Builds Both Bundles

## Goal

`npm run compile` reuses work between runs, type-checks once instead of twice, and can build one
bundle when only one is wanted. The release output produced by `npm run package` is unchanged.

### Problem analysis

Measured on a Raspberry Pi 400 (4 cores, 3.7 GB) on 2026-09-06: a single `npm test` put webpack at
582 MB RSS and 167% CPU with a run queue of 5–8, and it was still going minutes later. The Pi is a
supported deployment now, so a build that is merely slow on a workstation is a wall there. Four
things in `webpack.config.js` account for most of it, and none of them is a trade-off anyone chose
— they are defaults nobody has revisited.

**1. There is no cache. At all.** The word `cache` appears **zero times** in `webpack.config.js`,
and `node_modules/.cache` does not exist. Every build is cold: 184 TypeScript files parsed,
type-checked and emitted from scratch, every single time, including a rebuild after a one-line
edit. webpack 5 ships a persistent filesystem cache and it is off.

**2. Type-checking happens twice per `npm test`.** `ts-loader` is configured with only
`compilerOptions: { noEmit: false }` — no `transpileOnly` — so it runs a full type-check inside the
bundling pass. But the pretest chain is `compile-tests && compile && lint`, and `compile-tests` is
`tsc -p tsconfig.test.json`, whose `include` is `["src/**/*"]`. So `tsc` has already type-checked
every file webpack is about to type-check again, seconds earlier, in the same command.

**3. Both bundles build every time.** `module.exports = [extensionConfig, standaloneConfig]` —
the extension bundle from `./src/extension.ts`, and the standalone bundle from `cli.ts` and
`ptyHost.ts` into `dist/standalone`. Every `npm run compile` builds both, even when the work only
touched one. `standaloneConfig` already declares `name: 'standalone'`, so `--config-name` is one
`name` field away from working; `extensionConfig` has none.

> **Superseded:** "`extensionConfig` has none" — i.e. change #3's instruction to "Add `name: 'extension'`".
> **Reason:** `extensionConfig` already has `name: 'extension'` at `webpack.config.js:14`. The plan was written against an older state of the file; the name has since been added. Only the npm scripts for single-bundle builds are still missing.
> **Replaced with:** Change #3 is reduced to: add `compile:extension` / `compile:standalone` npm scripts that pass `--config-name`. The `name` fields on both configs are already in place.

**4. Full source maps on every dev build.** Both configs set
`devtool: 'nosources-source-map'` for 184 files. `package` already overrides it with
`hidden-source-map`, so the dev value is paid on every iteration and consumed almost never.

**Why this is worth a card rather than a tweak — and a correction about `dist/`.** `CLAUDE.md`
states `dist/` is not used during development or testing, because the extension is tested through
an installed VSIX. **That is true of the extension host and false of the standalone host.** The
standalone board executes `dist/standalone/cli.js` directly — verified on the Pi, where
`readlink -f $(which switchboard)` resolves to exactly that path, and where a rebuild at 08:32 on
2026-09-06 is what put the current code into the running board.

So on a standalone deployment the build is not waste: it is how the host is updated. `npm run
compile` is the deploy step there, not a release-only chore. The consequence for this card is that
build time on a Pi is on the critical path of *changing anything*, not just of cutting a release —
which raises the value of every change below rather than lowering it.

What remains true is that `npm test`'s pretest chain rebuilds unconditionally, so a test run pays
for a deploy nobody asked for. That is a separate problem about which command agents are told to
run.

## Metadata

- **Complexity:** 3
- **Tags:** build, devops, performance, infrastructure
- **Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine

- Adding `cache: { type: 'filesystem', buildDependencies: { config: [__filename] } }` to both configs — boilerplate webpack 5 config.
- Adding `transpileOnly: true` to ts-loader options — one line, with a safety comment.
- Adding `compile:extension` / `compile:standalone` npm scripts using the already-present `name` fields.
- Reducing `devtool` on both configs for the non-release path.

### Complex / Risky

- **The type-checking gap.** `transpileOnly` removes type-checking from webpack. The pretest chain (`compile-tests && compile && lint`) still type-checks via `tsc`. But `npm run package` and `npm run watch` bypass `compile-tests` entirely — a release or a watch session would ship/run untype-checked code unless a separate mechanism covers them. This is the one decision that must not be deferred: either add `tsc` to `package`, or attach `fork-ts-checker-webpack-plugin` (a new dependency) to the configs. Getting this wrong silently ships untype-checked code.
- **Cache invalidation on `webpack.config.js` edits.** Without `buildDependencies`, editing the config does not invalidate the cache — the next build silently uses stale settings. `buildDependencies` is mandatory, not optional.

## Edge-Case & Dependency Audit

1. **The release artifact must not change.** These are build-time settings, but `transpileOnly`
   changes what fails the build and cache staleness changes what is emitted. Verify `npm run
   package` output is functionally identical, not just that it succeeds.
2. **Cache invalidation on dependency changes.** A `node_modules` update must invalidate. webpack's
   default hashing covers resolved module content; confirm rather than assume, because a stale
   cache after a dependency bump is a genuinely confusing failure.
3. **`node_modules/.cache` on an SD card.** The cache trades disk writes for CPU, and the Pi has
   already written 18.3 GB in 13 hours to an SD card. This is still the right trade — a cache write
   is far cheaper than a full rebuild's read-and-write — but the cache directory should be on the
   same volume the operator later moves to SSD, not somewhere else.
4. **`sync-webview-vendor.js` runs before webpack** in `compile`, `watch` and `package` alike, and
   is outside all of this. Do not fold it into the cache story.
5. **Both hosts, and the standalone bundle is a live artifact.** `webpack.config.js` builds the
   extension bundle *and* the standalone bundle, so every change here lands on both by
   construction. Change 3 must not make it possible to release having built only one — and note
   that `dist/standalone/cli.js` is what a standalone host runs, so a stale or wrongly-cached
   standalone bundle is a live board running old code, not merely a bad release artifact. That is
   the strongest reason `buildDependencies` in change 1 is mandatory rather than advisable.
6. **Not a bundler migration.** No swc, no esbuild, no loader replacement. Those are a different
   card with a different risk profile; everything here is configuration of the bundler already in
   use.

## Dependencies

None.

## Adversarial Synthesis

Key risks: `transpileOnly` silently removes type-checking from the `package` and `watch` paths (which bypass `compile-tests`), so a release could ship untype-checked code unless a separate type gate is attached; cache staleness after a `webpack.config.js` or `node_modules` change produces fast-but-wrong builds if `buildDependencies` is omitted or hashing assumptions don't hold. Mitigations: `buildDependencies` is mandatory in change 1; the type-gate gap is an Outstanding Question that must be resolved before the change lands, not after.

## Proposed Changes

### 1. Turn on the filesystem cache, on both configs

```js
cache: {
    type: 'filesystem',
    buildDependencies: { config: [__filename] }
}
```

`buildDependencies` is not optional: without it, editing `webpack.config.js` does not invalidate
the cache and the next build silently uses stale settings — a wrong result that looks like a fast
one, which is worse than a slow build.

### 2. `transpileOnly: true`, with the type gate stated

Add it to the `ts-loader` options. This is safe **only** because `tsc -p tsconfig.test.json`
already covers `src/**/*` and runs first in the pretest chain — record that dependency in a comment
beside the option, because the safety is entirely in that ordering and nothing enforces it.

Two paths then need checking rather than assuming:

- **`npm run package` / `vscode:prepublish`.** These do not run `compile-tests`. A release must not
  ship code that was never type-checked, so either add the `tsc` step to `package` or attach
  `fork-ts-checker-webpack-plugin` to that config. Decide and state which.
- **`npm run watch`.** Same exposure: it calls `compile`'s webpack directly. Losing in-editor type
  errors during a watch is a real regression for anyone using it; `fork-ts-checker` in watch mode
  is the usual answer if this bites.

### 3. Add npm scripts for single-bundle builds (names already in place)

Both configs already have `name` fields (`extensionConfig.name = 'extension'`, `standaloneConfig.name = 'standalone'`). Add npm scripts — e.g. `compile:extension` and `compile:standalone` — that pass `--config-name` so `webpack --config-name standalone` builds only what standalone work touched. Leave the default `compile` building both — a partial build must be something asked for, not the new default, or a release eventually ships a stale half.

### 4. Cheaper source maps for dev builds only

Reduce `devtool` on both configs for the non-release path. `package` overrides it with
`hidden-source-map` on the command line and stays exactly as it is. Pick the cheapest value that
still gives usable stack traces for `target: 'node'`, and say which and why in a comment — a
devtool chosen silently is the reason the current one has never been reconsidered.

## Verification Plan

1. Time `npm run compile` on the Pi cold, then again with no source change, then again after a
   one-line edit. Record all three before and after. The second and third must improve
   substantially; the first is expected not to.
2. `node_modules/.cache` exists after a build and is reused on the next.
3. Editing `webpack.config.js` invalidates the cache — change a setting with an observable effect
   on output and confirm the next build reflects it.
4. A deliberate type error in `src/` still fails `npm test`, via `compile-tests`.
5. The same type error still fails the release path, by whichever mechanism change 2 chose.
6. `webpack --config-name standalone` builds only `dist/standalone`, leaving the extension bundle's
   mtime untouched; `--config-name extension` does the converse.
7. `npm run compile` with no arguments still builds both.
8. `npm run package` produces a working VSIX, and its `devtool` is still `hidden-source-map`.
9. `npm run watch` still reports type errors, or the card records the decision that it does not and
   why that is acceptable.
10. `npm run package` builds **both** bundles (extension + standalone), not just one — guards against a partial-build default leaking into the release path.

### Goal Invariants

- **Positive:** `node_modules/.cache` exists after `npm run compile` and is reused on a subsequent no-change build (mtime unchanged or cache hit logged).
- **Positive:** `webpack.config.js` contains `transpileOnly: true` in the ts-loader options.
- **Positive:** A deliberate type error in `src/` fails `npm test` (via `compile-tests`).
- **Positive:** `npm run package` builds both `dist/extension.js` and `dist/standalone/cli.js`.
- **Negative:** `npm run package` does NOT produce a VSIX containing untype-checked code — the type gate (whichever change 2 chose) catches a deliberate type error on the release path.
- **Positive:** `package.json` contains `compile:extension` and `compile:standalone` scripts using `--config-name`.

## Outstanding Questions

- **[user]** Which type-gate mechanism covers `npm run package` and `npm run watch` (which bypass `compile-tests`) after `transpileOnly` is enabled — add `tsc` to `package`, or attach `fork-ts-checker-webpack-plugin`? — proceeding on the assumption that `fork-ts-checker-webpack-plugin` is attached to both configs, because it covers `package` and `watch` uniformly without changing the script chain, and the pretest `tsc` already covers `npm test`.
