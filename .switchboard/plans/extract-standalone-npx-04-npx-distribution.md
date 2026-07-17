---
description: "Standalone npx Switchboard, subtask 4 of 4: npm bin packaging, launcher that boots the service and opens the browser with a one-time-token handoff, engines>=22 floor, and the clean-machine smoke matrix across OS x arch x package manager (Phase 4)"
---

# Feature B · B4 — `npx` Distribution + Launcher

## Goal

Package the standalone service for `npx switchboard`: the `bin` entry + launcher that boots the service, health-gates on `/health` + `api-server-port.txt`, and opens the browser to the served board with a **one-time-token handoff** — then prove it on clean machines across the full OS × arch × package-manager matrix.

**MVP decoupling (2026-07-17).** The launcher **core** — packaging, boot, health-gate, token handoff, browser-open, and the board-renders smoke — depends only on **A2a + A2b + B1 + B2**, and this is the whole of what the *Standalone Headless Switchboard* feature now ships. It delivers the **terminal-free browser cockpit** (Copy-Prompt workflow for Claude Desktop / GUI-agent users) with **no dependency on the terminal fleet**. The terminal fleet (node-pty pool + xterm grid — the **separately-backlogged** plan `extract-standalone-npx-02-terminal-fleet.md`, no longer a sibling subtask of this feature) is required only for the *in-browser terminal execution* smoke legs and to flip the host capability to `terminalDispatch: true`; those legs are additive and gate on that plan landing, not on this feature. So B4 is effectively two-tier: an MVP core (needs B1+B2, in-feature) and a fleet tier (needs the backlogged terminal-fleet plan).

**Context (parent architecture):** Subtask 4 of the feature decomposing `.switchboard/plans/extract-standalone-npx-browser-service.md` (Plan ID `81299C8F-E2FA-4F93-881D-83231E1798A1`). This is the parent's Phase 4 (~1–2 wks, overlaps subtask 2's prebuild verification). `npx` is the chosen distribution — Electron packaging was explicitly rejected for now; extension-as-launcher and Open VSX publish are separate follow-ups outside the feature.

> **Renumbering (2026-07-08):** the original 4-subtask feature was split into Feature A + Feature B. Old numbers used below map as: **subtask 1 → A1**; **subtask 2 → B3**; **subtask 3 → A2a** (wsHub/auth) + **A2b** (endpoints); **subtask 4 → B4** (this plan).

## Metadata
- **Plan ID:** 5674b039-5c6b-4787-b061-390d3a790093
- **Tags:** devops, cli, infrastructure, security
- **Complexity:** 5
- **Release phase:** **Post-release / headless.** npx packaging + launcher is the no-VS-Code distribution; not needed while the extension is the engine. See the feature file's "Execution order & release phasing."

## User Review Required
- None — distribution choice fixed in the parent plan's review.

## Scope

### ✅ IN SCOPE
- **`package.json` packaging:** `bin: { "switchboard": "dist/standalone/cli.js" }`, `"engines": { "node": ">=22.0.0" }` (Node 20 EOL'd 2026-04-30; Node 24 Active LTS is the dev/CI baseline), new deps finalized (`node-pty@^1.2.0`, `@xterm/xterm@^6` + fit/attach/webgl addons, `ws`, `@napi-rs/keyring`), and a **second webpack target** for the standalone bundle alongside the extension build.
- **Launcher flow:** boot service → wait for `/health` (`src/services/LocalApiServer.ts:1320`) + `api-server-port.txt` → generate high-entropy one-time token (`crypto.randomBytes(32)`) → open browser to the board URL carrying the token → page exchanges it for a session credential and strips it from the URL (history/log hygiene).
- **Extension-bundle isolation:** `node-pty` (and other standalone-only natives) marked external to the **extension** webpack target — the VSIX must be byte-equivalent in behavior and must not grow standalone deps (VSIX bundles everything; no runtime node_modules escape hatch exists).
- **Clean-machine smoke matrix (two tiers):**
  - **MVP tier (no B3):** `npx switchboard` on macOS (x64 + arm64), Windows x64, Linux x64 + arm64, with **npm and pnpm** — full board (all five panels) renders and round-trips, Copy-Prompt copies + advances a card, no terminal/CLI pathways shown. No native `node-pty` in the install tree at this tier, so its prebuild regressions are not yet in play.
  - **Fleet tier (with the backlogged terminal fleet):** the same matrix plus *an agent launches in a fleet pane / output streams back*. The arm64 + pnpm legs guard the two known `node-pty` v1.2.x packaging regression classes (Issues #860, #850) — these become mandatory only once `node-pty` is a shipped dep (i.e. the terminal-fleet plan lands).

### ⚙️ OUT OF SCOPE
- Electron packaging; extension-as-launcher; Open VSX publish (all explicitly deferred in the parent plan).
- Auto-update mechanics — `npx` semantics (fetch-latest by default) are the v1 update story.

## Implementation Steps

1. **Standalone webpack target** — bundle `dist/standalone/cli.js`; natives (`node-pty`, `@napi-rs/keyring` platform packages) stay unbundled runtime deps resolved from the npm install tree.
2. **`bin` + engines + files allowlist** — ship only `dist/`, prebuild-bearing deps resolve transitively; verify `npm pack` tarball contents.
3. **Launcher** — health-gated boot per Scope; browser-open via platform opener; `--no-open`, `--port` flags.
4. **Token handoff** — one-time token accepted exactly once by the token-exchange endpoint (server side landed in subtask 3); reuse → 401 and a fresh-login hint.
5. **Smoke matrix in CI + release checklist** — the five-leg matrix per Scope; failures block release.

## Complexity Audit

### Routine
- `bin`/engines/webpack-target wiring.
- Launcher flags and platform browser-open.
- CI matrix configuration (runners already needed by subtask 2's guards).

### Complex / Risky
- **Extension VSIX isolation** — accidentally bundling `node-pty` into the extension target (or shifting its externals) regresses the shipped extension; the VSIX-content diff check is the guard.
- **Token handoff hygiene** — token must not survive in browser history, server logs, or be replayable; exactly-once exchange semantics.

## Edge-Case & Dependency Audit

### Race Conditions
- Launcher polls `/health` with timeout; service crash during boot → clear stderr diagnostics, nonzero exit, no orphaned port file.
- Browser opens before token-exchange endpoint ready → launcher gates browser-open on `/health`, which subsumes readiness.

### Security
- One-time token: 32 bytes entropy, single-use, short TTL; stripped from URL immediately after exchange.
- `npx` supply-chain posture: `files` allowlist keeps the tarball minimal; no postinstall scripts of our own; lockfile-pinned CI.

### Side Effects
- Second webpack target must not alter the extension target's output (compare VSIX contents pre/post as a release-checklist item).
- `npm pack` size guard — prebuild-bearing transitive deps are the expected bulk; our own tarball stays lean.

### Dependencies & Conflicts
- **MVP core (this feature) depends on `eb75281d` A1, `aaeafbeb` A2a, `c05762a3` A2b, `cffd3a43` B1, `a5de2ce9` B2** — packages the terminal-free browser cockpit; **the terminal fleet is NOT required.** **Fleet tier adds the separately-backlogged terminal-fleet plan `341ac949`** (node-pty prebuilds + browser terminals); its smoke legs and the node-pty externals/regression guards apply only once that plan lands, and can overlap it as it completes.
- npm registry publish access for the `switchboard` package name (verify availability/ownership early — rename fallback if squatted).

## Dependencies
- **Session dependencies:** A1, A2a, A2b, B1, B2, B3 (plan IDs above); smoke-matrix legs overlap B3.
- Parent architecture reference: `.switchboard/plans/extract-standalone-npx-browser-service.md`.

## Adversarial Synthesis

Key risks: regressing the shipped extension via bundling/externals drift, and token-handoff leakage making the local board (and its PTY fleet) reachable by other local actors. Mitigations: VSIX-content diff as a release gate; single-use short-TTL token exchanged and stripped immediately; five-leg clean-machine smoke matrix gating release on the known native-packaging regression classes.

## Proposed Changes

### `package.json`
- **Context:** Extension-only packaging today (80 `switchboard.*` settings, `vscode-test` script).
- **Logic:** `bin`, `engines >=22`, finalized deps, `files` allowlist, standalone webpack target script.
- **Implementation:** Extension packaging path untouched; standalone target additive.
- **Edge Cases:** `node-pty` external to extension target; VSIX diff gate.

### `webpack.config.js` (or split config)
- **Context:** Single extension target today.
- **Logic:** Add standalone target (`target: 'node'`, natives external).
- **Implementation:** Shared loaders; separate entry/output; extension output byte-stable.
- **Edge Cases:** WASM asset (`sql.js`) resolution identical in both bundles.

### `src/standalone/cli.ts` (launcher portion)
- **Context:** Created in subtask 1; this subtask adds launcher behavior.
- **Logic:** Health-gated boot, token generation/handoff, browser open, flags.
- **Implementation:** Poll `/health` with backoff + timeout; platform opener; darwin `spawn-helper` chmod guard runs before fleet init (subtask 2's fix, invoked here at startup).
- **Edge Cases:** port collision → ephemeral-port retry; headless env (`--no-open`) prints URL + token pairing instructions.

## Verification Plan

### Automated Tests
- Tarball content test: `npm pack` contains `dist/standalone/`, excludes sources/tests; extension VSIX contents unchanged (diff gate).
- Token-exchange tests: single-use enforced; expired/reused token → 401.
- Launcher unit tests: health-gate timeout paths, flag parsing.

### Manual
- Five-leg clean-machine matrix per Scope: `npx switchboard` → board loads, plan moves across columns, agent launches in a pane, text routes correctly, output streams back.
- `.agents/skills/kanban_operations/move-card.js` works against the standalone service unchanged.
- Token replay attempt from a second browser tab → rejected.

**Stage Complete:** PLAN REVIEWED
