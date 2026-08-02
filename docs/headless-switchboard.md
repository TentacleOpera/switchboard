# Headless Switchboard — Setup Parity, Secret Management & Cross-Host Sync

This document describes the setup configuration architecture, secret management, and cross-host synchronization model between the VS Code Extension host and the Standalone (browser / `npx switchboard`) host.

## Overview

The Setup panel and Design panel in the browser cockpit maintain functional parity with the VS Code editor experience.

### Key Rules & Behavior

1. **Setup Parity**: The browser Setup panel displays all configuration tabs present in the editor (theme, effects, database, control plane, mappings, plan scanner, status bar, and remote control).
2. **Secrets Storage & Machine-Global Bridge**:
   - Secrets are stored in a machine-global AES-256-GCM encrypted store located at `~/.switchboard/secrets.enc` with decryption key at `~/.switchboard/.master-key` (both set to mode `0o600`).
   - When running inside VS Code, a one-way mirror automatically synchronizes API tokens saved in VS Code SecretStorage into the machine-global encrypted store on activation and on change.
   - When running standalone (`npx switchboard`), users can enter API tokens directly in the browser cockpit Setup panel (enabled via `allowSecretWritesOverHttp` on `LocalApiServer` and `secretsEntry: true` capability) or manage secrets using the CLI (`npx switchboard secrets set/list/delete`).
   - Editor secret storage remains authoritative in VS Code. **Deleting** a token in VS Code propagates the delete to the machine-global store, so standalone loses access — that is the intended one-way-mirror semantic.
   - The two mirror paths differ deliberately: `onDidChange` propagates deletes, the activation backfill sweep only ever **writes**. A key the editor has never held is not evidence the user wants it gone, so tokens set via the CLI or the browser Setup panel survive every VS Code launch.
   - Aliases: `npx switchboard secrets set clickup <token>` resolves to `switchboard.clickup.apiToken` (likewise `linear`, `notion`, `stitch`, `apiToken`). A dotted key passes through verbatim; an unrecognised bare word is rejected with the alias table rather than silently stored under a key no service reads. `secrets list` prints key names only, never values.
3. **Threat Model**:
   - The encrypted file store protects against accidental leakage (git commits, system logs, workspace backups) rather than local OS users. The encryption key and store reside in the same user home directory (mode `0o600`), adopting the same security model as `~/.aws/credentials`.
   - `SWITCHBOARD_MASTER_KEY` / `SWITCHBOARD_MASTER_PASSPHRASE` override the file key. The passphrase is stretched with scrypt under a **fixed** salt, so it is obfuscation-plus rather than a per-user KDF; the threat model above applies to it unchanged. Because the store is shared by the editor host, the standalone host and the CLI, decryption tries the env-derived key *and* the file key before declaring a store corrupt — a host that lacks the env var will not rename away a store written by one that has it.
4. **Migration**:
   - Legacy per-workspace secret stores (`<workspaceRoot>/.switchboard/secrets.enc`) are automatically migrated to the machine-global store on standalone startup and renamed to `secrets.enc.migrated.bak` (never deleted). Import runs to completion synchronously before the renames and before any service reads the store; on a collision the existing non-empty global value wins and the resolution is logged by key name.
   - If the legacy `.master-key` is missing, or the legacy store cannot be decrypted, nothing is imported and **both** legacy files are left in place for manual recovery — the rename is the receipt for a completed import, so it is never issued speculatively.
   - An undecryptable store is renamed to `secrets.enc.corrupt-<timestamp>.bak` and a fresh store starts. A store that is present but *unreadable* (permissions, IO error) is left strictly alone and subsequent writes fail loudly rather than replacing ciphertext that was never read.
5. **Canonical Store for Config**: `.switchboard/config.json` is the single canonical source of truth for cross-host configuration settings (`switchboard.*`). Both the editor host (`VscodeHostPathConfigProvider`) and the standalone host (`StandaloneHostPathConfigProvider`) read `.switchboard/config.json` first, with fallbacks to VS Code workspace configuration when unpopulated.
6. **Cross-Host Sync & Echo Guard**:
   - Updates made in one host persist to `.switchboard/config.json` and trigger `onConfigChanged` listeners on the host seams.
   - `SetupPanelProvider` receives mutation events and broadcasts `switchboardThemeChanged` / `settingsChanged` with an `originatorId` tag across bound webviews and all connected WebSocket clients via `BroadcastHub.push()` / `wsHub.broadcast()`. Single-site broadcast from `SetupPanelProvider` is sufficient because `wsHub.broadcast()` fans out to every active browser tab across all panels.
   - Webview panels enforce a three-layer echo guard:
     - **Layer (a)**: Webview message listeners ignore broadcasts carrying their own `originatorId`.
     - **Layer (b)**: Programmatic input value updates set `window.__applyingBroadcast = true`.
     - **Layer (c)**: Input change event listeners no-op while `window.__applyingBroadcast` is active.

## Board URL & Hostname

The standalone host serves the board over plain HTTP on loopback. The URL has three moving parts, and only two of them are user-controllable.

### Shape

```
http://<hostname>:<port>/[panel][?token=<one-time-token>]
```

- **Port** — ephemeral by default; `--port <number>` pins it.
- **Hostname** — `127.0.0.1` by default; `--hostname <name>` changes it (see below).
- **Panel path** — `/` (the shell) plus the directly addressable panels: `/board`, `/panels`, `/project`, `/memo`, `/planning`, `/design`, `/setup`, `/terminals` (each also accepts a `.html` suffix). Every one of them honours `?token=`, so any panel can be the landing page.
- **Token** — consumed once, exchanged for an 8-hour `sb_session` cookie, then `303`-redirected away. The address bar settles on the bare URL; later visits need no token.

### `--hostname`

```
npx switchboard --port 4321 --hostname switchboard.localhost
```

Accepted names are restricted to the loopback set: `127.0.0.1`, `localhost`, `::1`, and anything under the reserved `.localhost` TLD. RFC 6761 §6.3 requires resolvers to map `.localhost` and every name beneath it to loopback, so no `/etc/hosts` entry is needed and the name cannot be aimed elsewhere. `LocalApiServer` and the CLI share one predicate (`src/utils/loopbackHostname.ts`) so a name the CLI prints can never be one the server's `Host` guard rejects.

**This is presentation only.** The server still binds `127.0.0.1`, still rejects any non-loopback peer at the socket level, and still refuses a `Host` header outside the loopback set. `--hostname` does not expose the board to the LAN, and there is no flag that does.

Two consequences worth knowing:

- **Cookie jars are per-origin.** A session established at `switchboard.localhost:4321` does not carry over to `127.0.0.1:4321` — the second origin needs its own token exchange. Pick one hostname and stay on it.
- **Resolution is the browser's job.** Chromium, Safari and Firefox ≥ 84 map `*.localhost` to loopback; some older browsers and non-browser HTTP clients defer to the system resolver, which may not. Because an unresolvable name never reaches the server, the one-time token is not spent — the CLI prints the `127.0.0.1` fallback URL alongside, and it stays valid.

### Dropping the port

Nothing in Switchboard can remove `:<port>` from the URL — that requires listening on port 80, which needs root. A same-machine reverse proxy is the supported route, and it must rewrite the `Host` header to a loopback name and forward the WebSocket upgrade (`/ws`, `/ws/terminal`), or the board will 403 or render without live updates.
