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
   - Editor secret storage remains authoritative in VS Code. Token deletions in VS Code propagate to the machine-global store.
3. **Threat Model**:
   - The encrypted file store protects against accidental leakage (git commits, system logs, workspace backups) rather than local OS users. The encryption key and store reside in the same user home directory (mode `0o600`), adopting the same security model as `~/.aws/credentials`.
4. **Migration**:
   - Legacy per-workspace secret stores (`<workspaceRoot>/.switchboard/secrets.enc`) are automatically migrated to the machine-global store on standalone startup and renamed to `secrets.enc.migrated.bak` (never deleted).
5. **Canonical Store for Config**: `.switchboard/config.json` is the single canonical source of truth for cross-host configuration settings (`switchboard.*`). Both the editor host (`VscodeHostPathConfigProvider`) and the standalone host (`StandaloneHostPathConfigProvider`) read `.switchboard/config.json` first, with fallbacks to VS Code workspace configuration when unpopulated.
6. **Cross-Host Sync & Echo Guard**:
   - Updates made in one host persist to `.switchboard/config.json` and trigger `onConfigChanged` listeners on the host seams.
   - `SetupPanelProvider` receives mutation events and broadcasts `switchboardThemeChanged` / `settingsChanged` with an `originatorId` tag across bound webviews and all connected WebSocket clients via `BroadcastHub.push()` / `wsHub.broadcast()`.
   - Webview panels enforce a three-layer echo guard to prevent broadcast loops.
