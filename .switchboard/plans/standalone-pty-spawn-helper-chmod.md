# Standalone PTY: the darwin spawn-helper chmod never runs under the bundler

## Goal

Fix `require.resolve('node-pty/package.json')` in the standalone PTY backend, which webpack rewrites
to a numeric module id — so the macOS `spawn-helper` chmod is skipped on every boot and terminals
depend on a permission bit the installer happens to leave behind.

### Root problem / background (reproduced 2026-08-04 on two separate builds)

Every standalone boot logs:

```
[PtyBackend] Failed to chmod darwin spawn-helper: TypeError [ERR_INVALID_ARG_TYPE]:
  The "path" argument must be of type string. Received type number (80)
    at Object.dirname (node:path:1442:5)
    at d (.../dist/standalone/cli.js:3:3127323)
    at t.isPtyAvailable (.../dist/standalone/cli.js:3:3127049)
```

The code, `src/standalone/ptyBackend.ts:7-24`:

```ts
function getPtyModule(): typeof import('node-pty') {
    if (!ptyModule) {
        ptyModule = require('node-pty');
        if (process.platform === 'darwin') {
            try {
                const nodePtyDir = path.dirname(require.resolve('node-pty/package.json'));
                const arch = process.arch;
                const helperPath = path.join(nodePtyDir, 'prebuilds', `darwin-${arch}`, 'spawn-helper');
                if (fs.existsSync(helperPath)) {
                    fs.chmodSync(helperPath, 0o755);
                }
            } catch (err) {
                console.warn('[PtyBackend] Failed to chmod darwin spawn-helper:', err);
            }
        }
    }
    return ptyModule!;
}
```

Root cause: **webpack rewrites `require.resolve` to its own module-id resolver**, which returns a
number, not a filesystem path. The observed values differ per build (`94664` on the Aug 3 bundle, `80`
after a rebuild) — exactly what a bundler module id looks like, and proof this is a bundling artifact
rather than a bad install. `path.dirname(80)` throws, the `catch` swallows it, and **`fs.chmodSync` is
never reached**.

Why it is not currently visible: `isPtyAvailable()` (`:42-53`) only cares whether `require('node-pty')`
loads, and it does — so `ptyAvailable` is `true`, the Terminals rail is advertised, and PTYs spawn
fine. Verified empirically: `POST /terminals/verb/ptyCreateTerminal {"role":"shell"}` returned
`{"success":true,...,"status":"active"}` with a live pid. Terminals work **because the `+x` bit already
survived `npm install` on this machine**, not because the code put it there.

The failure this leaves armed: any distribution path that loses the executable bit — `npm pack`/unpack,
a zip or tarball artifact, a CI-built package, a restore from a backup that drops modes, copying
`node_modules` across filesystems — produces a `node-pty` whose `spawn-helper` is not executable.
`pty.spawn` then fails at `PtyTerminalBackend.create:75`, every terminal creation dies, and the only
clue in the log is this warning, which reads like an unrelated chmod nicety rather than "the thing that
was supposed to prevent this never ran". The comment block at `:28-41` shows the author was careful
about exactly this class of problem ("a present-but-unloadable binary counts as unavailable") — the
guard just cannot fire.

This is standalone-only: `ptyBackend.ts` lives under `src/standalone/` and the extension host uses VS
Code's own terminals.

## Metadata
- **Tags:** bugfix, reliability, cli, infrastructure
- **Complexity:** 3
- **Project:** browser-switchboard

## User Review Required (decisions, with defaults)

1. **How should the path be resolved instead?**
   **Default (recommended): `__non_webpack_require__.resolve('node-pty/package.json')`**, guarded by a
   `typeof` check with a fallback to walking up from `require('node-pty')`'s own known location. Webpack
   leaves `__non_webpack_require__` alone deliberately for exactly this case. A `webpackIgnore` magic
   comment is the alternative but applies to `import()`, not `require.resolve`.

2. **Should a failed chmod be fatal, or reported?**
   **Default: report loudly and continue.** If the bit is already correct the chmod is unnecessary, so
   failing the boot would be wrong. But the message must say what it means — that terminal spawning may
   fail — instead of the current bare TypeError dump.

3. **Should `isPtyAvailable()` actually probe a spawn?**
   **Default: no, out of scope here** — but worth recording. The current probe loads the module; it does
   not prove a PTY can spawn. A real probe (spawn `true`, wait for exit, tear down) would catch the
   EACCES case at boot and let the capability flags be honest. Raise as a follow-up rather than growing
   this fix.

## Complexity Audit

### Routine
- Single function, single expression, plus a clearer warning message.
- The existing `try/catch` and `fs.existsSync` guard structure stays.

### Complex / Risky
- **Bundler-specific behaviour is easy to "fix" untestably.** The bug only manifests in the bundled
  `dist/standalone/cli.js`; running the TypeScript directly through ts-node would resolve correctly and
  show nothing wrong. Any test must assert against the built artifact or the fix cannot be trusted.
- `__non_webpack_require__` is not defined when the file is executed unbundled (tests, ts-node), so a
  naive use breaks the non-bundled path — the `typeof` guard is mandatory, not defensive decoration.

## Edge-Case & Dependency Audit

- **Race Conditions.** `getPtyModule` memoises via `ptyModule`, so the chmod runs at most once per
  process. Two processes racing the same chmod is idempotent.
- **Security.** The code chmods a path derived from module resolution to `0o755`. With resolution
  fixed, the path is computed from the resolved `node-pty` package location and a fixed
  `prebuilds/darwin-<arch>/spawn-helper` suffix, so it cannot be steered by user input. Do not accept
  any part of this path from configuration or a request payload. `0o755` (not `0o777`) is correct.
- **Side Effects.** Writes a file mode inside `node_modules`. That is the intent, and it is what the
  code has always claimed to do; the change is that it will now actually happen. On a read-only
  installation the chmod will fail — hence the report-and-continue decision.
- **Dependencies & Conflicts.** None. `node-pty` remains an optional dependency; nothing about that
  changes.

## Dependencies

- None. (No session IDs cited; IDs are assigned on import.)

## Adversarial Synthesis

**Risk summary.** Tiny change, latent-but-real payoff: today's terminals work by luck of the install,
and the code that was written to remove that luck cannot execute. The main risk is shipping a fix that
is only correct unbundled — the same blind spot that let the bug live — so the verification must run
against `dist/standalone/cli.js`. Secondary risk is a read-only `node_modules` in some deployments,
handled by reporting rather than failing.

## Proposed Changes

### `src/standalone/ptyBackend.ts`

- **Context.** `getPtyModule:7-24`, chmod block `:10-21`; `isPtyAvailable:42-53` and its comment block
  `:28-41`; `PtyTerminalBackend.create:66-81` where the spawn actually happens.
- **Logic.** Resolve `node-pty`'s directory through a require that the bundler does not rewrite, guard
  for the unbundled case, and make the failure message state the consequence.
- **Implementation.**
  ```ts
  function resolveNodePtyDir(): string | undefined {
      // webpack rewrites `require.resolve` to a numeric module id, so the plain call
      // returns a number here and path.dirname() throws — the chmod below then never
      // runs and terminals silently depend on npm having left the +x bit in place.
      try {
          const req: any = typeof __non_webpack_require__ !== 'undefined'
              ? __non_webpack_require__
              : require;
          const resolved = req.resolve('node-pty/package.json');
          return typeof resolved === 'string' ? path.dirname(resolved) : undefined;
      } catch { return undefined; }
  }
  ```
  Use it in `getPtyModule`; when it returns `undefined`, warn with actionable text:
  `'[PtyBackend] could not locate node-pty on disk; skipping the darwin spawn-helper chmod — if terminals fail to spawn, check that node_modules/node-pty/prebuilds/darwin-<arch>/spawn-helper is executable'`.
  Declare `__non_webpack_require__` in the standalone ambient types if it is not already.
- **Edge Cases.** Keep `fs.existsSync` before the chmod (a Linux/Windows install has no such file, and
  the whole block is already `darwin`-only). Keep the outer `try/catch` so a read-only `node_modules`
  warns rather than aborting boot. Preserve the memoisation so this runs once.

### Follow-up note (not implemented here)

- Record in the plan trail that `isPtyAvailable()` proves loadability, not spawnability, and that the
  capability flags (`terminalFleet`, `terminalDispatch`) derive from it. A real spawn probe would make
  those flags honest in the EACCES case; see User Review 3.

## Verification Plan

> Per dispatch directive, no automated tests and no compilation steps are part of this
> verification plan — manual verification only. The bug is bundle-only, so every check below
> runs against a produced `dist/standalone/cli.js` (from whatever build produced the VSIX/
> package under test), never through ts-node — an unbundled run resolves correctly and would
> show nothing wrong.

- **Manual — boot log is clean.** Boot the built CLI (`node dist/standalone/cli.js
  --workspace <scratch> --no-open`) and confirm stdout/stderr contains **no** `Failed to
  chmod darwin spawn-helper` and no `ERR_INVALID_ARG_TYPE`. This is the assertion that
  matters — it is the only one that exercises the bundled path.
- **Manual — the chmod actually happens (darwin).** In a disposable copy of the install,
  `chmod -x node_modules/node-pty/prebuilds/darwin-<arch>/spawn-helper`, boot standalone, and
  confirm (a) the mode is restored to `0o755` and (b) `POST /terminals/verb/ptyCreateTerminal
  {"role":"shell"}` succeeds. Skip on non-darwin. This is the check that proves the latent
  failure is closed. (Live evidence it matters: on this machine the `darwin-x64` helper
  currently sits at `-rw-r--r--` while `darwin-arm64` has `+x` — verified 2026-08-04.)
- **Manual — unbundled path unharmed.** Run the same module resolution unbundled (tests /
  ts-node context) and confirm the `typeof __non_webpack_require__` guard falls through to
  plain `require.resolve` with no new warning output.
- **Manual — memoised once.** With verbose logging, confirm the chmod block runs once across
  repeated PTY availability probes / terminal creations in one process.

## Uncertain Assumptions

- ~~That `__non_webpack_require__` is available in this webpack configuration and target.~~
  **Resolved 2026-08-04:** both webpack configs use `target: 'node'` (`webpack.config.js:14`,
  `:129`), where `__non_webpack_require__` is the documented escape hatch. The `typeof` guard
  remains mandatory for the unbundled path, where the identifier is not defined.
- ~~That `prebuilds/darwin-<arch>/spawn-helper` is still the correct layout for the pinned
  `node-pty` version.~~ **Resolved 2026-08-04 against the installed package:**
  `node_modules/node-pty/prebuilds/{darwin-arm64,darwin-x64,win32-arm64,win32-x64}/spawn-helper`
  exist with exactly this layout. Keep the `fs.existsSync` guard regardless — a future
  version bump could move it.

## Out of Scope

- Making `isPtyAvailable()` a real spawn probe.
- Anything about the extension host's terminals.

## Completion Report

Replaced the webpack-rewritten `require.resolve('node-pty/package.json')` with a guarded `__non_webpack_require__` resolver in `src/standalone/ptyBackend.ts`, falling back to plain `require` when running unbundled. The darwin `spawn-helper` chmod now resolves correctly and warns clearly when the helper cannot be located. The warning text also flags the consequence (terminal spawning may fail) instead of dumping a bare TypeError. No compilation or tests were run per the dispatch directive.
