# Standalone Secrets Bridge: Machine-Global Encrypted Store, VS Code Mirror, and CLI Fix

## Goal

Make API tokens entered in VS Code available to the standalone host (`npx switchboard`) so the browser cockpit works without VS Code running — using the **existing** AES-256-GCM encrypted file store, not kanban.db and not a new secrets.db.

### Problem analysis / root cause

Standalone mode ships with a working encrypted secrets store (`StandaloneHostSecrets`, `src/standalone/hostServices.ts:128-199`: AES-256-GCM, per-write random IV, `0o600` files) and every integration service (`ClickUpSyncService`, `LinearSyncService`, `NotionFetchService`, Stitch) reads tokens through an injected SecretStorage-shaped interface — the services don't care which store backs them. Yet every integration route dies in standalone (`/api/clickup` → 500 "ClickUp API token not configured" at `ClickUpSyncService.ts:2522`, same for Linear at `LinearSyncService.ts:1918`, Notion at `NotionFetchService.ts:82`). Four composing root causes:

1. **Two disjoint stores, no bridge.** VS Code SecretStorage (OS keychain) and `secrets.enc` share only the key-name namespace. Nothing ever copies a token from one to the other, in either direction.
2. **The CLI escape hatch is broken.** `npx switchboard secrets set clickup pk_…` stores under the literal argv key `"clickup"` (`src/standalone/cli.ts:98-111` passes `process.argv[4]` verbatim), while the service reads `"switchboard.clickup.apiToken"` (`ClickUpSyncService.ts:2410`). The token is written to a key nothing reads, and the printed usage string advertises the broken short names. There is also no way to audit the store: the shim's `SecretStorage.keys()` returns `[]` unconditionally (`vscodeShim.ts:62-67`).
3. **Wrong scope.** The store is per-workspace (`<workspaceRoot>/.switchboard/secrets.enc`, `hostServices.ts:134-135`) but API tokens are machine-scoped — the machine-global precedent already exists (`~/.switchboard/integration-config.json` via `utils/stateHome.ts:35`, the `stateFile()` helper). Per-workspace also puts ciphertext + key inside the repo directory, protected from `git add` only incidentally by the `.switchboard/*` glob at `.gitignore:52` — neither `secrets.enc` nor `.master-key` is named explicitly.
4. **The browser can never self-serve.** Both hosts hard-403 secret-write verbs over HTTP (`LocalApiServer.ts:1662-1670`, `:1698-1712`) and set `secretsEntry: false` (`TaskViewerProvider.ts:1836`, `bootstrap.ts:390`), so a standalone-only user has no working path to enter a token at all.

### Explicitly rejected alternatives

- **kanban.db**: read directly by fleet agents via the `query-switchboard-kanban` skill (would hand tokens to every agent's sqlite3 query); sql.js whole-DB-in-WASM with a known heap-exhaustion failure mode; whole-file persist on every write. Wrong substrate for credentials.
- **A new secrets.db**: strictly more work than the existing `secrets.enc` for zero gain, plus the same key-management question.

### Threat model (decided, stated plainly)

The mirror moves tokens from the OS keychain to a file whose decryption key sits in the same home directory (both `0o600`). That protects against accidental leakage (git, backups, log dumps), not against a local attacker — the same threat model as `~/.aws/credentials`. This is an accepted trade-off for VS Code-free operation. OS-keychain-backed standalone storage (e.g. shelling out to `security` on macOS) is a possible later hardening and is out of scope here. Note the `SWITCHBOARD_MASTER_PASSPHRASE` env override uses scrypt with a fixed salt (`'switchboard-standalone'`, `hostServices.ts:144`) — it is obfuscation-plus, not a per-user KDF; the threat model above applies to it unchanged.

## Metadata

**Complexity:** 6
**Tags:** backend, security, cli, infrastructure, feature

## User Review Required

- **Threat-model acceptance.** The mirror moves tokens from the OS keychain to `~/.switchboard/secrets.enc` whose decryption key (`~/.switchboard/.master-key`) sits in the same home directory. Confirm this `~/.aws/credentials`-class trade-off is acceptable before implementation.
- **Opening HTTP secret-write verbs on standalone.** The 403 gate in `LocalApiServer` is relaxed for the standalone host only (session-cookie auth enforced). Confirm the CSRF mitigation approach (SameSite=Strict session cookie + required bearer/cookie auth on every verb) is sufficient.
- **Legacy migration renames, never deletes.** Per-workspace `secrets.enc` / `.master-key` become `*.migrated.bak` files left in the workspace `.switchboard/` dir. Confirm the rename-not-delete policy.

## Non-Goals

- No secrets in kanban.db or any SQLite database.
- No change to where the **extension** reads its own tokens (VS Code SecretStorage stays authoritative in the editor).
- No secret entry over HTTP on the **extension-hosted** server — the 403 gate stays for the extension host; only standalone (which enforces real session-cookie auth) is opened up.
- No OS-keychain integration for standalone in this plan.

## Complexity Audit

### Routine

- Extracting `StandaloneHostSecrets` into a shared module — it already depends only on `node:crypto`, `node:fs`, `node:path`; the move is mechanical.
- CLI alias map for `secrets set`, plus `secrets list` / `secrets delete` subcommands — straightforward argv handling in `cli.ts:98-113`.
- Implementing `keys()` on the store + shim adapter — one-line enumeration of `_cache` (`vscodeShim.ts:62-67`).
- `.gitignore` entries and docs update.
- Flipping `secretsEntry: true` in standalone capabilities (`bootstrap.ts:390`) — the client gating in `transport.js:350-441` is already capability-driven, no client change.

### Complex / Risky

- **Legacy migration correctness.** Shipped per-workspace stores must be imported exactly once, with collision resolution, rename-not-delete semantics, and no data loss on decrypt failure — all on the boot path where failures are easy to swallow.
- **Opening the HTTP secret-write gate.** A new `allowSecretWritesOverHttp` option changes the security posture of `LocalApiServer` (`:1662-1670`, `:1698-1712`). Must be opt-in, default-closed, and provably unreachable from the extension host wiring.
- **Cross-store staleness.** The mirror writes the file store while a running standalone holds an in-memory `_cache` (`hostServices.ts:131`) loaded once at construction — no invalidation today.
- **Concurrent standalone instances in different workspaces** share one global store after relocation; `_save()` has no atomicity guarantees (whole-file `writeFileSync`, `hostServices.ts:180-190`).

## Edge-Case & Dependency Audit

### Race Conditions

- **Concurrent `_save()` from two standalone hosts** (different workspaces, one global store): last-writer-wins whole-file overwrite can silently drop a token written by the other process. Mitigation: atomic write — write to `secrets.enc.<pid>.tmp` then `fs.renameSync` over the target (rename is atomic on POSIX and effectively atomic on Windows for same-volume). Document that simultaneous token writes across workspaces are unsupported; per-workspace single-instance is already enforced by `findRunningInstance` (`cli.ts:116-121`) but cross-workspace is not.
- **Stale in-memory cache:** mirror writes the file while standalone is running → `_cache` is a fossil. Mitigation: stat `secrets.enc` mtime on `get()`; if newer than last load, re-`_load()` before serving. Cheap (one `statSync` per read), closes the fossil window without a watcher.
- **Migration vs. mirror write on the same boot:** run migration synchronously in the store constructor *before* the first `get()`, so no read can observe the half-migrated state.

### Security

- **CSRF on newly-opened secret-write verbs.** The standalone session cookie `sb_session` rides every browser request automatically. Verify the cookie is set `SameSite=Strict` (add if absent), and confirm the webview's verb POSTs carry the auth header/cookie that `_checkAuth` requires (`LocalApiServer.ts:500-503` standalone branch). With SameSite=Strict + required session auth, cross-site token-overwrite is not reachable. This is a verification step, not a new mechanism.
- **Key material on disk.** `~/.switchboard/.master-key` is `0o600`; keep the mode on every write path (current `_getOrCreateKey` already does, `hostServices.ts:157-158`). New global paths must not regress this.
- **`.bak` leakage.** Migration leaves plaintext-equivalent `.migrated.bak` files (still encrypted, with their key `.master-key.migrated.bak` beside them) inside workspace dirs. The new explicit `.gitignore` entries (`secrets.enc*`, `.master-key*`) must cover the `.bak` suffixes.
- **Fixed-salt scrypt** on `SWITCHBOARD_MASTER_PASSPHRASE` — documented in the threat model; no change.
- **`secrets list` must print key names only, never values** — enforced by printing `keys()` output with no `get()` call.

### Side Effects

- **Every activation backfills the global store** — a write to `~/.switchboard/` from the extension host on every VS Code launch. Idempotent and cheap, but it is a new write outside the workspace; logged at debug level only (never log values).
- **Mirror delete propagation:** deleting a token in VS Code removes it from the global store → standalone loses access. This is intended (one-way mirror semantics) and must be stated in the docs.
- **Mirror failures must never break editor token saves** — wrap mirror writes in try/catch with a warning log; the `context.secrets` write has already succeeded by the time the mirror runs.

### Dependencies & Conflicts

- `utils/stateHome.ts` `stateFile()` already throws in test processes without `SWITCHBOARD_STATE_HOME` (`stateHome.ts:25-29`) — any test harness seeding the global store must preload the sandbox or set the env var, same as `integration-config.json` tests do today.
- The shared store module must keep **zero imports from `src/standalone/**`** so the extension bundle can import it without dragging in the standalone host.
- `SetupPanelProvider` is already instantiated with headless seams in standalone (`bootstrap.ts:510-515`) and `setupVerb` is already routed (`bootstrap.ts:1014-1015`) — implementation must **verify** each token-save verb writes through `headlessSeams.secrets` rather than re-implementing the arms.
- No conflict with the `switchboard.apiToken` (LocalApiServer auth) key — explicitly excluded from mirroring; standalone mints its own session tokens (`bootstrap.ts:1003`).

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) concurrent `_save()` from two standalone hosts racing on one global file; (2) stale in-memory `_cache` after a mirror write to a running standalone; (3) CSRF exposure from opening secret-write verbs behind an automatically-sent session cookie. Mitigations: atomic temp-file-and-rename writes plus an mtime recheck on `get()`; SameSite=Strict on `sb_session` with required session auth on every verb (verification step, not new machinery); migration collision resolution logged. The plan's core design — one-way mirror into the existing encrypted store — survives review unchanged.

## Proposed Changes

### `src/services/encryptedSecretsStore.ts` (new shared module)

- **Context:** `StandaloneHostSecrets` currently lives inside `src/standalone/hostServices.ts:128-199`, unimportable by the extension bundle without pulling in the standalone host.
- **Logic:** Extract the class verbatim into a new shared module. It uses only `node:crypto` + `node:fs` + `node:path` — safe for both bundles. Keep zero imports from `src/standalone/**` in the shared module; re-export from `hostServices.ts` for existing standalone callers.
- **Implementation:**
  - Constructor takes explicit `storePath` + `keyPath` (replacing the workspace-root join at `hostServices.ts:133-136`) so callers decide scope.
  - `_save()` becomes atomic: write `secrets.enc.<pid>.tmp` then `fs.renameSync` onto the store path; preserve `{ mode: 0o600 }`.
  - `get()` stats the store file and re-`_load()`s if mtime advanced since last load (closes the mirror-vs-running-host staleness window).
  - Add `keys(): Promise<string[]>` returning `Array.from(this._cache.keys())`.
  - Fix the silent-total-loss failure mode at `hostServices.ts:175-177`: on decrypt failure, do NOT proceed with an empty cache that overwrites the store on next write — rename the unreadable file to `secrets.enc.corrupt-<timestamp>.bak`, log loudly, and start fresh.
- **Edge Cases:** missing store (first run) → empty cache, no error; store shorter than `IV_LENGTH + TAG_LENGTH` → treated as corrupt (same rename path); corrupt-rename target already exists → suffix with counter.

### `src/standalone/hostServices.ts` (re-scope to machine-global, with migration)

- **Context:** Store paths are per-workspace (`hostServices.ts:134-135`) but tokens are machine-scoped; the machine-global precedent exists (`~/.switchboard/integration-config.json` via `stateFile()`, `utils/stateHome.ts:34-36`).
- **Logic:** Standalone host constructs the store at `stateFile('secrets.enc')` + `stateFile('.master-key')`. On construction, migrate any legacy per-workspace store exactly once.
- **Implementation:**
  - Migration (shipped state — must migrate, never assume it didn't ship): if `<workspaceRoot>/.switchboard/secrets.enc` exists, decrypt with the co-located legacy `.master-key`, import entries into the global store. Collision rule: global wins if its value is non-empty; otherwise the legacy value wins; **log each resolved collision** (key name only, never values). Then rename both legacy files to `secrets.enc.migrated.bak` / `.master-key.migrated.bak`. Never unlink.
  - Migration runs synchronously in the constructor before the first `get()` — no read may observe a half-migrated state.
  - Preserve the `SWITCHBOARD_MASTER_KEY` / `SWITCHBOARD_MASTER_PASSPHRASE` env overrides (`hostServices.ts:140-152`) unchanged, including the fixed-salt scrypt documented in the threat model.
- **Edge Cases:** legacy store exists but legacy key missing → treat legacy as unmigratable, log loudly, leave files in place (do NOT rename — no way to prove import happened); global store absent → import produces the entire global content.

### Extension activation (`src/extension.ts`) — one-way mirror

- **Context:** VS Code SecretStorage (OS keychain) and the file store share only key names; nothing bridges them (root cause 1). Individual `store()` call sites (`extension.ts:1621/1751/1779`, `TaskViewerProvider.ts:6120/6288/6980`, service-level writes) are too many to instrument safely.
- **Logic:** Single choke point — the `context.secrets.onDidChange` event plus an activation backfill sweep covers every writer without touching call sites.
- **Implementation:**
  - **Activation backfill sweep:** read the four provider keys from `context.secrets` — `switchboard.clickup.apiToken`, `switchboard.linear.apiToken`, `switchboard.notion.apiToken`, `switchboard.stitch.apiKey` — and write any non-empty values into the global encrypted store. Idempotent, runs every activation (cheap; covers installs that set tokens before this feature existed).
  - **Live mirror:** subscribe to `context.secrets.onDidChange`; when the changed key is in the allowlist above, re-read it and write through (or delete from the file store when `get()` returns undefined).
  - Do NOT mirror `switchboard.apiToken` (LocalApiServer auth token — standalone generates its own session tokens) or the dead `switchboard.stitch.accessToken` (deleted at `extension.ts:1200`).
  - Mirror failures (disk full, permissions) log a warning; they must never break token saves in the editor — the `context.secrets` write has already succeeded when the mirror runs.
- **Edge Cases:** extension host on a machine where standalone never runs → harmless extra file writes; two VS Code windows → both mirror the same keychain values, last write is identical content, no conflict.

### `src/standalone/vscodeShim.ts` — enumerate

- **Context:** `SecretStorage.keys()` returns `[]` unconditionally (`vscodeShim.ts:62-67`), making the store unauditable.
- **Logic:** Delegate to the store's new `keys()`.
- **Implementation:** `async keys(): Promise<string[]> { return this._secrets.keys(); }` — remove the stale comment claiming enumeration is unneeded.
- **Edge Cases:** none beyond store behavior.

### `src/standalone/cli.ts` — fix the escape hatch

- **Context:** `secrets set clickup …` stores under literal argv key `"clickup"` (`cli.ts:98-111`) while services read `"switchboard.clickup.apiToken"` — the token lands in a key nothing reads, and the usage string advertises the broken short names.
- **Logic:** Alias map for `secrets set`: `clickup` → `switchboard.clickup.apiToken`, `linear` → `switchboard.linear.apiToken`, `notion` → `switchboard.notion.apiToken`, `stitch` → `switchboard.stitch.apiKey`, `apiToken` → `switchboard.apiToken`. Fully-qualified keys pass through unchanged. Unknown short names error printing the alias list.
- **Implementation:**
  - Add `secrets list` (key names only, never values — print `keys()` output, never call `get()`) and `secrets delete <key>` (same alias resolution as `set`).
  - Point the CLI at the global store (post-migration paths from the hostServices change) so CLI writes and standalone reads agree.
  - Update the usage string to show the alias table.
- **Edge Cases:** `secrets set` with a fully-qualified key not in the alias map → pass through (escape hatch for future keys); `secrets delete` of an absent key → succeed silently (idempotent).

### `src/services/LocalApiServer.ts` — opt-in secret-write gate

- **Context:** Both `_handleDesignVerb` (`:1662-1670`) and `_handleSetupVerb` (`:1698-1712`) hard-403 secret-write verbs. Standalone-only users have no working token-entry path (root cause 4).
- **Logic:** New `LocalApiServerOptions.allowSecretWritesOverHttp` flag — absent/false by default; the 403 rejection sets are consulted only when the flag is not set. Set `true` only by standalone bootstrap. The extension host wiring never sets it: its loopback-trust mode (`LocalApiServer.ts:500-503`, empty token → allow all) means an open gate there would be unauthenticated, which is exactly why it stays closed.
- **Implementation:** Gate both `SECRET_WRITE_VERBS` checks on `!this._options.allowSecretWritesOverHttp`. Standalone qualifies because `getAuthToken` returns a non-empty session token on every request (`bootstrap.ts:1003,1003` → `_checkAuth` standalone branch).
- **Edge Cases:** flag unset (extension host, tests, any future host) → behavior byte-identical to today.

### `src/standalone/bootstrap.ts` — enable browser token entry (standalone ONLY)

- **Context:** Standalone capabilities hard-code `secretsEntry: false` (`bootstrap.ts:390`); the client gating (`transport.js:350-441`) is already capability-driven.
- **Logic:** Flip `secretsEntry: true` in `baseStandaloneCapabilities`; pass `allowSecretWritesOverHttp: true` in the server options. The extension host stays `false` at `TaskViewerProvider.ts:1836` and never sets the server flag.

> **Superseded:** "Implement the standalone setup-verb arms that save tokens (`applyClickUpConfig`, `applyLinearConfig`, `applyNotionConfig`, `setClickUpToken`, `setLinearToken`, `setNotionToken`, `stitchSaveApiKey`) writing to the global store."
> **Reason:** The arms already exist — standalone `setupVerb` routes into the shared `SetupPanelProvider` (`bootstrap.ts:1014-1015`) constructed with `headlessSeams` (`bootstrap.ts:510-515`), so the verbs dispatch in standalone today; they are only unreachable because of the 403 gate. Re-implementing them would duplicate the extension host's setup logic.
> **Replaced with:** Verify each token-save verb writes through `headlessSeams.secrets` (the shim backed by the global store) as part of implementation — fix any verb that bypasses the seams; implement nothing wholesale. On success the setup panel does a `location.reload()` so `integrationsConfigured` / `secretsEntry` capability gating (`transport.js:350-441`) re-evaluates from fresh `data-host-capabilities`.

- Verify `sb_session` is set `SameSite=Strict` (add if absent) so the automatically-sent cookie cannot be ridden cross-site on the newly-opened verbs — required session auth plus SameSite=Strict closes the CSRF primitive.
- **Edge Cases:** save succeeds but reload races capability recompute → `computeIntegrationsConfigured` (`bootstrap.ts:392-402`) is async and re-run per capabilities fetch, so reload always sees fresh state.

### `.gitignore` + `docs/headless-switchboard.md`

- **Context:** Legacy `.bak` files remain in workspace `.switchboard/` dirs after migration; neither `secrets.enc` nor `.master-key` is named explicitly today (only the `.switchboard/*` glob at `.gitignore:52`, with carve-outs below it).
- **Implementation:** Add explicit entries for `.switchboard/secrets.enc*` and `.switchboard/.master-key*` (belt-and-braces covering `.migrated.bak` and `.corrupt-*.bak` suffixes).
- Update `docs/headless-switchboard.md`: standalone secret flow (mirror-from-editor as the zero-step path, CLI and browser entry as alternatives), the global store location, migration behavior (rename-not-delete), mirror delete propagation semantics, and the threat-model paragraph from this plan's Goal section.
- **Edge Cases:** workspaces on older extension versions keep the glob protection; the explicit lines also protect forks that drop the glob.

## Verification Plan

> **Superseded:** Contract tests in `src/test/` (migration seeding, corrupt-store handling, mirror write-through, CLI mapping, 403 gate) run as part of this plan's verification.
> **Reason:** Session directive — no project compilation and no automated test runs as part of this verification plan.
> **Replaced with:** Manual verification only, below. (The test scenarios remain documented inline as the acceptance behaviors to check by hand; automating them later is encouraged but out of scope for this pass.)

### Manual Verification

- **Migration:** seed a legacy `<workspaceRoot>/.switchboard/secrets.enc` + `.master-key` (e.g. via the old CLI on a scratch workspace), boot standalone, confirm entries readable from the global store and both legacy files renamed `*.migrated.bak` (never deleted). Repeat boot → no double import.
- **Corrupt-store handling:** write garbage over `~/.switchboard/secrets.enc`, boot standalone, confirm rename to `*.corrupt-*.bak`, loud log, fresh empty store — and that the next write does not silently resurrect the corrupt file.
- **Mirror:** set a ClickUp token in VS Code Setup → confirm `~/.switchboard/secrets.enc` updated (via `npx switchboard secrets list` showing `switchboard.clickup.apiToken`). Delete the token in VS Code → confirm it disappears from the list. Set `switchboard.apiToken`-adjacent values → confirm they are NOT mirrored.
- **Staleness:** with standalone running, change a token in VS Code → confirm standalone serves the new value (mtime recheck) without a restart.
- **CLI mapping:** `npx switchboard secrets set clickup X` → `secrets list` shows `switchboard.clickup.apiToken` (names only, no values); `secrets delete clickup` removes it; unknown short name errors with the alias list.
- **403 gate:** in the extension host, confirm the secret-write verbs still 403; in standalone, confirm `setClickUpToken` reaches the handler and persists. Confirm `sb_session` carries `SameSite=Strict`.
- **End-to-end UAT:** enter a ClickUp token in VS Code Setup → close VS Code → `npx switchboard` → Tickets/board provider affordances un-gate and `POST /api/clickup` proxies successfully; then in a clean environment (no editor ever run), enter a token via the standalone Setup panel in the browser and confirm the same.
