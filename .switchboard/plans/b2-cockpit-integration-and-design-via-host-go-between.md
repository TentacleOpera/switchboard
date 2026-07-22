---
description: "Correct the browser cockpit's over-gating. Integration features (tickets, online docs) and the Design panel (incl. Stitch) must be AVAILABLE in the browser via the host-as-go-between: the server (editor, or a configured standalone) holds the secret and makes the outbound API call; the browser only triggers and displays, so the key is never exposed. Only secret ENTRY (typing a raw API key) stays editor-only. Restores the Design panel that was wrongly dropped."
---

# B2 · Browser Cockpit — Integrations & Design via the Host Go-Between

## Metadata
- **Project:** browser-switchboard
- **Tags:** ui, architecture, security, feature
- **Complexity:** 7
- **Release phase:** B2 (browser cockpit). Corrects the surface-scoping of `b2-cockpit-secrets-editor-only` and `b2-cockpit-complete-panel-set-artifacts-implementation`.
- **Dependencies:** Supersedes specific decisions in **Secrets Editor-Only** (which hid whole secret-dependent surfaces) and **Surface Scope** (which dropped the Design panel and hid the docs online-sources + Tickets tab). Consumes the same per-host capability mechanism (`HOST_CAPABILITIES`, `transport.js:applyCapabilityGating`).
- **Recommendation:** Send to Lead Coder (complexity 7 — multi-file coordination, new capability field, security-sensitive verb classification).

## Goal

Make integration data and the Design panel usable in the browser cockpit through the **host go-between**, without ever exposing a secret to the browser. The server that serves the cockpit — the running extension, or a standalone process with a configured key — performs each outbound API call with *its* stored secret and returns only the resulting data; the browser triggers the verb and renders the result.

### Problem / root-cause analysis

The earlier surface-scoping conflated two different things and over-hid:

1. **"Needs a secret" was treated as "browser-absent."** But — exactly like the `terminalDispatch` capability correction — **secret USE is a host capability, not a browser blanket.** The verb path already runs server-side: `LocalApiServer` verb → provider → `secrets.get(...)` → outbound API call → data returned in-body. The key never reaches the browser. So *displaying* tickets, *listing* online docs, *reading* Stitch projects all work through the go-between when the host has the key. The only thing that genuinely must stay editor-only is **secret ENTRY** — typing a raw API token into a browser tab (a broader attack surface for the credential, and the reason the keychain is its sole home).

2. **The Design panel was dropped as "redundant" — it isn't.** Verified: Stitch screens are stored **locally** in `.switchboard/stitch/` (PNGs + cached HTML, `DesignPanelProvider.ts:1088,1378,1609`), so they render in the browser with no key; the Stitch API key is `switchboard.stitch.apiKey` (`_setupStitchAuth`, `:1770`), used only when *generating* — a textbook go-between. Design also carries local design docs, HTML previews, and copy-prompt "publish to claude" (no terminal). Dropping it removed real browser-viable functionality.

> **Superseded:** "Design → omit for the browser host (redundant)" and "strip the secret-dependent docs + Tickets tabs from Artifacts" (Surface Scope); "hide all secret-dependent surfaces in the browser" (Secrets Editor-Only).
> **Reason:** those hid *secret USE* (display/read via the go-between), not just *secret ENTRY*. The key is never exposed by USE, so hiding the surfaces removed working functionality for no security gain.
> **Replaced with:** the entry-vs-use split below — entry is editor-only; use is a host capability, shown when the provider is configured.

## The model (entry vs use)

| Class | Examples | Rule |
|---|---|---|
| **Secret ENTRY** (store a raw key) | `stitchSaveApiKey`, `stitchSaveAuthConfig`, `applyClickUpConfig`, `applyLinearConfig`, `applyNotionConfig`, `set*Token`, `multi-repo-pat` | **Editor-only.** Hide the input fields in the browser; server denies these secret-STORE verbs over the HTTP rail (403). |
| **Secret USE — read/display** | fetch tickets, list online docs, `stitchListProjects`, `stitchListDesignSystems`, view local Stitch screens, sync *status* | **Go-between.** Allowed over HTTP; shown when the host reports the provider configured. Key never exposed. |
| **Secret USE — write** | create/modify ticket, push/sync doc online, `stitchCreateDesignSystem`, generate screens, `stitchApplyDesignSystem` | **Allowed via go-between** (decided). Key stays server-side; consistent with the accepted indirect-sync behaviour. |
| **Local content** | design docs, HTML previews, existing Stitch screens, local docs | **Always available** — no key, no terminal. |

## User Review Required — RESOLVED
- **Data-write policy → ALLOW.** Secret-USE writes (create ticket, push doc, generate Stitch screen) are permitted from the browser via the go-between — the key is never exposed, and browser-created content already syncs outward via the editor's auto-sync, so blocking direct writes while allowing indirect ones would be inconsistent. **Secret-STORE (entering/saving a raw key) stays editor-only regardless.** So the only server-side HTTP deny is the STORE-verb set; all read and data-write verbs are allowed.

## Complexity Audit
### Routine
- Un-hiding surfaces already built (Design manifest entry, docs online sources, Tickets tab).
- Serving local Stitch screen assets over the existing `/static` route.
- Removing docs source-filter option-stripping in `transport.js:305-312`.
### Complex / Risky
- Splitting the gating cleanly into ENTRY (deny/hide) vs USE-read (allow) vs USE-write (policy) — the server-side verb allow/deny list must classify each verb correctly, and must not regress the editor path.
- **Critical gap: `_handleDesignVerb` (`LocalApiServer.ts:1514`) has NO deny list** — `stitchSaveApiKey` and `stitchSaveAuthConfig` are currently wide open over HTTP. Must add a deny list to the Design verb handler.
- **Critical gap: `enableTriagePipeline` (`SetupPanelProvider.ts:605`) calls `secrets.store` (`TaskViewerProvider.ts:6227,6267`) but is NOT in the `SECRET_WRITE_VERBS` deny set** (`LocalApiServer.ts:1546`). Must be added.
- Per-provider "configured" capability reporting (server inspects stored secrets) without leaking whether a key exists to an unauthenticated caller (it's behind the same auth as other verbs).
- **Standalone bootstrap (`bootstrap.ts:396-399`) passes NO capabilities to `getPanelHtml`** — all caps default to false. Must wire `integrationsConfigured` + `secretsEntry: false` in the standalone host.
- Design panel's own terminal controls (build-via-planner) still gate on `terminalDispatch` per host.

## Dependencies
- Reworks `transport.js:applyCapabilityGating` (line 225), `headlessPanelHtml.ts` (`HostCapabilities` interface line 16, `getPanelsManifest` line 298), and the `LocalApiServer` verb deny lists (Setup at line 1546, Design at line 1514 — currently missing). Same shared surfaces as Secrets + Surface Scope — serialize edits with those.
- `verbSchemas.ts` is shared across all provider work — append per-provider blocks and serialise concurrent edits (PRD orchestration discipline).
- `switchboard-site` docs repo for the headless-switchboard.md update.

## Edge-Case & Dependency Audit

### Race Conditions
- `integrationsConfigured` is emitted as a static `data-host-capabilities` attribute at page-render time. If a user configures a provider in the editor while the browser tab is open, the browser won't see the updated capability until refresh. Acceptable for first pass — the alternative (polling or WS push for capability changes) is out of scope.

### Security
- The deny list is the sole HTTP boundary. A mis-classified STORE verb leaks the ability to store a secret from the browser. The `secrets.store` call-site audit (below) is the completeness check.
- `integrationsConfigured` booleans are behind the same `_checkAuth` gate as all other verbs — no unauthenticated leak of key presence.
- `setRemoteConfig` (`SetupPanelProvider.ts:1352`) persists a `RemoteConfig` (`RemoteControlService.ts:42`) that contains NO token fields (only provider/boards/sync settings). It is correctly classified as a USE verb, not a STORE verb — removing it from the deny list is safe.

### Side Effects
- Un-hiding the Setup integration tabs (clickup/linear/notion) in the browser means the browser user sees configuration UI (mappings, automation rules) that was previously hidden. These are USE verbs (read/modify config), not ENTRY verbs — correct to show.
- `runNotionRemoteSetup` and `startRemoteControl` are currently in the deny list but are USE verbs (they use the stored key, don't store one). Removing them from the deny list is correct under the entry-vs-use model.

### Dependencies & Conflicts
- `setApiToken`/`setClickUpToken`/`setLinearToken`/`setNotionToken` are in the current deny list (`LocalApiServer.ts:1553-1556`) but no verb cases exist for them anywhere in the codebase. They appear to be defensive/legacy entries. Keep them in the deny list as defensive coverage.
- The `transport.js` changes and the `headlessPanelHtml.ts` changes are in different files but both affect the same browser-render pipeline — coordinate to avoid gating conflicts (CSS hiding vs. manifest omission).

## Adversarial Synthesis
**Risk Summary:** Key risks: (1) the Design verb handler (`_handleDesignVerb:1514`) currently has NO deny list — `stitchSaveApiKey`/`stitchSaveAuthConfig` are wide open over HTTP, a critical security gap that must be closed; (2) `enableTriagePipeline` calls `secrets.store` but is missing from the Setup deny set — another critical gap; (3) the standalone bootstrap passes no capabilities to panel HTML, so `integrationsConfigured` won't work in `npx switchboard` without wiring; (4) showing an integration surface for an *unconfigured* provider yields dead controls — gate on `integrationsConfigured`, show a "set up in the editor" hint otherwise. Mitigations: add deny lists to `_handleDesignVerb` and `_handleKanbanVerb`; add `enableTriagePipeline` to the Setup deny set; wire capabilities in standalone bootstrap; classify verbs by `secrets.store` call sites (STORE→deny) vs `secrets.get` (USE→allow).

## Proposed Changes

### 1. `HostCapabilities` interface + capability reporting (`headlessPanelHtml.ts`)
- **File:** `src/services/headlessPanelHtml.ts:16-23`
- Add `integrationsConfigured?: { clickup: boolean; linear: boolean; notion: boolean; stitch: boolean }` to the `HostCapabilities` interface.
- Keep `secretsEntry` meaning **key-entry only** (no semantic change — the field already exists).
- **Extension host** (`TaskViewerProvider.ts:1804-1811`): compute `integrationsConfigured` server-side by checking each secret's presence (`this._context.secrets.get('switchboard.clickup.apiToken')`, etc. — same pattern as `getIntegrationSetupStates` at `TaskViewerProvider.ts:5847-5851`). Add it to the `hostCapabilities` object at line 1804.
- **Standalone host** (`bootstrap.ts:384-399`): compute `integrationsConfigured` from `StandaloneHostSecrets` (check each key). Pass a `hostCapabilities` object (with `secretsEntry: false` + `integrationsConfigured`) to `getBoardHtml`/`getProjectHtml`/`getPanelHtml` — currently none is passed, so all caps default to false.
- The capability JSON is emitted into `data-host-capabilities` on `<body>` by each `get*Html` function (e.g. `headlessPanelHtml.ts:116`). No change needed to the emission mechanism — just populate the object.

### 2. Gating (`transport.js:applyCapabilityGating`)
- **File:** `src/webview/transport.js:225-317`
- **Under `secretsEntry===false` (lines 258-313):** narrow the CSS block to hide **only** key-entry inputs + apply/store buttons. Remove the whole-tab hiding for `.shared-tab-btn[data-tab="clickup"]`, `[data-tab="linear"]`, `[data-tab="notion"]`, `[data-tab-content="clickup"]`, etc. (lines 269-284). Keep hiding `#clickup-token-input`, `#linear-token-input`, `#notion-token-input`, `#multi-repo-pat`, `#btn-apply-clickup-config`, `#btn-apply-linear-config`, `#btn-apply-notion-config` (lines 285-291) — these are ENTRY controls.
- **Remove the docs source-filter option stripping** (lines 305-312) — online sources (ClickUp/Notion) should be visible, gated on `integrationsConfigured`.
- **Remove the Tickets tab hiding** (line 297: `.shared-tab-btn[data-tab="tickets"]`) — restore it, gated on `integrationsConfigured`.
- **Remove `#btn-push-doc` / `#btn-sync-to-online` hiding** (lines 295-296) — these are USE-write verbs, allowed via go-between.
- **Keep hiding** `[data-tab="remote"]`, `[data-tab="database"]`, `[data-tab="control-plane"]`, `[data-tab="mappings"]`, `[data-tab="status-bar"]` (lines 272-276, 280-284) — these are host-authority/editor-substrate tabs that repoint the DB/config, not integration surfaces. They stay editor-only regardless of the entry-vs-use split.
- **Add per-provider gating:** read `caps.integrationsConfigured` (new field). For each provider not configured, inject a CSS overlay or hint ("Configure ClickUp in the editor") over the provider's action area. Configured → full surface, no hint.
- **Stitch key-entry hiding:** add CSS to hide Stitch save-key controls (`.stitch-api-key-input`, `#stitch-save-key-btn` — verify exact selectors in `design.html`) under `secretsEntry===false`.

### 3. Server verb classification (`LocalApiServer.ts`)
- **File:** `src/services/LocalApiServer.ts`
- **`_handleSetupVerb` (line 1541):** the existing `SECRET_WRITE_VERBS` set (line 1546) must be:
  - **Add:** `enableTriagePipeline` (calls `secrets.store` at `TaskViewerProvider.ts:6227,6267` via `SetupPanelProvider.ts:605`).
  - **Remove:** `setRemoteConfig`, `runNotionRemoteSetup`, `startRemoteControl` — these are USE verbs (they use stored secrets, don't store them). `RemoteConfig` (`RemoteControlService.ts:42`) has no token fields. Allowing them over HTTP is correct under the entry-vs-use model.
  - **Keep:** `applyClickUpConfig`, `applyLinearConfig`, `applyNotionConfig`, `setApiToken`, `setClickUpToken`, `setLinearToken`, `setNotionToken` (defensive — no verb cases exist but keep as coverage).
- **`_handleDesignVerb` (line 1514):** add a `SECRET_WRITE_VERBS` deny list (currently has NONE):
  - `stitchSaveApiKey` (calls `secrets.store` at `DesignPanelProvider.ts:2594`)
  - `stitchSaveAuthConfig` (calls `secrets.store` at `DesignPanelProvider.ts:2613`)
  - Return 403 with the same error shape as the Setup handler.
- **`_handlePlanningVerb` (line 1487):** no deny list needed — no planning verbs call `secrets.store`. All planning verbs are USE verbs (read/write docs, push/sync). Confirmed by grep: no `secrets.store` calls in `PlanningPanelProvider`.
- **`_handleKanbanVerb` (line 1449):** no deny list needed — no kanban verbs call `secrets.store`. Confirmed by grep.
- **`_handleTaskViewerVerb` (line 1587):** no deny list needed — no TaskViewer verbs call `secrets.store` directly (the `handleApply*Config` methods are called from Setup verbs, not TaskViewer verbs).
- **Complete `secrets.store` call-site audit** (the STORE set is the entire HTTP boundary):
  | Call site | Verb | Handler | In deny list? |
  |---|---|---|---|
  | `DesignPanelProvider.ts:2594` | `stitchSaveApiKey` | Design | **NO — must add** |
  | `DesignPanelProvider.ts:2613` | `stitchSaveAuthConfig` | Design | **NO — must add** |
  | `TaskViewerProvider.ts:6020` | `applyClickUpConfig` | Setup | Yes |
  | `TaskViewerProvider.ts:6188` | `applyLinearConfig` | Setup | Yes |
  | `TaskViewerProvider.ts:6227` | `enableTriagePipeline` (clickup) | Setup | **NO — must add** |
  | `TaskViewerProvider.ts:6267` | `enableTriagePipeline` (linear) | Setup | **NO — must add** |
  | `TaskViewerProvider.ts:6878` | `applyNotionConfig` | Setup | Yes |
  | `TaskViewerProvider.ts:6886` | `applyNotionConfig` (restore) | Setup | Yes (same verb) |
  | `extension.ts:1630,1760,1788` | Command handlers (not verbs) | N/A | N/A — not exposed over HTTP |
  | `standalone/cli.ts:109` | CLI `secrets set` (not a verb) | N/A | N/A — not exposed over HTTP |

### 4. Restore the Design panel to the browser (`headlessPanelHtml.ts`, `LocalApiServer.ts`, `bootstrap.ts`)
- **`headlessPanelHtml.ts:298-312` (`getPanelsManifest`):** remove the comment at lines 306-309 and add a Design entry:
  ```typescript
  { id: 'design', label: 'Design', icon: `${iconDir}/25-1-100 Sci-Fi Flat icons-42.png`, route: '/design', enabled: designEnabled },
  ```
  Add `design?: boolean` to `PanelAvailability` (line 292) — it's already there. Wire `design: true` in both hosts (extension at `TaskViewerProvider.ts:1823` already passes `{ design: true, ... }`; standalone at `bootstrap.ts:395` already passes `{ design: true, ... }`).
- **`getPanelHtmlById` (line 314):** already has `case 'design'` (line 319) — no change needed.
- **`getDesignHtml` (line 226):** already exists and works — no change needed.
- **Per-control gating in `transport.js`:** local content always visible; Stitch entry controls hidden under `secretsEntry===false`; Stitch reads/generate gated on `integrationsConfigured.stitch`; build-via-planner gated on `terminalDispatch` (already handled by the existing `terminalDispatch` CSS block at lines 231-256).
- **Static route for Stitch assets:**
  - **Extension host** (`TaskViewerProvider.ts:1828-1830`): add `stitch: [path.join(wsRoot, '.switchboard', 'stitch')]` to `staticRoutes`.
  - **Standalone host** (`bootstrap.ts:402-406`): add `stitch: [path.join(workspaceRoot, '.switchboard', 'stitch')]` to `staticRoutes`.
  - This serves `.switchboard/stitch/` PNGs and cached HTML at `/static/stitch/...` so they render in the browser Design panel.

### 5. Docs
- **File:** `switchboard-site` repo, `headless-switchboard.md`
- Update to the go-between model: integrations + Design are available in the browser when the host has the key; only key entry is editor-only. Document the `integrationsConfigured` capability and the "configure in the editor" hint behaviour.

## Verification Plan
### Manual (the real DoD)
- With the editor running and ClickUp/Notion + Stitch configured: the browser shows the **Tickets** tab with real tickets, the docs **online sources**, and the **Design** panel with existing Stitch screens; creating a ticket / pushing a doc / generating a Stitch screen all work via the go-between.
- Key-entry fields are absent in the browser; a secret-STORE verb over HTTP → 403. **Specifically test:** `POST /design/verb/stitchSaveApiKey` → 403 (currently returns 200 — this is the critical regression test).
- **Specifically test:** `POST /setup/verb/enableTriagePipeline` → 403 (currently returns 200 — critical regression test).
- An unconfigured provider shows a "configure in the editor" hint, not a dead control.
- Setup integration tabs (ClickUp/Linear/Notion) are visible in the browser with their mapping/automation UI — only the token-entry fields are hidden.
- `setRemoteConfig` / `runNotionRemoteSetup` / `startRemoteControl` over HTTP → 200 (no longer denied — they are USE verbs).
- Standalone (`npx switchboard`): Design panel appears in the nav strip; Stitch screens render; `integrationsConfigured` reflects the standalone secret store.
- Editor path unchanged: all verbs work in-process; no regression in the VS Code webview.
### Automated — skipped per user directive
- Verb-classification unit test and manifest test are defined but not run as part of this plan's verification (user directive: skip tests). The implementer should add them as follow-up:
  - Verb-classification test: every `secrets.store` call site's verb is in the STORE-deny set (the sole HTTP boundary); read and data-write verbs are allowed.
  - Manifest test: `design` present for the browser host; capability payload carries `integrationsConfigured`.
### Compilation — skipped per user directive
- No compilation step is run as part of this plan's verification (user directive: skip compilation).

## Completion Report
Implemented entry-vs-use security model for browser cockpit integrations and restored the Design panel. Updated `HostCapabilities` and host bootstrap/TaskViewer callers to include `integrationsConfigured` status for ClickUp, Linear, Notion, and Stitch, and added local Stitch asset static routing. Refined `transport.js` gating to hide secret-entry fields while un-hiding integration tabs/tickets/online docs, added HTTP deny lists for `stitchSaveApiKey`, `stitchSaveAuthConfig`, and `enableTriagePipeline` in `LocalApiServer.ts`, and re-enabled Design panel in `getPanelsManifest`. Files changed: `headlessPanelHtml.ts`, `TaskViewerProvider.ts`, `bootstrap.ts`, `transport.js`, `LocalApiServer.ts`. No issues encountered.

