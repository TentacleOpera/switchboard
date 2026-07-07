---
description: "Standalone npx Switchboard, subtask 1 of 4: build the machine-readable protocol catalog (Phase 0) and stand up the host-agnostic core service — bin skeleton, LocalApiServer bootstrap with real callbacks, KanbanDatabase vscode-seam injection, config/secret/state replacements, single-instance guard (Phase 1)"
---

# Standalone Switchboard 1/4 — Protocol Inventory + Host-Agnostic Core Service

## Goal

Deliver the two prerequisites every later subtask builds on: (1) a **machine-readable protocol catalog** of the full webview↔host message contract, and (2) a **bootable host-agnostic core service** — the `switchboard` bin skeleton that constructs `LocalApiServer` with real (non-VS Code) callback implementations, with config/secret/state replacements and a mandatory single-instance guard.

**Context (parent architecture):** This is subtask 1 of the feature decomposing `.switchboard/plans/extract-standalone-npx-browser-service.md` (Plan ID `81299C8F-E2FA-4F93-881D-83231E1798A1`) — an editor-independent Switchboard distributed via `npx`, with a browser board and a `node-pty` terminal fleet. The parent plan holds the full problem analysis (Zed infeasibility, fork rejection, why-standalone) and the hard constraint that applies to ALL subtasks: **do not regress the shipped VS Code extension (~4,000 installs)** — shared code must stay behavior-preserving, and `.switchboard/` + `kanban.db` stay format-compatible between run modes. This subtask covers the parent's Phase 0 + Phase 1.

## Metadata
- **Plan ID:** 0DE4623A-2A09-434E-A2B3-0089330544F6
- **Tags:** refactor, backend, cli, infrastructure
- **Complexity:** 7

## User Review Required
- None — decisions inherited from the reviewed parent plan.

## Scope

### ✅ IN SCOPE
- **Protocol catalog (Phase 0):** enumerate the full message contract — measured 2026-07-07: **432 distinct message `type:` values** from `src/webview/*`, **706 handler `case` arms** across the five Providers (TaskViewer 191, Kanban 168, Planning 168, Setup 117, Design 62), **988 host→webview push sites**, **575 `postMessage` call sites** in the UI. Output: a checked-in machine-readable catalog (JSON) mapping verb → direction → payload shape → owning provider → target service method. This is subtask 3's burn-down checklist AND its CI parity-test fixture.
- **`switchboard` bin + bootstrap:** `src/standalone/cli.ts` (flag parsing, single-instance guard, boot) and `src/standalone/bootstrap.ts` composing `LocalApiServer` with real callback implementations mirroring `LocalApiServerOptions` (`src/services/LocalApiServer.ts:9–80`) exactly — peers of the extension's implementations, not forks.
- **Single-instance guard:** before opening the DB, probe `.switchboard/api-server-port.txt` + `/health` (`src/services/LocalApiServer.ts:1320`); live peer → refuse to start (or read-only) with a clear message; stale port file (no `/health` answer) → overwrite. This is mandatory: sql.js persists by full-file write-back with no locking — two live writers silently clobber each other.
- **KanbanDatabase seam injection:** abstract the **6 lazy `require('vscode')` sites** in `src/services/KanbanDatabase.ts` behind an injected `HostPathConfigProvider` (workspace root, config reads). Default behavior when no provider is passed = today's guarded lazy-require, so existing extension call sites need no change.
- **Config replacement:** standalone equivalents of the **80** `switchboard.*` settings in `package.json` via a JSON/YAML config file + env overrides.
- **Secret storage replacement:** the **6 secret keys** (`switchboard.apiToken`, `switchboard.clickup.apiToken`, `switchboard.linear.apiToken`, `switchboard.notion.apiToken`, `switchboard.stitch.apiKey`, `switchboard.stitch.accessToken`, ~10 call sites) via **`@napi-rs/keyring`** (keytar is archived; `@napi-rs/keyring` ships prebuilds as `optionalDependencies`, zero postinstall, D-Bus direct on Linux). Headless fallback: AES-256-GCM-encrypted `0600` file under `.switchboard/`, key from env/master passphrase.
- **State replacement:** `Memento` (10 distinct keys across 6 files) migrates to the **`kanban.db` `config` table** — the blessed home for cross-surface state. No new JSON state store.
- Reuse vscode-free modules as-is: `agentPromptBuilder.ts` (108 KB, 0 vscode refs), sync services, `KanbanMigration.ts`, `SessionActionLog.ts`.

### ⚙️ OUT OF SCOPE
- Terminal fleet (subtask 2), handler extraction/transport (subtask 3), npx packaging/launcher (subtask 4).
- Any UI/webview change.

## Implementation Steps

1. **Catalog generation** — script scans `src/webview/*` for `postMessage({type: ...})` and the five Providers for `case '...'` arms; emit `protocol-catalog.json` (verb, direction, payload keys, provider, proposed service module). Manual pass to classify request/response pairs vs fire-and-forget.
2. **`src/standalone/cli.ts`** — bin entry: parse flags, run single-instance guard, boot bootstrap, print served URL.
3. **`src/standalone/bootstrap.ts`** — construct `KanbanDatabase` (injected provider), sync services, `LocalApiServer` with real callbacks.
4. **`src/standalone/hostServices.ts`** — config-file loader (80 settings), `@napi-rs/keyring` secret store (6 keys) + encrypted-file fallback, `config`-table Memento replacement (10 keys).
5. **`KanbanDatabase.ts` seam injection** — constructor/init-time `HostPathConfigProvider`; extension passes vscode-backed impl; absent provider → current lazy-require fallback (behavior-preserving; bare test harnesses unchanged).
6. **Guard tests** — live-peer probe refuses second start; stale port file overwritten.

## Complexity Audit

### Routine
- Catalog scan scripting (grep-shaped, verified counts already exist).
- Reusing the vscode-free modules in the bootstrap.
- Config-file loader.

### Complex / Risky
- **Touching `KanbanDatabase.ts` (356 KB, shipped code)** — the seam injection must be a no-op for the extension path; regressions here hit all ~4,000 installs.
- **Secret/state substitution correctness** — 6 keys and 10 Memento keys must resolve identically in both run modes; a missed key silently breaks sync integrations in standalone mode.
- **Single-instance guard** — data-loss prevention, not hardening; false-negative peer detection (stale file treated as live, or vice versa) either blocks legitimate starts or permits clobbering.

## Edge-Case & Dependency Audit

### Race Conditions
- Guard TOCTOU: peer could start between probe and DB open — acceptable residual risk locally; keep window minimal (probe immediately before open).
- Stale `api-server-port.txt` with a *different* service answering `/health` on a recycled port → validate the health payload identifies Switchboard, not just HTTP 200.

### Security
- Encrypted-file secret fallback: `0600`, under `.switchboard/`, AES-256-GCM, key never written to disk.
- No secrets in the config file; config loader must reject secret-shaped keys with a pointer to the keyring.

### Side Effects
- All `KanbanDatabase.ts` edits run in the shipped extension — existing tests (`src/services/__tests__/`, `src/test/`) must pass unchanged.
- New `config`-table keys namespaced (`standalone.*`) so old extension versions ignore them safely.

### Dependencies & Conflicts
- New deps this subtask: `@napi-rs/keyring`. (`node-pty`/`@xterm`/`ws` land in subtasks 2–3.)
- Node floor `>=22` (engines enforced in subtask 4's packaging; honored here in code).

## Dependencies
- **Session dependencies:** None (first subtask of the feature; no upstream sibling).
- Parent architecture reference: `.switchboard/plans/extract-standalone-npx-browser-service.md`.

## Adversarial Synthesis

Key risks: seam injection regressing the shipped extension's DB behavior, the single-instance guard mis-detecting peers, and secret/state key drift between run modes. Mitigations: default-fallback injection keeps extension call sites untouched and provider tests green; guard validates Switchboard-identifying health payloads; the 6+10 key inventories in this plan are the checklist, tested per key.

## Proposed Changes

### `src/standalone/cli.ts`, `src/standalone/bootstrap.ts`, `src/standalone/hostServices.ts` (new)
- **Context:** No standalone composition root exists; `extension.ts` is the only one.
- **Logic:** As per Implementation Steps 2–4.
- **Implementation:** Mirror `LocalApiServerOptions` contracts exactly.
- **Edge Cases:** keyring unavailable → encrypted-file fallback; guard failure modes above.

### `src/services/KanbanDatabase.ts`
- **Context:** 6 lazy `require('vscode')` sites; otherwise host-agnostic (sql.js).
- **Logic:** Injected `HostPathConfigProvider` consumed at those 6 sites.
- **Implementation:** Optional constructor param, lazy-require fallback when absent.
- **Edge Cases:** provider absent + vscode absent (test harness) → identical to today.

### `protocol-catalog.json` (new, checked in)
- **Context:** No machine-readable contract exists; 432 verbs / 706 arms live only in code.
- **Logic:** Scanner script + manual request/response classification.
- **Implementation:** Regenerable; CI can diff regenerated vs checked-in to catch drift.
- **Edge Cases:** dynamically-constructed `type:` strings (template literals) need manual entries — flag them in the catalog rather than silently missing them.

## Verification Plan

### Automated Tests
- Existing provider/DB tests pass unchanged (extension behavior preserved).
- Guard tests: live peer → refused; stale file → overwritten; non-Switchboard responder → treated as stale.
- Secret-store round-trip per key (keyring + fallback paths); Memento-replacement round-trip per key.
- Catalog completeness: regenerated catalog matches checked-in catalog.

### Manual
- `node dist/standalone/cli.js` boots against a copy of a real `.switchboard/` workspace; `/health` answers; `.agents/skills/kanban_operations/get-state.js` reads board state through it.
- Start it while VS Code extension is running → refuses with clear message.

**Stage Complete:** PLAN REVIEWED
