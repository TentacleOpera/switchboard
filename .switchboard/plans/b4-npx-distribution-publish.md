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
- **No npm publish build hook.** The only prepublish hook is `vscode:prepublish` (vsce, for the VSIX); there is no npm `prepublishOnly`/`prepare`, so `npm publish` would ship whatever is in `dist/` at that moment (stale-build risk). The `package` script is `webpack --mode production` (the extension bundle); the standalone CLI entry (`dist/standalone/cli.js`, with `vscode` aliased to `src/standalone/vscodeShim.ts`) must be confirmed to build as part of the publish pipeline.
- Per the project PRD's release-phase map, **npx distribution is B4** — separate from B1 (composition-root wiring). This plan is B4.

**De-risking facts already verified:** `sql.js` (the KanbanDatabase engine) is **pure WASM — no native/`node-gyp` build**, so `npx` installs cleanly on any platform; and `vscode` is **not** a runtime dependency (only `@types/vscode` dev), so nothing requires the real `vscode` module at runtime as long as the standalone bundle ships the shim.

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
- **Publish build hook.** Add a `prepublishOnly` (or `prepare`) script that produces a fresh, working `dist/standalone/cli.js` **with `vscode` aliased to the shim** (confirm the standalone entry is in the webpack build, or add a dedicated standalone-build step). The hook must fail the publish if the standalone bundle is missing or references a real `vscode` require.
- **Rewrite the invocation strings**, leading with the **install-once** form as primary — `npm i -g <name>` then bare `switchboard` — and keeping `npx <name>` only as the "try without installing" line. The *command* stays `switchboard`; only the install/fetch name changes. Update: `src/standalone/cli.ts` usage line, `README.md`, the docs site, and the ~8 in-code comment/string references (`vscodeShim.ts`, `hostServices.ts`, `planIngestionHost.ts`, `PlanIngestionEngine.ts`, `LocalApiServer.ts`, `TaskViewerProvider.ts`). Do NOT touch the product name "Switchboard", the `.switchboard/` config dir, or the `[switchboard]` log prefixes.
- **Tarball hygiene.** Confirm `files` includes everything the CLI reads at runtime — `dist/standalone/cli.js`, `dist/webview` (or `src/webview` fallback, both resolved by `headlessPanelHtml.findFile`), `icons`, `designs`, and the `sql.js` WASM (comes transitively via the `sql.js` dependency). Verify no source-tree secrets or `.switchboard/` fixtures leak into the tarball.
- **Install-from-registry verification** via `npm pack` + a clean-dir install-and-run smoke (see Verification Plan).

### ⚙️ OUT OF SCOPE
- The actual `npm publish` credential/2FA step and version-bump policy — a human-run release action (this plan makes it publishable and verifies a dry-run; it does not push to the registry).
- CI auto-publish on tag — a sensible follow-on, not required here.
- B1 verb wiring, Layer-1 arm conversions, node-pty/B3, the browser board itself — all separate.
- Pruning the heavy runtime deps (mermaid/jsdom/docx/stitch-sdk) to shrink the install — noted under Edge Cases, not done here.

## Implementation Steps
1. **Settle the name** (User Review) → set `package.json name` + `publishConfig.access` (if scoped) + publish metadata.
2. **Confirm/add the standalone publish build.** Verify `dist/standalone/cli.js` is emitted with the `vscode`→shim alias; add a `prepublishOnly` that runs it and asserts the bundle exists and is vscode-free.
3. **Swap the `npx switchboard` invocation strings** to `npx <name>` across cli usage, README, docs site, and the in-code references. Leave product name / config dir / log prefixes alone.
4. **`npm pack`**; inspect the tarball (cli.js present, webview present, no leakage).
5. **Clean-dir smoke:** `npm i -g ./<tarball>` (or `npx ./<tarball>`) in an empty temp workspace → the shell + board load, no `vscode` crash, sql.js DB initializes, `/board` serves.
6. Hand off to the human for the credentialed `npm publish` (out of scope here).

## Complexity Audit
### Routine
- `package.json` name/metadata/publishConfig edits.
- Find-replace the ~10 `npx switchboard` invocation strings.
- `npm pack` + tarball inspection.

### Complex / Risky
- **"Does it run after `npm install`" — the load-bearing risk.** The published CLI must resolve its assets from the installed layout: `resolveRepoRoot()` does `path.resolve(__dirname,'..','..')` from `dist/standalone/cli.js` → package root, and `headlessPanelHtml.findFile` looks for `dist/webview/*` then `src/webview/*`; `staticRoutes` serves `icons`/`designs`. All are in `files`, but must be verified live from a tarball install, not assumed.
- **`vscode` must not reach a runtime `require`.** It is not a dep, but the standalone bundle must bundle the shim; if the publish build emits an un-shimmed `cli.js`, `npx` crashes on first `import * as vscode`. The `prepublishOnly` must assert the bundle is vscode-free.
- **Scoped-package access.** A scoped name without `publishConfig.access: "public"` publishes restricted (private) or 403s — easy to miss.
- **Rename completeness.** A missed `npx switchboard` string in user-facing output/docs tells users the wrong command.

## Edge-Case & Dependency Audit
- **Race Conditions:** none — publish is a one-shot human action; the CLI's runtime concurrency (one-time token, single-writer DB) is unchanged.
- **Security:** the published tarball must not include `.switchboard/` fixtures, tokens, or `.env`; `files` is an allowlist (good), but verify the `npm pack` output. The one-time-token localhost gate is unchanged.
- **Side Effects:** first `npx <name>` run in an empty dir creates `.switchboard/` — expected; document it. The install pulls heavy transitive deps (mermaid/jsdom/docx) → a large first-run download; acceptable, flagged for a future prune.
- **Dependencies & Conflicts:** `sql.js` is WASM (no native build — cross-platform clean). `engines.node: ">=22.0.0"` gates old-Node users with a clear npm error.

## Dependencies
- **Orthogonal to B1** (`b1-standalone-bootstrap-wire-design-setup-taskviewer-verbs.md`): B1 makes the Design/Setup/TaskViewer verbs *work* in the standalone server; B4 makes the server *installable*. Either order compiles, but **ship B1 first** (or accept that a freshly-published `npx <name>` serves a cockpit whose Design/Setup panels still 503 until B1 lands). Board + Project(memo) already work, so B4-before-B1 is a partial-but-honest release.
- A2b Layer-1 (return contract) is not required for distribution, but improves what a published build can do over HTTP.
- No session (`sess_…`) dependencies.

## Verification Plan (Definition of Done — objective)
- `npm view <chosen-name>` returns 404 (unscoped) or is owned by your org (scoped) — name is claimable.
- `npm pack` produces a tarball containing `dist/standalone/cli.js`, the webview HTML, `icons`, `designs`; and NO `.switchboard/`, tokens, or `.env`.
- Clean-dir install-from-tarball: `npx ./<tarball>` (or global install) in an empty temp workspace boots the headless server, opens the shell, `GET /board` returns, sql.js DB initializes, and there is **no `vscode` require crash**.
- `prepublishOnly` runs the standalone build and fails if `dist/standalone/cli.js` is missing or contains a real `vscode` require.
- No `npx switchboard` invocation strings remain that point at the old name (grep clean); product name / config dir / log prefixes unchanged.

## Recommendation
Complexity 4 → **Send to Coder.** Mostly config + a find-replace + a publish hook, but the "runs after install from a tarball" and "no vscode in the bundle" checks are the load-bearing verifications — do them from an actual `npm pack`, not by inspection. Settle the name first (User Review); `@turnzero/switchboard` is the recommended default.

**Stage Complete:** CREATED
