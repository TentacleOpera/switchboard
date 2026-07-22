# Headless Switchboard — Setup Parity & Cross-Host Sync

This document describes the setup configuration architecture and cross-host synchronization model between the VS Code Extension host and the Standalone (browser / `npx switchboard`) host.

## Overview

The Setup panel and Design panel in the browser cockpit maintain functional parity with the VS Code editor experience.

### Key Rules & Behavior

1. **Setup Parity**: The browser Setup panel displays all configuration tabs present in the editor (theme, effects, database, control plane, mappings, plan scanner, status bar, and remote control).
2. **Secret Entry Gating**: The browser cannot enter raw API tokens or secrets. The input fields for raw secrets (`ClickUp`, `Linear`, `Notion`, `Multi-Repo PAT`, and `Stitch API Key`) are disabled in browser mode with an inline hint advising users to set keys within VS Code. Server-side HTTP verb handlers return `403 Forbidden` for secret-write attempts over HTTP.
3. **Canonical Store**: `.switchboard/config.json` is the single canonical source of truth for cross-host configuration settings (`switchboard.*`). Both the editor host (`VscodeHostPathConfigProvider`) and the standalone host (`StandaloneHostPathConfigProvider`) read `.switchboard/config.json` first, with fallbacks to VS Code workspace configuration when unpopulated.
4. **Cross-Host Sync & Echo Guard**:
   - Updates made in one host persist to `.switchboard/config.json` and trigger `onConfigChanged` listeners on the host seams.
   - `SetupPanelProvider` receives mutation events and broadcasts `switchboardThemeChanged` / `settingsChanged` with an `originatorId` tag across bound webviews and all connected WebSocket clients via `BroadcastHub.push()` / `wsHub.broadcast()`. Single-site broadcast from `SetupPanelProvider` is sufficient because `wsHub.broadcast()` fans out to every active browser tab across all panels.
   - Webview panels enforce a three-layer echo guard:
     - **Layer (a)**: Webview message listeners ignore broadcasts carrying their own `originatorId`.
     - **Layer (b)**: Programmatic input value updates set `window.__applyingBroadcast = true`.
     - **Layer (c)**: Input change event listeners no-op while `window.__applyingBroadcast` is active.
