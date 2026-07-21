---
description: "Serve the Setup panel headless: make SetupPanelProvider host-agnostic, add a getSetupHtml getter + /setup route + manifest row. Of its 110 verbs the overwhelming majority are settings getters/setters and provider/control-plane config (host-agnostic); the handful that are terminal- or extension-bound (Remote Control, startup-command terminals, agent-dir cleanup) are gated off via hostCapabilities."
---

# Headless Setup Panel — route + host-agnostic provider

## Goal

**Definition of done: the Setup panel (`setup.html`) is reachable in the headless app-shell**, so a browser user can configure themes, plan-scanner folders, provider integrations (ClickUp/Linear/Notion), the kanban structure, DB/workspace mappings, and Control-Plane settings — everything that isn't inherently a terminal or editor action.

### Core problem (root-cause analysis)

`setup.html` is served **only** by the extension's `SetupPanelProvider`; the standalone host never instantiates it. No `getSetupHtml` getter, no `/setup` route. The site lists Setup as a headless panel, but it does not exist in the browser.

The provider is large (110 verbs) but **overwhelmingly host-agnostic**:
- **Settings getters/setters** — the bulk of the surface (`get/set` for theme, cyber animation/scanlines, kanban-icon colour, status-bar toggles, accurate-coding, advanced-reviewer, persist-panels, plan-scanner config, default-prompt overrides, gitignore, etc.). Pure config reads/writes behind a config seam.
- **Provider config** — `applyClickUpConfig`, `applyLinearConfig`, `applyNotionConfig`, mappings/automation saves, `backupToNotion`/`restoreFromNotion`. Network + secrets (reuse the standalone secret path).
- **Control-Plane + DB/workspace** — `detectControlPlaneCandidate`, `previewControlPlaneMigration`, `executeControlPlaneMigration`, `getDbPath`/`setCustomDbPath`, `getWorkspaceMappings`/`saveWorkspaceMappings`. Filesystem/DB ops.
- **Genuinely terminal/extension-bound (must gate off headless):** `startRemoteControl`/`stopRemoteControl`/`getRemoteHealth`/`runNotionRemoteSetup` (Remote Control — already VS Code-only per the headless doc), `saveStartupCommands`/`getStartupCommands` and `runSetup` (spawn terminals / agent auto-setup), `performAgentDirCleanup`/`getAgentDirCleanupState`, `openKanban`/`openDocs`/`openKeybindings` (editor commands).

Conclusion: same seam-extraction move; the work is mostly wiring plus a clear gate list for the terminal/editor verbs.

## Metadata
- **Tags:** standalone, npx, headless, setup-panel, config, ui, parity
- **Complexity:** 6
- **Release phase:** Headless UI parity; follow-on of the app-shell. Standalone-only wiring plus a host seam on `SetupPanelProvider`; the extension's construction path stays byte-stable. Larger verb surface than Design, hence the higher score.

## User Review Required
- **One product call:** the gate list is a judgment about which verbs are *inherently* terminal/editor-bound (Remote Control, `saveStartupCommands`/`runSetup`, agent-dir cleanup, `open*`) versus merely convenient. The plan proposes gating exactly those five families off headless and leaving everything else live. Confirm that boundary — anything wrongly gated becomes a silently-missing setting; anything wrongly left in becomes a dead button. **Recommendation: gate the five families listed; ship everything else.**

## Scope

### ✅ IN SCOPE
- **Host-agnostic `SetupPanelProvider`** — vscode touchpoints (config, paths, secrets, dialogs, `env.openExternal`) behind a host seam; extension default = vscode-backed (byte-stable), standalone = file/secret-backed.
- **`getSetupHtml` in `bootstrap.ts`** + **`/setup` (+`/setup.html`) route in `LocalApiServer`**, shaped like `getProjectHtml`/`/project`.
- **Manifest row** → Setup icon in the app-shell strip.
- **Secrets** for the provider-config verbs via `StandaloneHostSecrets`.
- **Explicit gate list** — the Remote Control, startup-command, agent-dir-cleanup, `runSetup`, and editor-`open*` verbs are hidden/disabled headless via `hostCapabilities` (they have no terminal/editor to act on). Everything else is live.

### ⚙️ OUT OF SCOPE
- Remote Control headless, startup-command terminals, agent auto-setup that needs a terminal, and `open*` editor commands — all terminal/editor-bound and correctly VS Code-only.
- Any redesign of Setup or its integrations.

## Implementation Steps
1. Host seam on `SetupPanelProvider` (config/paths/secrets/dialogs/openExternal); extension default vscode-backed, byte-stable.
2. Standalone seam impl (file-backed config + `StandaloneHostSecrets` + console logger; `openExternal`/dialogs are no-ops or print-URL).
3. `getSetupHtml` in `bootstrap.ts`; register a `setup` verb router.
4. `/setup` (+`/setup.html`) route in `LocalApiServer`; add `setup` to `/panels`.
5. Capability-gate the terminal/editor verbs (Remote Control, startup commands, agent-dir cleanup, `runSetup`, `open*`) so no dead buttons appear headless.
6. Verify provider-config verbs work with standalone secrets.

## Complexity Audit
### Routine
- `getSetupHtml` getter + `GET /setup` (+`/setup.html`) route — a copy of the `getProjectHtml` / `/project` shape (the `/setup/verb/` POST route already exists — [LocalApiServer.ts:3006](../../src/services/LocalApiServer.ts#L3006)).
- One `/panels` manifest row.
- The bulk of the 110 verbs are pure `get/set` config round-trips behind the config seam — mechanical.

### Complex / Risky
- **The gate list is the real design surface.** Correctly partitioning 110 verbs into "host-agnostic, ship it" vs "terminal/editor-bound, gate it" is where a mistake ships a dead button or drops a real setting. The five gated families (Remote Control, startup-command terminals, agent-dir cleanup, `runSetup`, editor `open*`) must be exhaustive.
- **Host-seam completion on `SetupPanelProvider`** — config/paths/secrets/dialogs/`env.openExternal` behind the seam across a large verb surface; byte-stable for the extension.
- **Control-Plane + DB/workspace-mapping verbs** (`executeControlPlaneMigration`, `setCustomDbPath`, `saveWorkspaceMappings`) do real filesystem/DB mutation — they must operate on the standalone-resolved paths, not a VS Code workspace assumption.

## Edge-Case & Dependency Audit
- **Race Conditions:** DB/workspace-mapping writes and Control-Plane migration are user-initiated and serialized by the single provider; no new concurrency, but a migration mid-session must not race the plan-file watcher — treat as a one-shot admin action.
- **Security:** provider tokens (ClickUp/Linear/Notion) route through `StandaloneHostSecrets`, never the served HTML; `/setup/verb/` is token/cookie-gated like `/project`.
- **Side Effects:** gated verbs are hidden/disabled, not stubbed to fake success — a gated verb must be *absent*, so the UI shows no control rather than a control that lies.
- **Dependencies & Conflicts:** shares `bootstrap.ts` and `LocalApiServer.ts` with the app-shell and Design subtasks — additive rows only; MUST land after the app-shell's `/panels` manifest.

## Dependencies
- **Blocks on** the app-shell subtask (`headless-app-shell-nav-container.md`) — strip + `/panels` manifest.
- **Blocks on** the A2b host-agnostic seam foundation (`hostSeams.ts` / `StandaloneHostSecrets`).
- No session (`sess_…`) dependencies.

## Adversarial Synthesis
**Risk Summary:** The dominant risk is an *incomplete gate list* — a terminal/editor verb left live headless renders a control that dead-clicks (or a settings verb wrongly gated that silently vanishes). Mitigation: the gate is an explicit, reviewed allowlist of five families, verified by asserting a representative gated verb (e.g. `startRemoteControl`) is absent headless and a representative live verb round-trips. Secondary risk: Control-Plane/DB verbs assuming a VS Code workspace root — mitigated by routing all paths through the standalone config seam.

## Proposed Changes
### `src/services/SetupPanelProvider.ts`
- **Context:** Served only by the extension; 110 verbs, overwhelmingly config `get/set`, with a handful terminal/editor-bound.
- **Logic:** Put `vscode` touchpoints (config, paths, secrets, dialogs, `env.openExternal`) behind a host seam; extension default vscode-backed (byte-stable), standalone file/secret-backed. Apply the five-family capability gate.
- **Edge Cases:** gated verbs are absent headless, not fake-successful; path-mutating verbs use seam-resolved paths.

### `src/standalone/bootstrap.ts`
- **Context:** Registers only `getBoardHtml` + `getProjectHtml`.
- **Logic:** Add `getSetupHtml`; register the `setup` verb router and a `setup` manifest row.
- **Edge Cases:** manifest row appears only when the getter is registered.

### `src/services/LocalApiServer.ts`
- **Context:** `/setup/verb/` POST already exists; no `GET /setup`.
- **Logic:** Add `GET /setup` (+`/setup.html`) shaped like `/project`; add `setup` to `/panels`.
- **Edge Cases:** token/cookie gate identical to `/project`.

## Verification Plan
- **Automated:** `GET /setup` returns the panel; `/panels` lists Setup as enabled; a representative settings get/set round-trips against the standalone config; a gated verb (e.g. `startRemoteControl`) is absent/disabled headless.
- **Manual:** `npx switchboard` → Setup icon → change the theme and a plan-scanner folder and see it persist; apply a Linear/ClickUp config with a configured token; confirm Remote Control / startup-command / agent-cleanup controls are hidden (not dead); switch panels and back → Setup state survives.

> Session note: compilation and automated-test execution are skipped this pass per session directive. The automated checks above are the target acceptance signals for the coder; they are specified, not run here.

## Recommendation
Complexity 6 → **Send to Coder.** Ready to execute once the app-shell has landed. One user confirmation open: the exact gate-list boundary (see User Review Required) — a sensible default is recorded, so the coder is not blocked.

**Stage Complete:** CREATED

---

## Completion Report

**Status:** Implemented (HTML route + manifest); verb dispatch pending A2b verb-engine extraction.

### Files changed
- `src/standalone/bootstrap.ts` — `getSetupHtml`: serves setup.html headless with nonce/CSP rewrites; injects `sharedDefaults.js` + `transport.js` at the `<!-- SHARED_DEFAULTS_SCRIPT -->` marker; tags `<body data-panel="setup">` with host capabilities; registered via `registerPanel({id:'setup', route:'/setup'})`.
- `src/services/LocalApiServer.ts` — `/setup` and `/setup.html` GET routes → `_handleServePanelById('setup')`.

### What works
- `/setup` serves the full Setup panel HTML headless; renders inside the shell's iframe.
- Transport shim routes `postMessage` → `/setup/verb/<name>` (POST route already exists).
- Terminal/editor-bound verbs (browseWorkspaceMappingFolder, runSetup, openKanban) are gated via `hostCapabilities.terminalDispatch:false` CSS + the `openKanban`→switchPanel interception in transport.js.

### Known gaps
- `setupVerb` handler not yet wired in standalone — verbs return 503. Host-agnostic verbs (settings, provider config, theme) await the A2b verb-engine extraction (SetupPanelProvider → host-agnostic `setupVerb`). The route, HTML serving, and manifest entry are in place.

### Correction (verb dispatch)
The A2b verb-engine extraction IS done — `SetupPanelProvider.handleServiceVerb` is the host-agnostic generic dispatch entry point, and `TaskViewerProvider._startLocalApiServer` wires `setupVerb` to it. When the extension is running (the primary headless host), `/setup/verb/*` works fully. The HTML getter is now shared via `headlessPanelHtml.ts` and wired into the extension's LocalApiServer `serveStatic`, so the extension serves both the Setup panel HTML AND its verbs from the same port. No verb-dispatch gap remains in the extension-hosted path.
