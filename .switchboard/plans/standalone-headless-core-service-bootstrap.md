---
description: "Feature B (Standalone Headless), subtask B1: stand up the host-agnostic core service — the switchboard bin/bootstrap that composes LocalApiServer with real non-VS Code callbacks, provides the STANDALONE implementations of the seams A2 defined (config-file, keyring secrets, Memento→config state), and a mandatory single-instance guard."
---

# Feature B · B1 — Host-Agnostic Core Service / Standalone Bootstrap

## Goal

Stand up a **bootable, editor-independent core service**: the `switchboard` bin + bootstrap that composes `LocalApiServer` with real (non-VS Code) callback implementations, provides the **standalone implementations** of the seam interfaces A2 introduced, and enforces a **single-instance guard**. This is the second composition root — the extension is the first — reusing the services A2 extracted.

**Context:** Split 2026-07-08 from the original `extract-standalone-npx-01-protocol-core.md` (its Phase 1). The protocol catalog (Phase 0) stayed near-term as **A1**; this bootstrap is **post-release** because it is only needed when there is no VS Code. A2 defines the seam *interfaces* (`HostPathConfigProvider`, `TerminalBackend`, secret/state seams) and the vscode-backed impls; **this subtask provides the standalone impls**. Parent hard constraint: **do not regress the shipped extension (~4,000 installs)** — shared code stays behavior-preserving; `.switchboard/` + `kanban.db` stay format-compatible across run modes.

> **Post-split note (2026-07-08):** the original A2 was split into **A2a** (transport infrastructure — seam *interfaces* + wsHub + auth + broadcast) and **A2b** (per-verb handler extraction → host-agnostic *services*). Where this plan says "A2": seam interfaces/impls are **A2a**; extracted host-agnostic services are **A2b**.

## Metadata
- **Tags:** backend, cli, infrastructure
- **Complexity:** 7
- **Release phase:** Post-release / headless (Feature B — Standalone Headless Switchboard). Depends on A2a (seam interfaces) + A2b (extracted host-agnostic services).

## User Review Required
- None — decisions inherited from the reviewed parent plan.

## Scope

### ✅ IN SCOPE
- **`switchboard` bin + bootstrap:** `src/standalone/cli.ts` (flag parsing, single-instance guard, boot, print served URL) and `src/standalone/bootstrap.ts` composing `KanbanDatabase` + sync services + `LocalApiServer` with real callbacks mirroring `LocalApiServerOptions` (`LocalApiServer.ts:9–80`) — peers of the extension's implementations, not forks.
- **Standalone seam implementations (`src/standalone/hostServices.ts`):**
  - **Config** — standalone equivalents of the **80** `switchboard.*` settings (`package.json`) via a JSON/YAML config file + env overrides, behind A2's `HostPathConfigProvider`.
  - **Secrets** — the **6 secret keys** (`switchboard.apiToken`, `clickup/linear/notion.apiToken`, `stitch.apiKey/accessToken`, ~10 call sites) via **`@napi-rs/keyring`** (keytar archived; napi-rs ships prebuilds as `optionalDependencies`, zero postinstall, D-Bus direct on Linux). Headless fallback: AES-256-GCM-encrypted `0600` file under `.switchboard/`, key from env/master passphrase.
  - **State** — `Memento` (10 keys across 6 files) → the `kanban.db` `config` table (namespaced `standalone.*` so old extension versions ignore them).
- **`KanbanDatabase` standalone provider:** inject the standalone `HostPathConfigProvider` at the 6 lazy `require('vscode')` sites; extension path unchanged (its vscode-backed provider from A2 remains the default).
- **Single-instance guard:** before opening the DB, probe `.switchboard/api-server-port.txt` + `/health` (`LocalApiServer.ts:1320`); live peer → refuse (or read-only) with a clear message; stale port file → overwrite. Mandatory — sql.js persists by full-file write-back with no locking; two live writers silently clobber.
- **Host-capability descriptor:** expose the active host's deliverable capabilities so the browser UI (B2) can adapt. At minimum `terminalDispatch: boolean`, **derived from whether a live `TerminalBackend` seam is wired** — `false` in the headless MVP (no fleet), `true` once B3 lands or in the VS Code host. Surface it two ways: on `/health` (for programmatic clients) and **injected into the served board HTML at serve time** as a `data-host-capabilities` body attribute (parallel to `data-initial-workspace-root`), so B2 has it at first paint with no flash of unavailable controls. Keep it forward-compatible (an object, not a bare bool) so B3/automation flags can be added without a breaking change.
- Reuse vscode-free modules as-is: `agentPromptBuilder.ts`, sync services, `KanbanMigration.ts`, `SessionActionLog.ts`.

### ⚙️ OUT OF SCOPE
- Seam interfaces + vscode-backed impls (A2). Transport shim (B2). node-pty fleet + browser grid (B3). npx packaging/launcher (B4). Any UI change.

## Complexity Audit
### Routine
- Config-file loader; reusing vscode-free modules in the bootstrap.
### Complex / Risky
- **Standalone `KanbanDatabase` provider** — must be a no-op for the extension path; regressions hit all ~4,000 installs.
- **Secret/state substitution correctness** — 6 keys + 10 Memento keys must resolve identically in both run modes; a missed key silently breaks sync integrations in standalone mode.
- **Single-instance guard** — data-loss prevention; validate the `/health` payload identifies Switchboard (not just HTTP 200 on a recycled port), and keep the probe→open window minimal (TOCTOU).

## Edge-Case & Dependency Audit
- **Security:** encrypted-file secret fallback `0600`, AES-256-GCM, key never on disk; config loader rejects secret-shaped keys with a keyring pointer.
- **Side effects:** all standalone-provider wiring must leave existing extension/DB tests green; new `config` keys namespaced `standalone.*`.
- **Dependencies:** **A2a** (seam interfaces) + **A2b** (extracted host-agnostic services). New dep: `@napi-rs/keyring`. Node floor `>=22` (enforced in B4; honored here). `node-pty`/`@xterm`/`ws` land in B2/B3.

## Verification Plan
- `node dist/standalone/cli.js` boots against a copy of a real `.switchboard/` workspace; `/health` answers; `get-state.js` reads board state through it.
- Start while the VS Code extension is running → refuses with a clear message; stale port file → overwritten; non-Switchboard responder → treated as stale.
- Secret-store + Memento-replacement round-trip per key (keyring + fallback paths).
- Existing provider/DB tests pass unchanged.

**Stage Complete:** PLAN REVIEWED
