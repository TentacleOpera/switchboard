---
description: "Feature B · B4 — npx distribution: publish the standalone Switchboard CLI to the npm registry under an ownable name so `npx <name>` fetches and runs THIS headless cockpit for a fresh user. The package is already structurally npx-ready (bin → dist/standalone/cli.js, files includes dist + webview), but the bare name `switchboard` is owned by an unrelated package, and there is no npm prepublish build hook. This plan does the branding rename, the publish pipeline, and the install-from-registry verification — NOT the verb wiring (B1) or the arm conversions (Layer-1)."
---

# Feature B · B4 — npx Distribution (publish the standalone CLI to npm)

## Goal

Make `npx <name>` fetch this Switchboard headless cockpit from the public npm registry and launch it for a user who has never cloned the repo. Today `npx switchboard` runs the CLI only when it is already installed locally; a fresh machine gets the *wrong* package.

### Problem / root-cause analysis (verified 2026-07-22)

The package is **structurally npx-ready** but **not publishable under its current name**:

- `package.json` declares `name: "switchboard"`, `bin: { "switchboard": "./dist/standalone/cli.js" }`, `files: ["dist","src/webview","icons","designs","icon.png","README.md"]`, `private` unset. So the CLI entry + the assets the headless server serves are already packaged.
- **The name is taken.** `npm view switchboard` returns an unrelated package (brynbellomy/jonschlinkert, a composite-event-listener lib, `1.3.0`, "Proprietary", last published ~2024). So `npm publish` under `switchboard` fails with 403 (not the owner), and `npx switchboard` on a fresh machine fetches that library, not this tool.
- **No npm publish build hook.** The only prepublish hook is `vscode:prepublish` (vsce, for the VSIX); there is no npm `prepublishOnly`/`prepare`/`prepack`, so `npm publish` would ship whatever is in `dist/` at that moment (stale-build risk). The `package` script is `webpack --mode production` (the extension bundle); the standalone CLI entry (`dist/standalone/cli.js`, with `vscode` aliased to `src/standalone/vscodeShim.ts`) must be confirmed to build as part of the publish pipeline.
- Per the project PRD's release-phase map, **npx distribution is B4** — separate from B1 (composition-root wiring). This plan is B4.

**De-risking facts already verified:** `sql.js` (the KanbanDatabase engine) is **pure WASM — no native/`node-gyp` build**, so `npx` installs cleanly on any platform; and `vscode` is **not** a runtime dependency (only `@types/vscode` dev), so nothing requires the real `vscode` module at runtime as long as the standalone bundle ships the shim.

**Code-verified this review (2026-07-22):**
- `webpack.config.js` exports an **array** `[extensionConfig, standaloneConfig]` (`webpack.config.js:146`), so `npm run package` / `npm run compile` already builds **both** the extension (`dist/extension.js`) and the standalone CLI (`dist/standalone/cli.js`). The standalone config (`webpack.config.js:107-144`) sets `entry: './src/standalone/cli.ts'`, `output: dist/standalone/cli.js`, `resolve.alias.vscode → src/standalone/vscodeShim.ts`, `node: { __dirname: false }`, and a `BannerPlugin` that prepends `#!/usr/bin/env node`. So the bin shebang + the shim alias are already wired — no new build step is needed, only a hook that **runs** the existing build before pack/publish and asserts the output.
- `__dirname: false` means `__dirname` in the bundled `cli.js` is the **real runtime install path** (not the webpack output dir). `resolveRepoRoot()` (`src/standalone/bootstrap.ts:95-98`) does `path.resolve(__dirname, '..', '..')` → from `node_modules/<pkg>/dist/standalone/cli.js` that resolves to `node_modules/<pkg>/` = the installed package root. So asset resolution works from an install, not just from the repo — but only the clean-dir smoke proves it.
- `staticRoutes` (`src/standalone/bootstrap.ts:402-406`) maps `webview → [dist/webview, src/webview]`, `icons → [icons]`, `designs → [designs]`, all under `repoRoot`. `headlessPanelHtml.findFile` (`src/services/headlessPanelHtml.ts:16-23`) + `getShellHtml`/`getBoardHtml` try `dist/webview/*` then `src/webview/*`. Both roots ship via `files`.
- `sql.js` WASM: `webpack.config.js:94-100` CopyPlugin copies `sql-wasm.js` + `sql-wasm.wasm` into `dist/`. So the WASM ships **in `dist/`** (covered by `files: ["dist"]`) — NOT only "transitively via the dependency." Stronger than the original assumption, but the runtime WASM-load path from an installed layout is only proven by the smoke.
- In-code `npx switchboard` references (8): `src/standalone/cli.ts:8` (usage line), `src/standalone/vscodeShim.ts:7`, `src/standalone/hostServices.ts:10` and `:300`, `src/standalone/planIngestionHost.ts:4`, `src/services/PlanIngestionEngine.ts:5`, `src/services/LocalApiServer.ts:516`, `src/services/TaskViewerProvider.ts:1782`. Plus README + docs site (grep at implementation time).

## Metadata
- **Project:** browser-switchboard
- **Tags:** devops, infrastructure, cli, docs
- **Complexity:** 4
- **Release phase:** B4 (npx distribution). Orthogonal to B1 (verb wiring) — see Dependencies.

## User Review Required
- **The registry name (branding decision — must be settled before build).** The bare `switchboard` is unavailable. Recommendation and options below; the user picks one, then the coder sets `package.json name` accordingly.
  - **Recommended (user-leaning): `@turnzero/switchboard`** (scoped under the existing VS Code publisher `turnzero`). Keeps the identity "switchboard" and the installed command `switchboard`; avoids the `-browser` ambiguity (a `-browser` suffix reads as "a browser *of* switchboards"). Two scope-specific prerequisites the coder MUST handle:
    - **Claim the `@turnzero` npm org first.** An npm scope is an npm *org*, **independent of the VS Code publisher id** — owning `turnzero` on the VS Code marketplace does NOT reserve `@turnzero` on npm. Checked 2026-07-22: `@turnzero/switchboard` is unpublished and no `@turnzero/*` packages exist → the scope appears free; create it (npmjs.com → org, or `npm org create`) before the first publish.
    - **`publishConfig: { access: "public" }`** — scoped packages default to *restricted*; without this, `npm publish` ships private or 403s.
  - **Availability checked (2026-07-22):**
    - `switchboard` — **TAKEN** (unrelated event-listener lib).
    - `switchboard-cli` — **TAKEN** (kaizenaistudios, "Switchboard CLI — governance substrate for AI workflows", ~2 weeks ago) → avoid: taken *and* semantically adjacent (AI-workflow CLI), high confusion risk.
    - `switchboard-browser` — **AVAILABLE** (404). Best-fit unscoped name — mirrors the project identity ("Browser Switchboard" / `browser-switchboard`) and is accurate (it *is* the browser cockpit, no undersell). Longer, but defused by the invocation note below.
    - `switchboard-cockpit` — **AVAILABLE** (404). Accurate, unscoped; slightly less tied to the project name than `-browser`.
    - `switchboard-kanban` — **AVAILABLE** (404). Free but "kanban" undersells the full cockpit (board + project + design + setup + memo).
    - Not checked: `switchboardctl`, `turnzero-switchboard`.
  - **Decision — two good paths:** **(a) scoped `@turnzero/switchboard`** (branding intact, guaranteed ownable) or **(b) unscoped `switchboard-browser`** (matches the project name, bare `npx switchboard-browser`, available). Either keeps the daily command as `switchboard`. Avoid `switchboard` / `switchboard-cli` (taken).
  - **Invocation (settled): install-once is the primary UX; `npx` is the try-it path.** The `bin` command is `switchboard` regardless of the package name, so daily use is a bare `switchboard` after one global install. So the scoped/long name is a one-time install cost, not an every-run tax.
  - **Not-npm fallback** (out of scope, note only): private registry / GitHub Packages if a public name is undesirable — higher user friction (registry config on `npx`).

## Scope

### ✅ IN SCOPE
- **Rename** `package.json` `name` to the chosen name; keep `bin: { "switchboard": "./dist/standalone/cli.js" }` so the command stays `switchboard`. Add `publishConfig: { access: "public" }` (required if scoped). Add/verify publish metadata: `description`, `license`, `repository`, `keywords`, `homepage`; keep `engines.node: ">=22.0.0"` (the `engines.vscode` field is extension-oriented and ignored by npm — harmless, leave or drop).
- **Publish build hook (prepack, not prepublishOnly).** Add a `prepack` script that produces a fresh, working `dist/standalone/cli.js` **with `vscode` aliased to the shim** (the existing `npm run package` already builds it — `webpack.config.js` exports both configs — so the hook runs `npm run package` then asserts). The hook must fail the pack/publish if the standalone bundle is missing or references a real `vscode` require.

  > **Superseded:** Add a `prepublishOnly` (or `prepare`) script that produces a fresh, working `dist/standalone/cli.js`.
  > **Reason:** `prepublishOnly` fires only on `npm publish`, NOT on `npm pack`. This plan's own verification uses `npm pack` to produce the tarball for the clean-dir smoke, so a `prepublishOnly` hook never runs during verification — the smoke would test a stale `dist/` and could pass against stale-but-working code, proving nothing about the publish pipeline. `prepack` fires before BOTH `npm pack` and `npm publish`, so the verification path is self-building and the publish act is gated by the same assertion. (`prepare` was rejected because it also runs on every `npm install`, slowing dev/CI installs.)
  > **Replaced with:** Add a `prepack` script that runs `npm run package` (builds both extension + standalone via the array config) and then asserts `dist/standalone/cli.js` exists and contains no real `vscode` require. Optionally also keep `prepublishOnly` as a redundant publish-only gate, but `prepack` is the load-bearing one.

- **Rewrite the invocation strings**, leading with the **install-once** form as primary — `npm i -g <name>` then bare `switchboard` — and keeping `npx <name>` only as the "try without installing" line. The *command* stays `switchboard`; only the install/fetch name changes. Update: `src/standalone/cli.ts` usage line (`cli.ts:8`), `README.md`, the docs site, and the 8 in-code comment/string references (`vscodeShim.ts:7`, `hostServices.ts:10` + `:300`, `planIngestionHost.ts:4`, `PlanIngestionEngine.ts:5`, `LocalApiServer.ts:516`, `TaskViewerProvider.ts:1782`). Do NOT touch the product name "Switchboard", the `.switchboard/` config dir, or the `[switchboard]` log prefixes.
- **Tarball hygiene.** Confirm `files` includes everything the CLI reads at runtime — `dist/standalone/cli.js`, `dist/webview` (or `src/webview` fallback, both resolved by `headlessPanelHtml.findFile`), `dist/sql-wasm.js` + `dist/sql-wasm.wasm` (copied by webpack CopyPlugin, covered by `files: ["dist"]`), `icons`, `designs`. Verify no source-tree secrets or `.switchboard/` fixtures leak into the tarball.
- **Bin-collision pre-check.** Run `npm view switchboard bin` (and `npm view <chosen-name> bin`) before publishing — the taken `switchboard` package could declare a `bin: switchboard` that collides with this package's `bin` on a user's PATH after `npm i -g`. If it collides, that is a UX hazard to document (not a blocker, since the names differ), not a silent assumption.
- **Install-from-registry verification** via `npm pack` + a clean-dir install-and-run smoke (see Verification Plan).

### ⚙️ OUT OF SCOPE
- The actual `npm publish` credential/2FA step and version-bump policy — a human-run release action (this plan makes it publishable and verifies a dry-run; it does not push to the registry).
- CI auto-publish on tag — a sensible follow-on, not required here.
- B1 verb wiring, Layer-1 arm conversions, node-pty/B3, the browser board itself — all separate.
- Pruning the heavy runtime deps (mermaid/jsdom/docx/stitch-sdk) to shrink the install — noted under Edge Cases, not done here.

## Implementation Steps
1. **Settle the name** (User Review) → set `package.json name` + `publishConfig.access` (if scoped) + publish metadata (`description`, `license`, `repository`, `keywords`, `homepage`).
2. **Add the `prepack` publish build hook.** It runs `npm run package` (already builds `dist/standalone/cli.js` via the array webpack config) and asserts the bundle exists + is vscode-free (grep for `require("vscode")` / `require('vscode')` → expect none; the `resolve.alias.vscode` structurally prevents it, this assert is defense-in-depth against a future config regression). Wire it as `scripts.prepack` in `package.json`.
3. **Bin-collision pre-check:** `npm view switchboard bin` and `npm view <chosen-name> bin`; record results. If `switchboard` (the taken lib) declares a `bin: switchboard`, note the PATH-collision UX hazard in the README.
4. **Swap the `npx switchboard` invocation strings** to `npx <name>` (and lead with `npm i -g <name>` + bare `switchboard`) across `cli.ts:8`, README, docs site, and the 8 in-code references. Leave product name / config dir / log prefixes alone.
5. **`npm pack`** (triggers `prepack` → fresh build + assert); inspect the tarball (`npm tarball` / `tar -tzf`) — `dist/standalone/cli.js`, `dist/webview/*`, `dist/sql-wasm.js` + `.wasm`, `icons`, `designs` present; no `.switchboard/`, tokens, or `.env`.
6. **Clean-dir smoke:** `npm i -g ./<tarball>` (or `npx ./<tarball>`) in an empty temp workspace → the shell + board load, no `vscode` crash, sql.js DB initializes, `/board` serves.
7. Hand off to the human for the credentialed `npm publish` (out of scope here).

## Complexity Audit
### Routine
- `package.json` name/metadata/publishConfig edits.
- Find-replace the ~9 `npx switchboard` invocation strings (8 in-code + cli usage).
- `npm pack` + tarball inspection.
- `npm view <name> bin` pre-check (one command).

### Complex / Risky
- **"Does it run after `npm install`" — the load-bearing risk.** The published CLI must resolve its assets from the installed layout: `resolveRepoRoot()` (`bootstrap.ts:95`) does `path.resolve(__dirname,'..','..')` from `dist/standalone/cli.js` → package root (works because `__dirname: false` keeps the real install path); `headlessPanelHtml.findFile` looks for `dist/webview/*` then `src/webview/*`; `staticRoutes` serves `icons`/`designs`. All are in `files`, but must be verified live from a tarball install, not assumed.
- **`vscode` must not reach a runtime `require`.** It is not a dep, and `resolve.alias.vscode → vscodeShim.ts` structurally rewrites the import at build time, so the bundle cannot contain `require('vscode')`. The `prepack` assert is defense-in-depth against a future config regression that drops the alias — not the primary gate. The primary gate is the smoke not crashing.
- **sql.js WASM resolution from an installed layout.** CopyPlugin copies `sql-wasm.wasm` into `dist/`; the KanbanDatabase loader must find it from the install path. Only the smoke proves this.
- **Scoped-package access.** A scoped name without `publishConfig.access: "public"` publishes restricted (private) or 403s — easy to miss.
- **Bin-name PATH collision (confirmed hazard).** npm resolves global `bin` name conflicts by **last-write-wins clobber** — the newly-installed package's symlink silently overwrites the older one in the global bin dir, with **no warning or prompt** (npm does not partition by scope). If the taken `switchboard` package declares `bin: switchboard`, a user who `npm i -g` both packages gets the last-installed one's binary under the `switchboard` command. Pre-check (`npm view switchboard bin`) + document the hazard in the README.
- **Rename completeness.** A missed `npx switchboard` string in user-facing output/docs tells users the wrong command.

## Edge-Case & Dependency Audit
- **Race Conditions:** none — publish is a one-shot human action; the CLI's runtime concurrency (one-time token, single-writer DB) is unchanged.
- **Security:** the published tarball must not include `.switchboard/` fixtures, tokens, or `.env`; `files` is an allowlist (good), but verify the `npm pack` output. The one-time-token localhost gate is unchanged.
- **Side Effects:** first `npx <name>` run in an empty dir creates `.switchboard/` — expected; document it. The install pulls heavy transitive deps (mermaid/jsdom/docx/stitch-sdk) → a large first-run download; acceptable, flagged for a future prune.
- **Dependencies & Conflicts:** `sql.js` is WASM (no native build — cross-platform clean). `engines.node: ">=22.0.0"` gates old-Node users with a clear npm error. Potential `bin: switchboard` PATH conflict with the taken `switchboard` package (see Bin-collision pre-check).

## Dependencies
- **Orthogonal to B1** (`b1-standalone-bootstrap-wire-design-setup-taskviewer-verbs.md`): B1 makes the Design/Setup/TaskViewer verbs *work* in the standalone server; B4 makes the server *installable*. Either order compiles, but **ship B1 first** (or accept that a freshly-published `npx <name>` serves a cockpit whose Design/Setup panels still 503 until B1 lands). Board + Project(memo) already work, so B4-before-B1 is a partial-but-honest release.
- A2b Layer-1 (return contract) is not required for distribution, but improves what a published build can do over HTTP.
- No session (`sess_…`) dependencies.

## Adversarial Synthesis
**Risk Summary:** Key risks: (1) the publish hook must be `prepack` not `prepublishOnly` — otherwise the `npm pack` verification tests a stale dist and proves nothing about the publish act (CONFIRMED by research); (2) asset + sql.js WASM resolution from an *installed* layout (not the repo) is only proven by the clean-dir tarball smoke, never by inspection; (3) a `bin: switchboard` PATH collision with the taken `switchboard` package is a confirmed last-write-wins clobber hazard with no npm warning. Mitigations: `prepack` gate that builds + asserts vscode-free; an exit-coded `scripts/verify-npx-pack.js` smoke run from a real tarball in a clean temp dir; a `npm view switchboard bin` pre-check + README hazard note.

## Proposed Changes

### `package.json`
- **Context:** Single source of publish truth — `name`, `bin`, `files`, `engines`, `scripts`, `publishConfig`, metadata. Currently `name: "switchboard"` (taken), no `publishConfig`, no `license`/`homepage`, no npm build hook.
- **Logic:**
  - `name` → chosen name (`@turnzero/switchboard` or `switchboard-browser`).
  - Add `publishConfig: { access: "public" }` (required for scoped; harmless for unscoped).
  - Add `license`, `homepage`, `keywords` (append npx/cli terms to the existing `keywords`), `description` (keep/extend the existing one).
  - Add `scripts.prepack`: `npm run package && node scripts/assert-standalone-bundle.js` (assert script below). Optionally `scripts.prepublishOnly` pointing at the same assert for a publish-only redundant gate.
  - Keep `bin: { "switchboard": "./dist/standalone/cli.js" }`, `files`, `engines.node: ">=22.0.0"`, `main`, `contributes` (extension-oriented; ignored by npm, harmless).
- **Implementation:** Edit the `scripts` block (`package.json:792-821`) and the top-level fields (`package.json:1-25`).
- **Edge Cases:** Don't remove `engines.vscode` (extension needs it; npm ignores it). Don't set `private: true` (would block publish). Don't rename `displayName`/`publisher` (VS Code marketplace identity, separate from npm).

### `scripts/assert-standalone-bundle.js` (new)
- **Context:** The `prepack` hook's assertion that the standalone bundle exists and is vscode-free. Defense-in-depth — the webpack alias already prevents `require('vscode')`, but this catches a future config regression that drops the alias.
- **Logic:** Read `dist/standalone/cli.js`; exit 1 if missing, if it lacks the `#!/usr/bin/env node` shebang, or if it contains `require("vscode")` / `require('vscode')` (string grep). Exit 0 otherwise. Print a one-line success.
- **Implementation:** New file under `scripts/`. Pure Node, no deps.
- **Edge Cases:** A dynamic `require(variable)` would evade grep — but the alias rewrites all static `import * as vscode`/`require('vscode')`, and the codebase has no dynamic vscode require (verified by grep). Acceptable.

### `scripts/verify-npx-pack.js` (new — the discriminating check)
- **Context:** The Definition-of-Done check. Proves the published artifact boots from a clean install, not from the repo.
- **Logic:** `npm pack` → capture the tarball path → create a clean temp dir → `npm i -g <tarball>` (or `npx --prefix`/local install) → spawn `switchboard --no-open --port <ephemeral>` in an empty workspace → poll `GET /health` → `GET /board` (with one-time token) → assert board HTML returns + sql.js initializes (no crash) + no `vscode` stderr → exit 0 only on all pass; exit 1 otherwise. Clean up the temp dir + kill the process.
- **Implementation:** New file under `scripts/`. Pure Node (`child_process`, `http`, `fs`, `os`). No test framework.
- **Edge Cases:** Port collisions (use ephemeral `--port 0` + read the actual port from stdout/`api-server-port.txt`). The one-time token must be parsed from stdout. Timeout the boot (10s) so a hang fails the check, not the CI.

### `src/standalone/cli.ts`
- **Context:** The user-facing usage line.
- **Logic:** `usage()` line 8 `Usage: npx switchboard [options]` → lead with `npm i -g <name>` then `switchboard [options]`, keep `npx <name>` as the try-it line.
- **Implementation:** Edit `cli.ts:7-16`.
- **Edge Cases:** Don't change the `[switchboard]` log prefixes or the `bin` command name.

### In-code comment/string references (8 files)
- **Context:** Comments/docs that say `npx switchboard` — accurate today only if installed locally; misleading post-rename.
- **Logic:** Replace `npx switchboard` → `npx <name>` (or `npm i -g <name>` + `switchboard` where it's the primary instruction). Files: `vscodeShim.ts:7`, `hostServices.ts:10` + `:300`, `planIngestionHost.ts:4`, `PlanIngestionEngine.ts:5`, `LocalApiServer.ts:516`, `TaskViewerProvider.ts:1782`.
- **Implementation:** Find-replace per file. Comments only — no logic change.
- **Edge Cases:** Don't touch the product name "Switchboard", `.switchboard/` config dir, or `[switchboard]` log prefixes.

### `README.md` + docs site
- **Context:** Primary user-facing install instructions.
- **Logic:** Lead with `npm i -g <name>` + bare `switchboard`; keep `npx <name>` as the try-without-installing line. Add the "first run creates `.switchboard/`" note. If the bin-collision pre-check found a hazard, document it.
- **Implementation:** Grep `npx switchboard` across `README.md` + `docs/` at implementation time; rewrite each.
- **Edge Cases:** Keep the VS Code extension install path (marketplace) separate from the npm path — they're two hosts.

## Verification Plan

> Per session directives: **no project compilation step and no automated test run** is part of this verification plan. The checks below are packaging/runtime smokes against the built artifact, not `npm run compile` / `webpack` / `tsc` / `npm test`.

### Automated
- **Discriminating check (Definition of Done):** `node scripts/verify-npx-pack.js` — exit code 0 **only if** `npm pack` produces a tarball, a clean-temp-dir global install of that tarball boots the CLI, `GET /health` returns `{status:"ok"}`, `GET /board` returns board HTML, sql.js initializes (no crash), and there is no `vscode` require crash. Exit 1 if any step fails. This discriminates done-from-not-done: an unrenamed package, a missing asset, a stale dist, or a vscode crash all fail it; a passing run means a fresh user can `npm i -g <name>` and get a working cockpit. (The `prepack` hook fires during `npm pack` inside this script, so the build + vscode-free assert are exercised automatically — no separate compile step.)
- **Residual-string check:** `grep -rn "npx switchboard" src README.md docs` (excluding `.switchboard/`) → must be empty. Exit 1 on any match. Fails if the rename was incomplete (the stated goal — "users see the right command" — is unmet even if the smoke passes).
- **Tarball-contents check:** `tar -tzf <tarball> | grep -E 'dist/standalone/cli.js|dist/sql-wasm.wasm|dist/webview/shell.html'` → all present; `tar -tzf <tarball> | grep -E '\.switchboard/|\.env|auth_token'` → empty. Exit 1 on a missing asset or a leakage hit.
- **Name-claim check:** `npm view <chosen-name>` → 404 (unscoped, claimable) or owned-by-your-org (scoped); and `npm view switchboard bin` recorded (bin-collision hazard known, not unknown).

### Manual / behavioral
- On a second machine (or a clean user account), `npm i -g <name>` then run `switchboard` in an empty dir → browser opens, board loads, a plan create/edit round-trip works. Supplements the automated smoke; not the sole acceptance signal.

## Resolved Assumptions

The following external (code-unanswerable) platform-behavior assumptions were flagged during planning and **confirmed by web research (npm docs v7–v10 + npm/cli GitHub issues, 2026-07-22)**. They are now settled — do NOT re-research:
- **npm lifecycle hook semantics (CONFIRMED):** `prepack` fires before both `npm pack` and `npm publish` (and on Git-dependency installs, but NOT on local `npm install`); `prepublishOnly` fires only before `npm publish` and is skipped by `npm pack`. Stable across npm v7–v10. This validates the `prepack`-over-`prepublishOnly` correction — the `npm pack` verification path is self-building under `prepack`, stale under `prepublishOnly`. (`prepare` was rejected because it also fires on every local `npm install`, slowing dev/CI.)
- **Scoped-package publish mechanics (CONFIRMED):** scoped packages default to `restricted` (private); `publishConfig: { access: "public" }` is required to publish publicly (without it, a scoped publish 402s on a free plan); the `@turnzero` npm org must be created on the registry before the first `@turnzero/*` publish (the CLI cannot provision it; a missing org 404s/403s).
- **Global bin collision resolution (CONFIRMED — hazard upgraded):** npm resolves global `bin` name conflicts by **last-write-wins clobber** — the newly-installed package's symlink silently overwrites the older one, with no warning or prompt, no scope partitioning. If the taken `switchboard` package declares `bin: switchboard`, a user installing both packages globally gets the last-installed binary under `switchboard`. The pre-check + README documentation is the mitigation (not a blocker — the package names differ, so a user who wants this one installs this one).
- **`files` allowlist semantics (CONFIRMED):** a `files` array puts npm packing in allowlist-only mode; `.env` / `.switchboard/` are excluded unless explicitly listed. `package.json`, `README.md`, `LICENSE`, and `main`/`bin` targets bypass the allowlist and are always packed.

No code-answerable uncertainties are listed here (asset resolution, sql.js WASM path, vscode-alias behavior, in-code reference locations were all verified against the repo this session and are recorded above as code-verified facts).

## Recommendation
Complexity 4 → **Send to Coder.** Mostly config + a find-replace + a publish hook, but the "runs after install from a tarball," "no vscode in the bundle," and "sql.js WASM resolves from an install" checks are the load-bearing verifications — do them from an actual `npm pack` via `scripts/verify-npx-pack.js`, not by inspection. Use `prepack` (not `prepublishOnly`) so the verification path is self-building. Settle the name first (User Review); `@turnzero/switchboard` is the recommended default.

**Stage Complete:** CREATED
