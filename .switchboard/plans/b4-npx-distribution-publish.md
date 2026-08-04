---
description: "Feature B · B4 — npx distribution: publish the standalone Switchboard CLI to the npm registry under an ownable name so `npx <name>` fetches and runs THIS headless cockpit for a fresh user. The package has a `bin` entry pointing at dist/standalone/cli.js, but NO `files` allowlist, NO `.npmignore`, and no npm build hook — so `npm pack` today falls back to `.gitignore`, which ignores `dist/`. npm force-includes the `bin` and `main` targets past that, but NOTHING beside them: the tarball installs and launches, then dies at the first lazy chunk or missing sql-wasm — while still shipping `src/`, `.switchboard/plans`, `.switchboard/features` and 23 MB of `design_system/`. Broken and leaky at once. This plan does the branding rename, the packaging allowlist, the publish pipeline, and the install-from-registry verification — NOT the verb wiring (B1), the CLI attach/lifecycle work, or the agent entry protocol."
---

# Feature B · B4 — npx Distribution (publish the standalone CLI to npm)

## Goal

Make `npx <name>` fetch this Switchboard headless cockpit from the public npm registry and launch it for a user who has never cloned the repo. Today `npx switchboard` runs the CLI only when it is already installed locally; a fresh machine gets the *wrong* package.

### Problem / root-cause analysis (verified 2026-07-22, re-verified against HEAD 2026-08-04)

The package has a `bin` entry but is **neither publishable under its current name nor packable into a working tarball**:

- `package.json` declares `name: "switchboard"`, `bin: { "switchboard": "./dist/standalone/cli.js" }`, `main: "./dist/extension.js"`, `engines.node: ">=22.0.0"`, `private` unset. So the CLI entry point is declared.
- **The name is taken.** `npm view switchboard` returns an unrelated package (brynbellomy/jonschlinkert, a composite-event-listener lib, `1.3.0`, "Proprietary", last published ~2024). So `npm publish` under `switchboard` fails with 403 (not the owner), and `npx switchboard` on a fresh machine fetches that library, not this tool.
- **There is no `files` allowlist and no `.npmignore`** (verified at HEAD: `grep -n '"files"' package.json` → no match; `ls .npmignore` → No such file). npm's fallback when both are absent is `.gitignore` — and `.gitignore:8` ignores `dist/`. **This is the load-bearing packaging defect of the plan** — not a hygiene checkbox — and its exact shape is nastier than "the build is missing":

  > **Superseded:** "So an `npm pack` today would omit the entire build output the `bin` points at, while packing `src/`, `.switchboard/plans/` …"
  > **Reason:** research (npm docs v10/v11 + `npm-packlist` source, 2026-08-04) confirms npm force-includes an **always-included set** that bypasses all ignore matching: `package.json`, `README*`, `LICENSE*`, the `main` target, and **the `bin` targets**. So `dist/standalone/cli.js` (bin) and `dist/extension.js` (main) *do* ship despite `dist/` being gitignored. Nothing else in `dist/` does. Stating it as "the build is omitted" understates the danger, because a wholly-missing binary fails loudly and immediately.
  > **Replaced with:** today's `npm pack` produces a tarball that **installs, resolves the `switchboard` command, and launches** — then dies at the first lazy `require` of a missing chunk, or on a missing `sql-wasm.wasm`, or serving a blank panel with no `dist/webview/`. A silent-until-runtime failure that looks like an application bug rather than a packaging one. Meanwhile it *still* packs `src/` (unignored), `.switchboard/plans/`, `.switchboard/features/`, `.switchboard/reviews/`, `.switchboard/sessions/`, `designs/`, `icons/`, and `design_system/` (23 MB of source design assets with zero runtime references). Broken and leaky at the same time, in the way least likely to be caught by "did it install?".
- **`.vscodeignore` does not help.** It is a vsce-only filter; npm ignores the file entirely. The carefully-tuned node-pty/`*.map`/`design_system` exclusions it encodes protect the VSIX and nothing else. The npm tarball needs its own allowlist.
- **No npm publish build hook.** The only prepublish hook is `vscode:prepublish` (vsce, for the VSIX); there is no npm `prepublishOnly`/`prepare`/`prepack`, so `npm publish` would ship whatever is in `dist/` at that moment (stale-build risk).
- Per the project PRD's release-phase map, **npx distribution is B4** — separate from B1 (composition-root wiring). This plan is B4.

**Code-verified 2026-08-04 (supersedes the earlier de-risking notes below):**

- `webpack.config.js:173` exports an **array** `[extensionConfig, standaloneConfig]`, so `npm run package` / `npm run compile` already builds **both** the extension (`dist/extension.js`) and the standalone target. No new build step is needed — only a hook that **runs** the existing build before pack/publish and asserts the output.
- `standaloneConfig` (`webpack.config.js:~148-172`) has **two entries**, not one: `{ cli: './src/standalone/cli.ts', ptyHost: './src/standalone/ptyHost.ts' }`, output `dist/standalone/[name].js`, `resolve.alias.vscode → src/standalone/vscodeShim.ts`, `node: { __dirname: false }`, `devtool: 'nosources-source-map'`, `externals: { 'node-pty': 'commonjs node-pty' }`, and a `BannerPlugin` (`raw: true`, `entryOnly: true`) prepending `#!/usr/bin/env node`. So the bin shebang and the shim alias are already wired.
- **The standalone bundle is chunk-split.** `dist/standalone/` at HEAD holds `cli.js` (14.7 MB), `ptyHost.js`, and lazy chunks `1.cli.js`, `2.cli.js` (3.4 MB), `3.cli.js`, `251.cli.js`, `438.cli.js`, `719.cli.js` (1.2 MB), `2.js`, `3.js` (3.4 MB), `438.js`, `719.js` — plus a `.map` beside almost every one (`cli.js.map` alone is 5.2 MB; the directory totals ~36 MB). Shipping `dist/standalone/cli.js` alone produces a CLI that crashes on the first lazy `require`. The chunks are load-bearing; the maps are not.
- The `*.cli.js` chunks are **stale leftovers** from an earlier chunk-naming config (mtimes 22 Jul) sitting beside the current `*.js` chunks (mtimes 2–4 Aug). A tarball built from an un-cleaned `dist/` carries both sets.
- `__dirname: false` means `__dirname` in the bundled `cli.js` is the **real runtime install path** (not the webpack output dir). `resolveRepoRoot()` (`src/standalone/bootstrap.ts:110-113`) does `path.resolve(__dirname, '..', '..')` → from `node_modules/<pkg>/dist/standalone/cli.js` that resolves to `node_modules/<pkg>/` = the installed package root. A second implementation, `resolveRepoRootFromDir()` (`src/services/headlessPanelHtml.ts:147`), is imported by `bootstrap.ts:24` — both must resolve correctly from an install layout, and only the clean-dir smoke proves it.
- `staticRoutes` (`src/standalone/bootstrap.ts:508-513`) maps `webview → [dist/webview, src/webview]`, `icons → [icons]`, `designs → [designs]` under `repoRoot`, plus `stitch → [<workspaceRoot>/.switchboard/stitch]` (workspace-relative, not packaged). `headlessPanelHtml.findFile` + `getShellHtml`/`getBoardHtml` try `dist/webview/*` then `src/webview/*`.
- `sql.js` WASM: `webpack.config.js:94-100` CopyPlugin copies `sql-wasm.js` + `sql-wasm.wasm` into `dist/`. So the WASM ships in `dist/` — provided `dist/` is in the tarball at all, which today it is not.
- **In-repo `npx switchboard` references — 15 sites across 8 files**, not 8 (full grep at HEAD, below). The earlier count and several line numbers were wrong; corrected in Proposed Changes.

> **Superseded:** "**De-risking facts already verified:** `sql.js` (the KanbanDatabase engine) is **pure WASM — no native/`node-gyp` build**, so `npx` installs cleanly on any platform."
> **Reason:** true of `sql.js`, but not true of the package. `node-pty@1.1.0` is a dependency at HEAD (`optionalDependencies`), it is a native module (`scripts.install: "node scripts/prebuild.js || node-gyp rebuild"`), and `standaloneConfig.externals` deliberately leaves it **unbundled** so `dist/standalone/ptyHost.js` resolves it from `node_modules` at runtime.
> **Replaced with:** the platform-split analysis below. `sql.js` is pure WASM and imposes no build; `node-pty` imposes one on Linux only.

**node-pty install behaviour — measured on this machine, not inferred (2026-08-04):**

- **`node-pty@1.1.0` ships prebuilt binaries**, and `scripts/prebuild.js` does **not** check ABI — it checks only whether `prebuilds/<platform>-<arch>/` exists, and `exit(0)`s if so. The binaries are N-API, hence no per-Node-version matrix.
- Coverage in the installed tree: `darwin-arm64`, `darwin-x64`, `win32-arm64`, `win32-x64`. **There is no `linux-*` prebuild.**
- Confirmed empirically: on **Node v26.3.1 (ABI 147)** this workspace has populated `prebuilds/darwin-arm64/{pty.node,spawn-helper}` and **no** `build/Release/*.node` — i.e. the prebuild path was taken and `node-gyp` never ran.
- **Therefore:** macOS and Windows users install from a prebuild with no toolchain requirement. **Linux users fall through to `node-gyp rebuild`** and need Python 3 + `make` + a g++ toolchain, or the optional dependency is skipped.

  > **Superseded (external research, rejected on evidence):** a research pass reported that `node-pty@1.1.0` provides "zero prebuilt binaries for Node 22, 24, or 26", forcing a source build "100% of the time" on this package's supported Node range.
  > **Reason:** contradicted by direct inspection of the installed package on Node 26. The prebuilds exist and were used; the claim appears to assume a per-ABI prebuild matrix that this N-API package does not have. Acting on it would have justified swapping to a prebuilt fork to solve a problem that does not exist on two of three platforms.
  > **Replaced with:** the platform-split finding above. The real gap is **Linux**, and it is narrow enough to document rather than re-architect.

- **The runtime degradation is already built, and this is the second correction.** `src/standalone/ptyBackend.ts:7-23` lazily `require`s node-pty inside `getPtyModule()`, and an `isPtyAvailable()` capability check gates it; `src/standalone/ptyHost.ts:36-39` exits with `[ptyHost] Error: node-pty is unavailable on this system.` rather than throwing `MODULE_NOT_FOUND`. So the "unguarded `require('node-pty')` kills the CLI" trap that generic guidance warns about does **not** apply here. B4's job is to *verify* that gate survives an install-from-tarball on a machine without the module — not to build it. The clean-dir smoke asserts the CLI boots and `/board` serves with node-pty absent, and that the failure surfaces as a capability gap (PRD contract #6 — absent or disabled, never a dead-clicking control).

**Also still true and unchanged:** `vscode` is **not** a runtime dependency (only `@types/vscode` dev), so nothing requires the real `vscode` module at runtime as long as the standalone bundle ships the shim.

## Metadata
- **Project:** Browser Switchboard
- **Tags:** devops, infrastructure, cli, docs
- **Complexity:** 5
- **Release phase:** B4 (npx distribution). Orthogonal to B1 (verb wiring) — see Dependencies.

> **Superseded:** **Complexity:** 4
> **Reason:** re-scored on discovering that `files` does not exist. The plan was scored as "rename + find-replace + one hook"; it is now also "author the package's entire npm allowlist from scratch, against a `dist/` that is gitignored, chunk-split, carries stale artefacts from a previous chunk-naming scheme, and pulls in a native optional dependency." That is a second, independent correctness surface with its own failure mode (a tarball that installs but cannot boot), not a hygiene pass over an existing list.
> **Replaced with:** **Complexity:** 5

## User Review Required
- **The registry name (branding decision — must be settled before build).** The bare `switchboard` is unavailable. Recommendation and options below; the user picks one, then the coder sets `package.json name` accordingly.
  - **Recommended (user-leaning): `@turnzero/switchboard`** (scoped under the existing VS Code publisher `turnzero`). Keeps the identity "switchboard" and the installed command `switchboard`; avoids the `-browser` ambiguity (a `-browser` suffix reads as "a browser *of* switchboards"). Two scope-specific prerequisites the coder MUST handle:
    - **Claim the `@turnzero` npm org first.** An npm scope is an npm *org*, **independent of the VS Code publisher id** — owning `turnzero` on the VS Code marketplace does NOT reserve `@turnzero` on npm. Checked 2026-07-22: `@turnzero/switchboard` is unpublished and no `@turnzero/*` packages exist → the scope appears free; create it (npmjs.com → org, or `npm org create`) before the first publish.
    - **`publishConfig: { access: "public" }`** — scoped packages default to *restricted*; without this, `npm publish` ships private or 403s.
  - **Availability checked (2026-07-22):**
    - `switchboard` — **TAKEN** (unrelated event-listener lib).
    - `switchboard-cli` — **TAKEN** (kaizenaistudios, "Switchboard CLI — governance substrate for AI workflows", ~2 weeks before the check) → avoid: taken *and* semantically adjacent (AI-workflow CLI), high confusion risk.
    - `switchboard-browser` — **AVAILABLE** (404). Best-fit unscoped name — mirrors the project identity ("Browser Switchboard") and is accurate (it *is* the browser cockpit, no undersell). Longer, but defused by the invocation note below.
    - `switchboard-cockpit` — **AVAILABLE** (404). Accurate, unscoped; slightly less tied to the project name than `-browser`.
    - `switchboard-kanban` — **AVAILABLE** (404). Free but "kanban" undersells the full cockpit (board + project + design + setup + memo).
    - Not checked: `switchboardctl`, `turnzero-switchboard`.
    - **Re-check availability at implementation time.** These were checked 2026-07-22; two weeks of registry churn already turned up one adjacent squat (`switchboard-cli`). A name that was 404 then may not be 404 now — the Name-claim check in the Verification Plan is the gate, not this list.
  - **Decision — two good paths:** **(a) scoped `@turnzero/switchboard`** (branding intact, guaranteed ownable) or **(b) unscoped `switchboard-browser`** (matches the project name, bare `npx switchboard-browser`, available). Either keeps the daily command as `switchboard`. Avoid `switchboard` / `switchboard-cli` (taken).
  - **Invocation (settled): install-once is the primary UX; `npx` is the try-it path.** The `bin` command is `switchboard` regardless of the package name, so daily use is a bare `switchboard` after one global install. So the scoped/long name is a one-time install cost, not an every-run tax.
  - **Not-npm fallback** (out of scope, note only): private registry / GitHub Packages if a public name is undesirable — higher user friction (registry config on `npx`).
- **Tarball size — accept or prune (new).** With `dist/` included, the standalone bundle alone is ~20 MB of JS before the extension bundle, `designs/`, `icons/` and `src/webview/`, and the heavy runtime deps (mermaid / jsdom / docx / stitch-sdk) inflate the install further. Excluding `**/*.map` (~9 MB in `dist/standalone/` alone) and the stale `*.cli.js` chunks is uncontroversial and in scope. Genuinely pruning the runtime dependency tree is **not** in scope here. Confirm you are content shipping a large first-run download rather than blocking B4 on a dependency diet.

## Scope

### ✅ IN SCOPE
- **Rename** `package.json` `name` to the chosen name; keep `bin: { "switchboard": "./dist/standalone/cli.js" }` so the command stays `switchboard`. Add `publishConfig: { access: "public" }` (required if scoped). Add/verify publish metadata: `license`, `homepage`, `keywords` (append npx/cli terms to the existing four), keep/extend `description`, keep `repository`; keep `engines.node: ">=22.0.0"` (the `engines.vscode` field is extension-oriented and ignored by npm — harmless, leave it).
- **Author the `files` allowlist — the load-bearing change.** It does not exist today. It must cover every path the CLI reads at runtime and nothing else:
  - `dist/standalone/**` (entry + **all** lazy chunks + `ptyHost.js`)
  - `dist/webview/**` (panel HTML/JS/CSS + the synced xterm vendor assets)
  - `dist/sql-wasm.js`, `dist/sql-wasm.wasm`
  - `icons/**`, `designs/**` (served by `staticRoutes`)
  - `src/webview/**` — the documented fallback root in `headlessPanelHtml.findFile` and `staticRoutes.webview`. Include it **only if** the smoke shows `dist/webview` is not complete on its own; prefer dropping it and proving `dist/webview` suffices, since it is several MB of duplicate.
  - Explicitly **not** `src/**` (beyond the webview decision above), `.switchboard/**`, `design_system/**`, `docs/**`, `.agents/**`, `.claude/**`, `scripts/**`, `out/**`, `*.vsix`.
  - **Exclude source maps with inline `!` negations inside `files` itself** — `npm-packlist` evaluates the array through `minimatch`, so negation entries work natively and keep every packaging decision in one place:
    ```json
    "files": [
      "dist/standalone/**", "dist/webview/**",
      "dist/sql-wasm.js", "dist/sql-wasm.wasm",
      "icons/**", "designs/**",
      "!**/*.map", "!dist/standalone/*.cli.js"
    ]
    ```
    > **Superseded:** "A `files` allowlist has no negation… add an `.npmignore` carrying `**/*.map` alongside `files`."
    > **Reason:** research (npm docs v10/v11 + `npm-packlist` source, 2026-08-04) confirms `files` supports inline `!` negations directly, and that a separate `.npmignore` is the *worse* of the two working options: a root `.npmignore` replaces `.gitignore` as the fallback for everything `files` does not decide, and **a `.npmignore` in any subdirectory overrides the root allowlist** — a build tool or dependency dropping one in silently subtracts wanted files. Inline negation has neither failure mode.
    > **Replaced with:** the single-array form above. No `.npmignore` file is created.

    Still gate it on `npm pack --dry-run` before building the rest of the change — if a future npm drops negation support the failure must be caught at the allowlist step, not after publish. If negations turn out unhonoured, the documented fallback is a root `.npmignore` carrying only `**/*.map`.
  - Note: `package.json`, `README.md`, `LICENSE`, and the `main`/`bin` targets are force-included by npm regardless of the allowlist — which is precisely why the current no-`files` state produces a *launchable but broken* tarball rather than an obviously empty one.
- **Clean `dist/standalone/` before packing.** The stale `*.cli.js` chunk set (Jul 22) must not ride along beside the current `*.js` chunks. The `prepack` hook removes `dist/standalone/` before invoking the build, so the tarball reflects exactly one build.
- **Publish build hook (prepack, not prepublishOnly).** Add a `prepack` script that produces a fresh, working `dist/standalone/cli.js` **with `vscode` aliased to the shim** (the existing `npm run package` already builds it — `webpack.config.js` exports both configs — so the hook cleans, runs `npm run package`, then asserts). The hook must fail the pack/publish if the standalone bundle is missing, is missing its chunk siblings, or references a real `vscode` require.

  > **Superseded:** Add a `prepublishOnly` (or `prepare`) script that produces a fresh, working `dist/standalone/cli.js`.
  > **Reason:** `prepublishOnly` fires only on `npm publish`, NOT on `npm pack`. This plan's own verification uses `npm pack` to produce the tarball for the clean-dir smoke, so a `prepublishOnly` hook never runs during verification — the smoke would test a stale `dist/` and could pass against stale-but-working code, proving nothing about the publish pipeline. `prepack` fires before BOTH `npm pack` and `npm publish`, so the verification path is self-building and the publish act is gated by the same assertion. (`prepare` was rejected because it also runs on every `npm install`, slowing dev/CI installs.)
  > **Replaced with:** Add a `prepack` script that cleans `dist/standalone/`, runs `npm run package` (builds both extension + standalone via the array config) and then asserts the bundle exists, carries its shebang, and contains no real `vscode` require. Optionally also keep `prepublishOnly` as a redundant publish-only gate, but `prepack` is the load-bearing one.

- **Rewrite the invocation strings**, leading with the **install-once** form as primary — `npm i -g <name>` then bare `switchboard` — and keeping `npx <name>` only as the "try without installing" line. The *command* stays `switchboard`; only the install/fetch name changes. Full site list in Proposed Changes. Do NOT touch the product name "Switchboard", the `.switchboard/` config dir, or the `[switchboard]` log prefixes.
- **Bin-collision pre-check.** Run `npm view switchboard bin` (and `npm view <chosen-name> bin`) before publishing — the taken `switchboard` package could declare a `bin: switchboard` that collides with this package's `bin` on a user's PATH after `npm i -g`. If it collides, that is a UX hazard to document (not a blocker, since the package names differ), not a silent assumption.
- **Install-from-registry verification** via `npm pack` + a clean-dir install-and-run smoke (see Verification Plan).

### ⚙️ OUT OF SCOPE
- The actual `npm publish` credential/2FA step and version-bump policy — a human-run release action (this plan makes it publishable and verifies a dry-run; it does not push to the registry).
- CI auto-publish on tag — a sensible follow-on, not required here.
- B1 verb wiring, Layer-1 arm conversions, node-pty/B3, the browser board itself — all separate.
- **The CLI's attach/lifecycle behaviour** (`standalone-cli-attach-and-lifecycle.md`) and **the agent entry protocol** (`standalone-first-launch-instead-of-demanding-an-ide.md`) — sibling subtasks in this feature. B4 supplies the published *name* they consume; it does not change `main()` semantics.
- Pruning the heavy runtime deps (mermaid/jsdom/docx/stitch-sdk) to shrink the install — noted under Edge Cases and User Review, not done here.
- The **switchboard-site docs repo** (`tentacleopera.github.io/switchboard-site`) is a separate repository; this single-repo session updates `README.md` and `docs/` in this repo only. The site's installation page needs the same rename and is tracked as a follow-on.

## Implementation Steps
1. **Settle the name** (User Review) → set `package.json name` + `publishConfig.access` (if scoped) + publish metadata (`license`, `homepage`, `keywords`, `description`). Re-run the availability check at this moment; do not trust the 2026-07-22 snapshot.
2. **Author the `files` allowlist**, source-map exclusion included as inline `!` negations in the same array (no `.npmignore` file). Validate with `npm pack --dry-run` before writing any other change — this is the step most likely to be wrong, and it is cheap to iterate.
3. **Add the `prepack` publish build hook.** It removes `dist/standalone/`, runs `npm run package`, and asserts via `scripts/assert-standalone-bundle.js`. Wire as `scripts.prepack`.
4. **Bin-collision pre-check:** `npm view switchboard bin` and `npm view <chosen-name> bin`; record results. If `switchboard` (the taken lib) declares a `bin: switchboard`, note the PATH-collision UX hazard in the README.
5. **Swap the `npx switchboard` invocation strings** to `npx <name>` (and lead with `npm i -g <name>` + bare `switchboard`) across all 15 sites listed in Proposed Changes. Leave product name / config dir / log prefixes alone.
6. **`npm pack`** (triggers `prepack` → clean + fresh build + assert); inspect the tarball (`tar -tzf`) against the allowlist and the leakage list.
7. **Clean-dir smoke:** `npm i -g ./<tarball>` (or `npx ./<tarball>`) in an empty temp workspace → the shell + board load, no `vscode` crash, sql.js DB initializes, `/board` serves, and node-pty's absence degrades to a disabled terminal capability rather than a crash.
8. Hand off to the human for the credentialed `npm publish` (out of scope here).

## Complexity Audit
### Routine
- `package.json` name/metadata/`publishConfig` edits.
- Find-replace the 15 `npx switchboard` invocation strings.
- `npm view <name> bin` pre-check (one command).

### Complex / Risky
- **Authoring `files` from nothing, against a gitignored `dist/`.** The default (no `files`, no `.npmignore` → fall back to `.gitignore`) is *actively wrong* in both directions at once: npm force-includes the `bin` and `main` targets but nothing beside them, so the CLI ships without its chunks, its WASM, or its panel HTML — and the repo's plans, features, source and 23 MB of `design_system/` ship instead. A partial allowlist reproduces exactly the same shape: a tarball that installs, resolves the command, launches, and *then* crashes on a missing chunk or WASM file — an error that reads as a runtime bug and gets debugged in the wrong place entirely.
- **Chunk completeness.** `dist/standalone/cli.js` is one of twelve files. A `files` entry that names `dist/standalone/cli.js` rather than `dist/standalone/**` yields a CLI that boots and dies at the first lazy `require`. The stale `*.cli.js` set makes "the directory looks right" an unreliable signal — clean before packing.
- **"Does it run after `npm install`" — the load-bearing risk.** The published CLI must resolve its assets from the installed layout: `resolveRepoRoot()` (`bootstrap.ts:110`) and `resolveRepoRootFromDir()` (`headlessPanelHtml.ts:147`) both walk from `__dirname`; `headlessPanelHtml.findFile` looks for `dist/webview/*` then `src/webview/*`; `staticRoutes` serves `icons`/`designs`. Must be verified live from a tarball install, not assumed.
- **`vscode` must not reach a runtime `require`.** It is not a dep, and `resolve.alias.vscode → vscodeShim.ts` structurally rewrites the import at build time, so the bundle cannot contain `require('vscode')`. The `prepack` assert is defense-in-depth against a future config regression that drops the alias — not the primary gate. The primary gate is the smoke not crashing.
- **sql.js WASM resolution from an installed layout.** CopyPlugin copies `sql-wasm.wasm` into `dist/`; the KanbanDatabase loader must find it from the install path. Only the smoke proves this.
- **node-pty on a fresh Linux install — the one platform that compiles.** Native, `optionalDependencies`, webpack-external. macOS and Windows resolve a shipped N-API prebuild and need no toolchain; **Linux has no prebuild** and falls through to `node-gyp rebuild`, needing Python 3 + `make` + g++. On a minimal container or a CI runner that build fails, npm exits 0 with `npm WARN optional`, and the user gets a cockpit with no terminals. The gate (`isPtyAvailable()`) already exists, so this is a *verification* obligation, not a build one — but it must be verified on Linux specifically, since the developer machine is exactly the case that never exercises it.
- **Scoped-package access.** A scoped name without `publishConfig.access: "public"` publishes restricted (private) or 403s — easy to miss.
- **Bin-name PATH collision (confirmed hazard).** npm resolves global `bin` name conflicts by **last-write-wins clobber** — the newly-installed package's symlink silently overwrites the older one in the global bin dir, with **no warning or prompt** (npm does not partition by scope). If the taken `switchboard` package declares `bin: switchboard`, a user who `npm i -g` both packages gets the last-installed one's binary under the `switchboard` command. Pre-check + document.
- **Rename completeness.** A missed `npx switchboard` string in user-facing output/docs tells users the wrong command.

## Edge-Case & Dependency Audit
- **Race Conditions:** none — publish is a one-shot human action; the CLI's runtime concurrency (one-time token, single-writer DB) is unchanged.
- **Security:** with no `files` and no `.npmignore` today, an unguarded `npm pack` would publish `.switchboard/plans/`, `.switchboard/features/`, `.switchboard/reviews/` and `.switchboard/sessions/` — internal planning documents, not code — to a public registry, irreversibly. `.gitignore` does exclude `.env*`, `secrets.enc*`, `.master-key*` and `*.db`, so credentials specifically are covered by the fallback; the exposure is planning content and 23 MB of design source. The `files` allowlist closes it; the tarball-contents check in Verification is the gate. The one-time-token localhost gate is unchanged.
- **Side Effects:** first `npx <name>` run in an empty dir creates `.switchboard/` (`cli.ts:156-159`) — expected; document it. Note the sibling entry-protocol plan deliberately guards *against* this for agent-initiated launches; the bare human `npx` path keeps the current create-on-demand behaviour. The install pulls heavy transitive deps (mermaid/jsdom/docx/stitch-sdk) → a large first-run download; accepted per User Review, flagged for a future prune.
- **Dependencies & Conflicts:** `sql.js` is WASM (no native build). `node-pty@1.1.0` is native but optional (see above). `engines.node: ">=22.0.0"` gates old-Node users with a clear npm error. Potential `bin: switchboard` PATH conflict with the taken `switchboard` package (see Bin-collision pre-check). Shares `src/standalone/cli.ts` with two sibling subtasks — B4 owns `usage()` and lands first (see Dependencies).

## Dependencies
- **Orthogonal to B1** (`b1-standalone-bootstrap-wire-design-setup-taskviewer-verbs.md`): B1 makes the Design/Setup/TaskViewer verbs *work* in the standalone server; B4 makes the server *installable*. Either order compiles, but **ship B1 first** (or accept that a freshly-published `npx <name>` serves a cockpit whose Design/Setup panels still 503 until B1 lands). Board + Project(memo) already work, so B4-before-B1 is a partial-but-honest release.
- **B4 lands first within this feature.** Both sibling subtasks edit `src/standalone/cli.ts`, and B4 owns the `usage()` block (`cli.ts:8-30`) that the attach/lifecycle plan then appends a `stop` line to. Per the PRD's one-stream-per-file discipline, serialise: B4 → `standalone-cli-attach-and-lifecycle.md` → `standalone-first-launch-instead-of-demanding-an-ide.md`. The entry-protocol plan additionally has a *semantic* dependency on B4 (it invokes the published name).
- A2b Layer-1 (return contract) is not required for distribution, but improves what a published build can do over HTTP.
- No session (`sess_…`) dependencies.

## Adversarial Synthesis
**Risk Summary:** Key risks: (1) `package.json` has **no `files` allowlist and no `.npmignore`**, and npm force-includes `bin`/`main` targets past `.gitignore` while force-including nothing beside them — so today's tarball **installs, launches, and then dies** at the first lazy chunk or missing WASM, while simultaneously packing `src/` and `.switchboard/` planning content to a public registry; broken and leaky in the failure mode least likely to be caught by "did it install?"; (2) the standalone bundle is chunk-split across twelve files with stale artefacts from an older chunk-naming scheme, so "ship `cli.js`" is exactly that trap; (3) `node-pty` is native and webpack-external, and while macOS/Windows resolve a shipped N-API prebuild, **Linux has none** and compiles — so the already-built `isPtyAvailable()` degradation must be verified on Linux, the platform a developer machine never exercises. Mitigations: a `files` allowlist with inline `!` negations, validated by `npm pack --dry-run` before any other edit lands; a `prepack` gate that cleans `dist/standalone/`, rebuilds, and asserts the bundle is complete and vscode-free; an exit-coded `scripts/verify-npx-pack.js` smoke run from a real tarball in a clean temp dir; a `npm view switchboard bin` pre-check plus a README hazard note.

## Proposed Changes

### `package.json`
- **Context:** Single source of publish truth — `name`, `bin`, `files`, `engines`, `scripts`, `publishConfig`, metadata. Currently `name: "switchboard"` (taken), **no `files`**, no `publishConfig`, no `license`/`homepage`, no npm build hook.
- **Logic:**
  - `name` → chosen name (`@turnzero/switchboard` or `switchboard-browser`).
  - Add `publishConfig: { access: "public" }` (required for scoped; harmless for unscoped).
  - **Add `files`** per the allowlist in Scope.
  - Add `license`, `homepage`, append npx/cli terms to the existing `keywords`, keep/extend `description`.
  - Add `scripts.prepack`: `node scripts/clean-standalone-dist.js && npm run package && node scripts/assert-standalone-bundle.js`. Optionally `scripts.prepublishOnly` pointing at the same assert as a redundant publish-only gate.
  - Keep `bin: { "switchboard": "./dist/standalone/cli.js" }`, `engines.node: ">=22.0.0"`, `main`, `contributes` (extension-oriented; ignored by npm, harmless).
- **Implementation:** Edit the top-level fields (`package.json:1-25`) and the `scripts` block.
- **Edge Cases:** Don't remove `engines.vscode` (extension needs it; npm ignores it). Don't set `private: true` (would block publish). Don't rename `displayName`/`publisher` (VS Code marketplace identity, separate from npm). Adding `files` changes **nothing** about the VSIX — vsce reads `.vscodeignore`, not `files` — so the ~4,000-install extension is untouched (PRD contract #2).

### `scripts/clean-standalone-dist.js` (new)
- **Context:** `dist/standalone/` accumulates chunks across chunk-naming schemes; at HEAD it holds two generations side by side.
- **Logic:** `fs.rmSync('dist/standalone', { recursive: true, force: true })`. Nothing else — webpack recreates it.
- **Implementation:** New file under `scripts/`. Pure Node, no deps. (A `rimraf`-style inline `node -e` in the `prepack` string is acceptable if a separate file feels heavy; a file is preferred so the intent is greppable.)
- **Edge Cases:** Must not touch `dist/extension.js` or `dist/webview/` — the extension build and the copied vendor assets are produced by the same `npm run package` run but are not the stale surface. Scope the delete to `dist/standalone/` exactly.

### `scripts/assert-standalone-bundle.js` (new)
- **Context:** The `prepack` hook's assertion that the standalone bundle exists, is complete, and is vscode-free. Defense-in-depth — the webpack alias already prevents `require('vscode')`, but this catches a future config regression that drops the alias, and catches a chunk-naming change that silently orphans a lazy import.
- **Logic:** Exit 1 if any of: `dist/standalone/cli.js` missing; it lacks the `#!/usr/bin/env node` shebang; it contains `require("vscode")` / `require('vscode')` (string grep); `dist/standalone/ptyHost.js` missing; the set of `__webpack_require__.e`-referenced chunk ids in `cli.js` is not fully present on disk (or, if that parse is too brittle, assert simply that `dist/standalone/` contains more than the two entry files — the failure this catches is an empty/partial chunk set). Print a one-line success and the file count.
- **Implementation:** New file under `scripts/`. Pure Node, no deps.
- **Edge Cases:** A dynamic `require(variable)` would evade the vscode grep — but the alias rewrites all static `import * as vscode` / `require('vscode')`, and the codebase has no dynamic vscode require (verified by grep). Acceptable. The chunk-id parse must be a soft assert with a clear message, not a regex that fails CI on a webpack minor bump.

### `scripts/verify-npx-pack.js` (new — the discriminating check)
- **Context:** The Definition-of-Done check. Proves the published artifact boots from a clean install, not from the repo.
- **Logic:** `npm pack` → capture the tarball path → create a clean temp dir → install that tarball there → spawn `switchboard --no-open --port 0 --workspace <empty temp workspace>` → poll `GET /health` → `GET /board` with the one-time token → assert board HTML returns, sql.js initializes (no crash), no `vscode` stderr, and the `/panels` manifest reports terminals as **disabled rather than absent-and-crashing** when node-pty did not build → exit 0 only on all pass; exit 1 otherwise. Clean up the temp dir and kill the process.
- **Implementation:** New file under `scripts/`. Pure Node (`child_process`, `http`, `fs`, `os`). No test framework.
- **Edge Cases:** Port collisions (use `--port 0` and read the actual port from stdout / `.switchboard/api-server-port.txt`). The one-time token must be parsed from stdout. Timeout the boot (10s) so a hang fails the check rather than the CI job. Prefer a local (non-global) install into the temp dir over `npm i -g` so the check never clobbers the developer's global `switchboard` bin — the very collision hazard this plan documents.

### `src/standalone/cli.ts` — six sites, not one
- **Context:** The user-facing usage block and two error-path usage strings.
- **Logic:** `usage()` lines **9, 10, 11, 12** (`Usage: npx switchboard [options]` and the three `npx switchboard secrets …` lines) → lead with `npm i -g <name>` then `switchboard [options]` / `switchboard secrets …`, keeping `npx <name>` as the try-it line. Lines **170** and **191** are `console.error('Usage: npx switchboard secrets set|delete …')` on the bad-argument paths → same treatment.
- **Implementation:** Edit `cli.ts:8-30`, `cli.ts:170`, `cli.ts:191`.
- **Edge Cases:** Don't change the `[switchboard]` log prefixes or the `bin` command name. **The sibling attach/lifecycle plan appends a `stop` line to this same `usage()` block** — B4 lands first and defines the format that line follows.

  > **Superseded:** "`usage()` line 8 `Usage: npx switchboard [options]`" (a single site).
  > **Reason:** grep at HEAD returns six occurrences in `cli.ts` (9, 10, 11, 12, 170, 191). Treating it as one line leaves five wrong invocation strings in the CLI's own help and error output — the exact failure the rename exists to prevent.
  > **Replaced with:** the six-site list above.

### In-repo comment/string references (9 further sites across 7 files)
- **Context:** Comments, docs and one test comment that say `npx switchboard` — accurate today only when installed locally; misleading post-rename.
- **Logic:** Replace `npx switchboard` → `npx <name>` (or `npm i -g <name>` + `switchboard` where it reads as the primary instruction). Verified sites at HEAD:
  - `src/extension.ts:672`
  - `src/standalone/vscodeShim.ts:7`
  - `src/standalone/hostServices.ts:10`, `src/standalone/hostServices.ts:313`
  - `src/standalone/planIngestionHost.ts:4`
  - `src/services/PlanIngestionEngine.ts:5`
  - `src/services/TaskViewerProvider.ts:2186`
  - `src/services/LocalApiServer.ts:569` — user-facing 401 body text, not a comment
  - `src/test/standalone-secrets-bridge-contract.test.js:44`
- **Implementation:** Find-replace per file. Comments only, except `LocalApiServer.ts:569`, which is copy a user reads.
- **Edge Cases:** Don't touch the product name "Switchboard", `.switchboard/` config dir, or `[switchboard]` log prefixes. `LocalApiServer.ts:569`'s wording ("Open the board URL from a fresh `npx switchboard` launch") also becomes stale once the sibling attach plan lands — coordinate, or accept that the attach plan rewrites it again.

  > **Superseded:** "In-code comment/string references (8 files): `vscodeShim.ts:7`, `hostServices.ts:10` + `:300`, `planIngestionHost.ts:4`, `PlanIngestionEngine.ts:5`, `LocalApiServer.ts:516`, `TaskViewerProvider.ts:1782`."
  > **Reason:** three line numbers were stale (`hostServices` :300→:313, `LocalApiServer` :516→:569, `TaskViewerProvider` :1782→:2186) and two sites were missing entirely (`extension.ts:672`, `standalone-secrets-bridge-contract.test.js:44`). The missing test-file site matters beyond tidiness: the plan's own residual-string check greps `src`, so an unlisted site under `src/test/` fails the check the plan defines as its own gate.
  > **Replaced with:** the nine verified sites above.

### `README.md` + `docs/`
- **Context:** Primary user-facing install instructions in this repo.
- **Logic:** `README.md:31` ("No editor? `npx switchboard` runs the same board in your browser.") → lead with `npm i -g <name>` + bare `switchboard`, keep `npx <name>` as the try-without-installing line. Add the "first run creates `.switchboard/`" note. If the bin-collision pre-check found a hazard, document it. `docs/headless-switchboard.md` carries four occurrences (lines 3, 15, 18, 53) — rewrite each, including the `npx switchboard --port 4321 --hostname switchboard.localhost` example at :53.
- **Implementation:** Edit `README.md:31` and the four `docs/headless-switchboard.md` sites. Re-grep at implementation time.
- **Edge Cases:** Keep the VS Code extension install path (marketplace / VSIX, `README.md:26-29`) separate from the npm path — they are two hosts. The **switchboard-site** docs repo carries the same strings and is out of scope for this single-repo change (see Out of Scope).

## Verification Plan

> Per session directives: **no project compilation step and no automated test run** is part of this verification plan. The checks below are packaging/runtime smokes against the built artifact, not `npm run compile` / `webpack` / `tsc` / `npm test`. Note the honest exception: `npm pack` fires `prepack`, which *is* a build — that is the deliverable being tested, not a session verification step, and there is no way to test a publish pipeline without running it.

### Automated
- **Allowlist dry-run (run this first, before any other edit lands):** `npm pack --dry-run` → the printed file list contains `dist/standalone/cli.js` **and its chunk siblings**, `dist/standalone/ptyHost.js`, `dist/webview/`, `dist/sql-wasm.js`, `dist/sql-wasm.wasm`, `icons/`, `designs/`; and contains **no** `.switchboard/`, `src/services/`, `design_system/`, `docs/`, `.agents/`, `.claude/`, `scripts/`, `*.vsix`. Fails loudly today (no `files` → `dist/` absent), which is itself the reproduction of the defect.
- **Discriminating check (Definition of Done):** `node scripts/verify-npx-pack.js` — exit 0 **only if** `npm pack` produces a tarball, a clean-temp-dir install of that tarball boots the CLI, `GET /health` returns `{status:"ok"}`, `GET /board` returns board HTML, sql.js initializes, terminals degrade to disabled rather than crashing when node-pty is unbuilt, and there is no `vscode` require crash. Exit 1 if any step fails. This discriminates done-from-not-done: an unrenamed package, a missing asset, a missing chunk, a stale dist, or a vscode crash all fail it; a passing run means a fresh user can `npm i -g <name>` and get a working cockpit.
- **Residual-string check:** `grep -rn "npx switchboard" src README.md docs` → must be empty. Exit 1 on any match. Fails if the rename was incomplete (the stated goal — "users see the right command" — is unmet even if the smoke passes). Note this deliberately includes `src/test/`, which carries one of the sites.
- **Tarball-contents check:** `tar -tzf <tarball> | grep -E 'dist/standalone/cli.js|dist/sql-wasm.wasm|dist/webview/shell.html'` → all present; `tar -tzf <tarball> | grep -cE 'dist/standalone/.+\.js$'` → **> 2** (entry files plus chunks); `tar -tzf <tarball> | grep -E '\.switchboard/|\.env|auth_token|design_system/|\.map$'` → empty. Exit 1 on a missing asset or a leakage hit.
- **Name-claim check:** `npm view <chosen-name>` → 404 (unscoped, claimable) or owned-by-your-org (scoped); and `npm view switchboard bin` recorded (bin-collision hazard known, not unknown). **Re-run at implementation time** — the 2026-07-22 snapshot is stale.

### Manual / behavioral
- On a second machine (or a clean user account), `npm i -g <name>` then run `switchboard` in an empty dir → browser opens, board loads, a plan create/edit round-trip works. Supplements the automated smoke; not the sole acceptance signal.
- **On Linux specifically** — a minimal container with no build toolchain is the honest fixture — confirm the install completes (exit 0, `npm WARN optional`), the cockpit boots, and terminals are visibly disabled rather than dead-clicking. macOS and Windows resolve a prebuild and cannot reproduce this path, so testing only on the developer machine proves nothing about it. `npm_config_build_from_source=true` forces the same fallback on any platform (`node-pty/scripts/prebuild.js` deletes the prebuilds dir and exits 1 when it is set) if a Linux box is inconvenient — but prefer the real thing.

## Resolved Assumptions

The following external (code-unanswerable) platform-behavior assumptions were flagged during planning and **confirmed by web research (npm docs v7–v10 + npm/cli GitHub issues, 2026-07-22)**. They are now settled — do NOT re-research:
- **npm lifecycle hook semantics (CONFIRMED):** `prepack` fires before both `npm pack` and `npm publish` (and on Git-dependency installs, but NOT on local `npm install`); `prepublishOnly` fires only before `npm publish` and is skipped by `npm pack`. Stable across npm v7–v10. This validates the `prepack`-over-`prepublishOnly` correction — the `npm pack` verification path is self-building under `prepack`, stale under `prepublishOnly`. (`prepare` was rejected because it also fires on every local `npm install`, slowing dev/CI.)
- **Scoped-package publish mechanics (CONFIRMED):** scoped packages default to `restricted` (private); `publishConfig: { access: "public" }` is required to publish publicly (without it, a scoped publish 402s on a free plan); the `@turnzero` npm org must be created on the registry before the first `@turnzero/*` publish (the CLI cannot provision it; a missing org 404s/403s).
- **Global bin collision resolution (CONFIRMED — hazard upgraded):** npm resolves global `bin` name conflicts by **last-write-wins clobber** — the newly-installed package's symlink silently overwrites the older one, with no warning or prompt, no scope partitioning. If the taken `switchboard` package declares `bin: switchboard`, a user installing both packages globally gets the last-installed binary under `switchboard`. The pre-check + README documentation is the mitigation (not a blocker — the package names differ, so a user who wants this one installs this one).
- **`files` allowlist semantics (CONFIRMED):** a `files` array puts npm packing in allowlist-only mode; `.env` / `.switchboard/` are excluded unless explicitly listed. `package.json`, `README.md`, `LICENSE`, and `main`/`bin` targets bypass the allowlist and are always packed.

**Settled by a second research pass (npm docs v10/v11, `npm-packlist` + `@npmcli/arborist` source, 2026-08-04). Do NOT re-research:**

- **`bin` force-inclusion beats `.gitignore` (CONFIRMED — and it changes the failure mode).** npm's always-included set — `package.json`, `README*`, `LICENSE*`, the `main` target, **and every `bin` target** — bypasses all ignore matching, `.gitignore` fallback included. Adjacent files in the same gitignored directory (lazy chunks, `sql-wasm.wasm`, `dist/webview/`) are **not** force-included. No behavioural difference between npm v10 and v11. This is why the current no-`files` tarball installs and launches before failing, rather than failing at install.
- **`files` supports inline `!` negations (CONFIRMED), and is preferable to `.npmignore`.** `npm-packlist` evaluates the array through `minimatch`. When both exist, `.npmignore` does subtract within the `files` allowlist — but a root `.npmignore` also replaces `.gitignore` as the fallback for undecided paths, and **a subdirectory `.npmignore` overrides the root allowlist**. Inline negation avoids both hazards.
- **`optionalDependencies` failure is silent and non-fatal (CONFIRMED) across npm 10, npm 11 and `npx`.** The install exits `0`; npm logs `npm WARN optional SKIPPING OPTIONAL DEPENDENCY` to stderr at default loglevel; the failed package directory is discarded from `node_modules` and execution continues. No difference between a prebuild-fetch failure and a `node-gyp` compile failure. The commonly-cited follow-on trap — an unguarded runtime `require` throwing `MODULE_NOT_FOUND` — **does not apply to this repo**: `ptyBackend.ts:7-23` requires lazily behind an `isPtyAvailable()` gate and `ptyHost.ts:36-39` exits with a clear message.
- **`BannerPlugin` shebang semantics (CONFIRMED):** `raw: true` prevents the shebang being wrapped in a comment; `entryOnly: true` prevents it being injected into lazy chunks, where it is at best noise. `webpack.config.js` already sets both — no change needed, but do not "tidy" them away.
- **Chunk completeness (CONFIRMED as the standard failure):** declaring only the entry file in `files` yields `Error: Cannot find module './<chunk>.js'` at first dynamic import. Declare the whole output directory. Verify from a real `npm pack` tarball installed in a clean directory — never `npm link` or a repo-relative run, both of which mask missing chunks via the source tree.

Code-answerable questions (asset resolution, sql.js WASM path, vscode-alias behavior, chunk splitting, node-pty externals and prebuild coverage, the `isPtyAvailable` gate, in-repo reference locations) were all verified against the repo and are recorded above as code-verified facts.

## Uncertain Assumptions

None outstanding. The four external packaging questions raised during planning were researched and are recorded under Resolved Assumptions; two of the research pass's conclusions (node-pty prebuild coverage, and the unguarded-`require` trap) were **contradicted by direct inspection of this repo** and are corrected in-place above with superseded callouts. No further web research is needed before implementation.

## Recommendation
Complexity 5 → **Send to Coder.** The rename and find-replace are routine, but authoring the `files` allowlist from scratch is a genuine correctness surface: today's default is wrong in both directions, the standalone bundle is chunk-split with stale artefacts, and `node-pty` is a native optional dependency. Validate the allowlist with `npm pack --dry-run` before any other edit, use `prepack` (not `prepublishOnly`) so the verification path is self-building, and treat `scripts/verify-npx-pack.js` — a real tarball, a clean dir, a booting cockpit — as the only signal that counts. Settle the name first (User Review) and re-check availability at that moment; `@turnzero/switchboard` is the recommended default.

**Stage Complete:** PLAN REVIEWED
