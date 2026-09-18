---
description: "Ingestion piece 3 of 3: give headless real provider sync. Replace bootstrap.ts's getClickUpService/getLinearService/getNotionService () => null stubs with real factories backed by the existing clickup.json/linear.json metadata paths + the global integration-config.json + StandaloneHostSecrets, so provider-linked plans sync headless as the site claims. Depends on piece 2 (standalone ingestion driving the engine). Additive."
---

# Headless Ingestion 3 — Headless Provider Sync

## Goal

**Definition of done: the ingestion-path provider sync that the extension performs on the watcher fires identically headless, and all three provider services are available to the `npx switchboard` API server.** Concretely: (a) a ClickUp-linked plan real-time-syncs on ingest and a Linear-linked plan archives on delete, matching `GlobalPlanWatcherService`, and (b) ClickUp / Linear / Notion services are constructed from real config instead of `() => null` so the `LocalApiServer` comment bridge and provider verbs work headless.

**Scope honesty:** this does NOT deliver column-move-triggered integration sync (the `KanbanProvider.queueIntegrationSync*` path that syncs ClickUp/Linear/Notion when a card changes column). That path does not exist headless — standalone has no `KanbanProvider` (it moves cards via the raw `moveSessionsToColumn` DB helper, `bootstrap.ts:381`). So the site's "syncs with Linear, Notion, and ClickUp" claim is only *partially* true after this piece: on-ingest ClickUp sync + Linear delete-archive + provider comment bridge, but not on-column-move Notion/Linear/ClickUp sync. Closing that gap is a separate follow-on (see Out of Scope) — do not report it as done here.

### Core problem (root-cause analysis) — shared context for all three ingestion pieces

The standalone bootstrap stubs the provider factories to null — `getClickUpService: () => null`, `getLinearService: () => null`, `getNotionService: () => null` (`bootstrap.ts:545-547`). So even once headless ingests plans (piece 2), no provider work fires. Supply real standalone implementations.

**Two distinct factory consumers (verified against source — this corrects the earlier "the engine already takes all three" framing):**
1. **The ingestion engine (piece 1) — `getClickUpService` + `getLinearService` ONLY.** The extracted engine carries exactly the two factories the current watcher's constructor takes (`GlobalPlanWatcherService.ts:95-96`). On the ingestion path it fires **ClickUp real-time `debouncedSync`** on import (`:1047`) and **Linear `archiveIssue`** on delete/purge (`:531`). **There is no Notion factory on the engine** and no Notion sync on the ingestion path at all.
2. **The `LocalApiServer` options — all three factories.** The `bootstrap.ts:545-547` stubs feed the API server options, consumed at `LocalApiServer.ts:731-732` for the `/comment` bridge (`postManagedComment`, `:739`) and provider-backed verbs (`getClickUpService` also read at `:2284/:2320/:2397/:2455`) — a *separate* consumer from the engine.

So this piece has two wirings, not one: feed the two ClickUp/Linear factories into **piece 2's engine construction** (drives ingestion-path sync), and feed all three into the **`LocalApiServer` options** (drives the comment bridge / provider verbs). Notion gets a real service for the API-server consumer, but has **no ingestion-path sync to hook** — see the out-of-scope note on column-move sync below.

> Piece 3 of 3 (all three ship for parity — they are phases, not options): (1) engine + VS Code adapter, (2) standalone ingestion, **(3) headless provider sync [this plan]**. Depends on piece 2.

## Metadata
- **Tags:** standalone, npx, headless, provider-sync, clickup, linear, notion
- **Complexity:** 5
- **Project:** Browser Switchboard
- **Release phase:** Headless parity completion — the last ingestion piece. Additive (no extension path change, no VSIX gate). Depends on piece 2's standalone ingestion.

## Resolved Decisions (were "User Review Required")
- **Notion config path — RESOLVED (was open).** Notion's config is **not** a workspace `notion.json` and is **not** a bootstrap metadata path like `clickupMetadataPath` / `linearMetadataPath`. `NotionFetchService.loadConfig` (`NotionFetchService.ts:32`) delegates to `GlobalIntegrationConfigService.loadConfig('notion')`, which reads the **global** `~/.switchboard/integration-config.json` (`GlobalIntegrationConfigService.ts:73`) — a single global file holding all three providers' config. So the Notion factory does not need a new bootstrap path; it constructs `NotionFetchService` and lets it load from the global store. (Note: `clickupMetadataPath` / `linearMetadataPath` at `bootstrap.ts:543-544` are the *workspace* list-mapping metadata, a separate concern from the global credential/config store.)
- **Secrets seam — NEW finding, must be handled.** The provider service constructors take a **`vscode.SecretStorage`**, not the host-agnostic `HostSecrets` seam: `new ClickUpSyncService(workspaceRoot, context.secrets)` (`extension.ts:1630`) and `new LinearSyncService(workspaceRoot, context.secrets)` (`:1786`). Headless has no `vscode.SecretStorage`. `StandaloneHostSecrets` (`hostServices.ts:114`) implements the `HostSecrets` interface (`hostSeams.ts:334` — `get`/`store`/`delete`), which is shape-compatible with `SecretStorage` **except** it lacks `onDidChange`. **Recommended approach (keeps this piece additive / no VSIX gate):** wrap `StandaloneHostSecrets` in a duck-typed `SecretStorage`-shaped adapter (its `get`/`store`/`delete` + a no-op `onDidChange`) inside standalone, and pass that to the service constructors — do **not** change the shipped `ClickUpSyncService` / `LinearSyncService` constructor signatures (that would touch the ~4,000-install extension path and re-introduce a VSIX gate). This is why the complexity is 5, not 4: the wiring is small but the secrets-type impedance mismatch is real and must be bridged.
- **Column-move sync + full 3-provider parity is tracked separately in `provider-sync-full-parity.md`.** The extension already syncs all three providers on column moves via the merged `RemoteProvider` seam (`KanbanProvider.queueIntegrationSyncForSession` `:6220` / `queueIntegrationSyncForPlanFile` `:6244`); headless lacks `KanbanProvider`, so that path doesn't run headless. This piece ships the ingest-path subset (ClickUp content-on-import + Linear archive-on-delete) independently. Making the merged sync seam host-agnostic enough to run headless — and reaching full cross-provider parity — is `provider-sync-full-parity.md`'s concern, not a blocker for this piece.

## Scope

### ✅ IN SCOPE
- **Real standalone provider factories** replacing the `() => null` stubs: back `getClickUpService` / `getLinearService` / `getNotionService` with the existing provider config (ClickUp/Linear credentials + Notion via the global `integration-config.json` through `GlobalIntegrationConfigService`) + the `StandaloneHostSecrets`-backed `SecretStorage` adapter (see Resolved Decisions).
- **Feed `getClickUpService` + `getLinearService` into piece 2's engine construction** so the ingestion-path sync (ClickUp real-time on import, Linear archive on delete) fires headless. The engine has no Notion factory — do not attempt to pass one.
- **Feed all three factories into the `LocalApiServer` options** (`bootstrap.ts:545-547`) so the `/comment` bridge (`LocalApiServer.ts:731-739`) and provider-backed verbs resolve a real service headless instead of `null`.

### ⚙️ OUT OF SCOPE
- Ingestion itself (pieces 1 & 2).
- **Column-move-triggered integration sync (tracked in `provider-sync-full-parity.md`, NOT this piece).** The extension syncs ClickUp/Linear/Notion when a card changes column via `KanbanProvider.queueIntegrationSyncForSession` / `queueIntegrationSyncForPlanFile` (`KanbanProvider.ts:6220/6244`), on the merged `RemoteProvider` seam. Headless has no `KanbanProvider` (it moves cards via the raw `moveSessionsToColumn` helper, `bootstrap.ts:381`), so this doesn't run headless. Making that seam callable from the headless move path is part of the `provider-sync-full-parity.md` effort, not this ingestion piece.
- Any NEW provider network surface beyond the providers the user has already configured.
- Changing the shipped `ClickUpSyncService` / `LinearSyncService` constructor signatures (would re-introduce an extension-path change + VSIX gate — use the standalone adapter instead).
- Terminals/CLI dispatch, Remote Control (VS Code-only).

## Implementation Steps
1. **Secrets adapter** — add a standalone `SecretStorage`-shaped adapter wrapping `StandaloneHostSecrets` (its `get`/`store`/`delete` + a no-op `onDidChange`) so the vscode-typed service constructors accept it without an extension-path change.
2. **Factories** — implement standalone `getClickUpService` / `getLinearService` (construct `ClickUpSyncService` / `LinearSyncService` with `workspaceRoot` + the secrets adapter) / `getNotionService` (construct `NotionFetchService`, which self-loads from the global `integration-config.json`).
3. **Wiring** — pass `getClickUpService` + `getLinearService` into **piece 2's engine construction** (so the ingestion path syncs), and replace **all three** `() => null` stubs in the `bootstrap.ts` `LocalApiServer` options object (`:545-547`) with the real factories (so the comment bridge / provider verbs resolve).
4. **Verify** — a ClickUp-linked plan real-time-syncs and a Linear-linked plan archives-on-delete on ingestion headless; a Notion service resolves for the `/comment` bridge; and an unconfigured provider is a graceful no-op (null service, 503 on the bridge), matching the null-stub behaviour it replaces.

## Complexity Audit
- **Routine:** the metadata paths, global config store, and secret storage already exist; the factory bodies are thin.
- **Complex / Risky (the reason for complexity 5, not 4):** the secrets-type impedance mismatch — service constructors want `vscode.SecretStorage`, headless has `HostSecrets`. Bridged by the standalone `SecretStorage` adapter so no shipped constructor changes. Confirm `ClickUpSyncService` / `LinearSyncService` never call a `SecretStorage` member beyond `get`/`store`/`delete` (e.g. `onDidChange`); if one does, the no-op event must be sufficient.

## Edge-Case & Dependency Audit
- **Security / Integrity:** provider secrets read via the `StandaloneHostSecrets`-backed adapter only; Notion config via the existing global `integration-config.json`; no new network surface beyond configured providers; an unconfigured provider yields a null service (unchanged behaviour).
- **Depends on:** piece 2 (the standalone host must be constructing the engine and running ingestion batches for sync to have anything to fire on). Both pieces edit `bootstrap.ts` — piece 2 lands the engine-construction call with `() => null` callbacks; this piece amends that same call to pass the two real factories and swaps the three `LocalApiServer` option stubs. Sequential, distinct regions — no merge.
- Full cross-provider / all-trigger parity headless is tracked separately in `provider-sync-full-parity.md`; without it, this piece delivers the ingest-path subset (ClickUp content-on-import + Linear archive-on-delete).

## Adversarial Synthesis
Two real risks. (1) Credential handling — mitigated by reusing the existing `StandaloneHostSecrets` / global-config paths and adding no network surface beyond what the user configured; if no provider is configured, behaviour is identical to today's null stub. (2) The `SecretStorage` type gap silently failing at runtime — mitigated by the duck-typed adapter and a construction smoke-test that a real service (not null) is returned for a configured provider.

## Proposed Changes
### `src/standalone/bootstrap.ts`
- Replace `getClickUpService`/`getLinearService`/`getNotionService` `() => null` in the `LocalApiServer` options object (`:545-547`) with real factories (secrets adapter + global config).
- Pass the `getClickUpService` + `getLinearService` factories into piece 2's engine construction (the engine takes only these two — no Notion slot).
### `src/standalone/hostServices.ts`
- Provide the `SecretStorage`-shaped adapter over `StandaloneHostSecrets` (and any Notion config plumbing, if the global-config self-load needs a nudge).

## Verification Plan
### Automated
- A ClickUp-linked plan ingested headless triggers `debouncedSync` against the configured ClickUp service; a Linear-linked plan deleted headless triggers `archiveIssue` (delete-sync gated on `deleteSyncEnabled`); an unconfigured provider yields a null service and is a no-op — matching `GlobalPlanWatcherService`.
- A real Notion/ClickUp/Linear service resolves for the `LocalApiServer` `/comment` bridge instead of `null` (503 when unconfigured, unchanged).
- The `SecretStorage` adapter smoke-test: a configured provider factory returns a constructed service (not `null`) with credentials readable through the adapter.
### Manual
- Configure ClickUp, `npx switchboard`, ingest a ClickUp-linked plan → it syncs (visible in the tracker), matching the extension. Delete a Linear-linked plan → the issue archives.
- Note (expected, not a bug): moving a card between columns headless does NOT sync to Notion/Linear/ClickUp — that path is the out-of-scope column-move follow-on.

**Stage Complete:** CREATED

## Review Findings

Files changed by review — `src/standalone/vscodeShim.ts`: added `env.openExternal` (NotionFetchService calls `vscode.env.openExternal` and the shim's `env` namespace lacked it, risking a raw `TypeError` if a Notion auth/link flow is reached headless; now logs best-effort like the headless HostSeams). Confirmed the SecretStorage adapter exposes `get`/`store`/`delete`/`keys`/`onDidChange` and that ClickUp/Linear/Notion only touch `get`/`store`/`delete` on the ingest path, the two ClickUp/Linear factories feed the engine, and all three feed the `LocalApiServer` options — all as specified. **No CRITICAL/MAJOR issues.** Observation (non-blocking): bootstrap also passes `getNotionService` into the engine (4th arg), so headless additionally gets Notion archive-on-purge — this exceeds this plan's stated "engine has no Notion factory" scope but is a harmless, `deleteSyncEnabled`-gated bonus inherited from the merged engine. NITs: `vscode.QuickPickItem` (LinearSyncService) isn't exported by the shim (type-only, erased — the standalone bundle built) and shim `getConfiguration` reconstructs the config provider per `get()` call (correct, slightly inefficient). Verification (compile/tests skipped per directive): verified the provider vscode-surface (`SecretStorage`, `window.showInputBox/showQuickPick/showError/showWarning`, `Uri.parse`, `env.openExternal`) is now fully covered by the shim, and interactive `showInputBox`/`showQuickPick` reject (never hit on the ingest path).

**Review complete.** One MINOR shim gap (`env.openExternal`) fixed; provider factory wiring and the SecretStorage impedance-bridge match the plan. Remaining risk: on-column-move provider sync remains absent headless (expected — tracked in `provider-sync-full-parity.md`).
