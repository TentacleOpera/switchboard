---
description: "In the standalone (npx, no-editor) host, settings don't persist: theme set in Setup reverts to afterburner after navigating away, because standalone globalState/workspaceState are IN-MEMORY Mementos that reset on every iframe reload. Back them with on-disk storage (or route setting reads/writes through the already-persistent config.json) so settings survive reloads and restarts — matching the editor. (The extension-hosted cockpit gets this free via real vscode config; this plan is the standalone-only counterpart.)"
---

# B2 · Browser Cockpit — Standalone Settings Persistence

## Metadata
- **Project:** browser-switchboard
- **Tags:** bugfix, backend, reliability
- **Complexity:** 4
- **Release phase:** B2 (browser cockpit). Standalone-only parity fix.
- **Dependencies:** None. Lower priority than the concurrency plan — `b2-cockpit-serve-from-extension-server-concurrent` makes settings persist for the concurrent-with-editor case for free (real `vscode` config). This plan covers the pure `npx`, no-editor case.

## Goal

In a standalone `npx switchboard` session, a setting changed in one panel (e.g. theme → claudify) must persist across panel navigation, iframe reloads, and process restarts — as it does in the editor.

### Problem / root-cause analysis

Reproduced by the user: set claudify in Setup → go to Board → return to Setup → it's back to afterburner. Root cause: the standalone composition root (`src/standalone/bootstrap.ts`) constructs providers with **in-memory** `globalState`/`workspaceState` Mementos (`inMemoryMemento()`), and each browser panel is a **separate iframe that reloads** on navigation. globalState-backed settings (theme among them) live only in that process's memory and are re-read as defaults on each panel load — and even within one session, writes from the Setup iframe aren't observed by the Board iframe because there's no shared durable store. Config.json-backed settings (via `StandaloneHostPathConfigProvider`) DO persist; globalState-backed ones do not. Theme (`switchboard.theme.name`) is the visible casualty.

## Proposed Changes

### `src/standalone/bootstrap.ts` — durable Memento
- **Context:** `inMemoryMemento()` supplies `globalState`/`workspaceState`. **Logic:** replace with a disk-backed Memento that reads/writes a JSON file under the workspace (`.switchboard/standalone-state.json` for globalState; a workspace-scoped file for workspaceState). `get` reads the in-memory cache (hydrated from disk at boot); `update` writes through to disk synchronously (small file, low frequency). **Implementation:** a small `fileBackedMemento(path)` factory returning `{ get, update, keys }` matching the `vscode.Memento` shape the providers expect. **Edge cases:** corrupt/missing file → start empty, don't crash; concurrent writers aren't a concern (single-writer), but debounce rapid writes.

### Prefer config.json for genuinely-global settings (recommended)
- For settings that are conceptually workspace/user config (theme, panel visibility), route reads/writes through the already-persistent `pathConfig` (config.json) rather than globalState, so there is ONE persistent source both hosts share and the theming plan's `getConfigStringWithDefault('theme.name')` reads the true value. Reserve the file-backed Memento for state that is genuinely globalState-only.

### Ensure every panel reads the persisted value on load
- With theming injected at HTML-generation time (see `b2-cockpit-real-icons-and-claudify-theming`), each panel's body class is computed from the persisted theme at serve time — so once persistence is fixed, navigating between panels shows the saved theme without any client-side sync. Verify the Setup "set theme" verb writes to the SAME store the HTML getters read.

## Edge-Case & Dependency Audit
- **Single source of truth:** avoid splitting a setting across localStorage (per-iframe, in `transport.js` getState/setState) AND server config — the durable server-side store is authoritative for cross-panel settings; localStorage is fine only for per-panel view state (scroll, expanded groups).
- **Extension host unaffected:** this touches only the standalone Memento wiring; the extension keeps real `vscode` globalState.
- **Migration:** none — first standalone run just starts with defaults and persists thereafter.

## Verification Plan
### Manual (the real DoD)
- Standalone `npx` session: set claudify in Setup → Board → Setup → still claudify. Restart the process → still claudify.
### Automated
- Unit-test `fileBackedMemento`: `update` then re-instantiate from the same path → `get` returns the written value; corrupt file → empty, no throw.
- Standalone smoke: `POST /setup/verb/setTheme {claudify}` then `GET /board` HTML contains the `theme-claudify` body class (persisted read path).
