# Headless Switchboard — Setup Parity & Cross-Host Sync

This document describes the setup configuration architecture and cross-host synchronization model between the VS Code Extension host and the Standalone (browser / `npx switchboard`) host.

## Overview

The Setup panel and Design panel in the browser cockpit maintain functional parity with the VS Code editor experience.

### Key Rules & Behavior

1. **Setup Parity**: The browser Setup panel displays integration tabs (ClickUp, Linear, Notion) and the plan-scanner/theme tabs. Editor-substrate tabs (database, control plane, mappings, status bar, remote) that repoint the DB/config the editor is bound to are hidden in the browser — they are editor-only regardless of the entry-vs-use split.
2. **Secret Entry Gating**: The browser cannot enter raw API tokens or secrets. The input fields for raw secrets (`ClickUp`, `Linear`, `Notion`, `Multi-Repo PAT`, and `Stitch API Key`) are disabled in browser mode with an inline hint advising users to set keys within VS Code. Server-side HTTP verb handlers return `403 Forbidden` for secret-write attempts over HTTP.
3. **Canonical Store**: `.switchboard/config.json` is the single canonical source of truth for cross-host configuration settings (`switchboard.*`). Both the editor host (`VscodeHostPathConfigProvider`) and the standalone host (`StandaloneHostPathConfigProvider`) read `.switchboard/config.json` first, with fallbacks to VS Code workspace configuration when unpopulated.
4. **Cross-Host Sync**: Updates made in one host persist to `.switchboard/config.json` and broadcast live refresh events (`switchboardThemeChanged` / `settingsChanged`) across connected webview panels and WebSocket clients, with echo-guard protection against feedback loops.
