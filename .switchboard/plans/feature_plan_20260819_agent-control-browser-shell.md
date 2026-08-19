# Serve Agent Control in the Browser and Standalone Shell

## Goal
Make the Agent Control view reachable from the browser cockpit and standalone Switchboard at `/agent-control`, with a navigation icon in the shell's left rail.

## Metadata
- **Complexity:** 4
- **Tags:** frontend, backend, api, feature
- **Project:** Browser Switchboard

## Background & Problem Analysis

- The browser/standalone version does not use VS Code commands; it navigates via the LocalApiServer and `shell.html`.
- The `tickets.html` extraction broke in the browser because the `Content-Security-Policy` omitted `connect-src https:`, the `LocalApiServer` route was missing, and `headlessPanelHtml.ts` did not serve the new HTML.

> **Superseded:** "In `src/webview/agent-control.html`, place the CSP meta tag and ensure no extra instance of `connect-src https:` appears above it (the rewrite is first-match)" and "The exact `connect-src https:` spelling so the loopback-origin rewrite in `headlessPanelHtml.ts` matches."
> **Reason:** This imports the `tickets.html` post-mortem into a file that does not have its problem. `tickets.html` carries its own `<meta http-equiv="Content-Security-Policy" …  connect-src https:;>` at line 23, which is why `getTicketsHtml` has to string-replace that exact spelling (`headlessPanelHtml.ts:430`). `kanban.html` has **no** meta CSP tag at all — verified, zero matches for `Content-Security-Policy`, `connect-src`, or `WEBVIEW_CSP_SOURCE`. Its CSP is supplied by the host: as a response header via `getBoardHtml` (`headlessPanelHtml.ts:178`), and as an injected meta tag by `KanbanProvider._getHtml` (`KanbanProvider.ts:12935-12936`). Adding a meta CSP to this page would not fix a bug; it would introduce one, because a `default-src 'none'` meta tag would fight the header the browser host already sets.
> **Replaced with:** No CSP work. The page inherits `getBoardHtml`'s existing header CSP and nonce/transport-shim pipeline unchanged.

> **Superseded:** "Add an icon in `src/webview/shell.html` alongside the existing panel icons that navigates to `/agent-control`."
> **Reason:** The rail is data-driven and explicitly designed not to need this. `shell.html:10-12` states: *"The strip is rendered from the /panels manifest (data-driven), so adding a panel route later adds a strip icon with no shell code change."* `#strip` (`shell.html:353`) ships empty and is populated at runtime from `GET /panels`, which serves `getPanelsManifest()` (`headlessPanelHtml.ts:509-529`). Hand-editing `shell.html` would add a second, competing source of truth for the rail.
> **Replaced with:** Add one entry to `getPanelsManifest()` and ship the icon asset it points at. No `shell.html` edit.

> **Superseded:** "Ensure the `AgentControlPanelProvider` (from the provider subtask) exposes the HTML for the HTTP path and receives `ready`/`persistTabState` from the browser client."
> **Reason:** Two wrong assumptions. The HTTP path does not go through any provider — `_handleServePanelById` resolves HTML from `headlessPanelHtml.ts` directly, which is why `/tickets`, `/design`, `/setup` and the rest are one-line route arms. And `persistTabState` does not exist: sub-tab and role persistence is webview-local via `vscode.getState()`/`setState()`, which `transport.js:26-46` backs with `localStorage` in the browser. No verb, no host round-trip.
> **Replaced with:** A thin `getAgentControlHtml()` in `headlessPanelHtml.ts` and a one-line route arm, matching every other panel.

### Verified facts (read from source during this pass)

- **The route table is uniform.** `LocalApiServer.ts:4611-4624` — `/memo`, `/planning`, `/tickets`, `/design`, `/setup`, `/connections`, `/terminals` are each a single `await this._handleServePanelById('<id>', req, res)` arm. Adding `/agent-control` is one more arm.
- **`getPanelHtmlById` is the dispatcher.** `headlessPanelHtml.ts:530-542` maps panel id → HTML getter; an unknown id returns `null`.
- **The manifest drives the rail.** `getPanelsManifest()` (`:509-529`) returns `{ id, label, icon, route, enabled }`, with optional `placement: 'bottom'` and `presentation: 'modal'` markers. Manifest **order** also determines the default panel (first enabled entry), so the new entry must not be inserted first.
- **Icon assets are real files.** `icons/nav-*.svg` — `nav-board`, `nav-project`, `nav-memo`, `nav-tickets`, `nav-artifacts`, `nav-design`, `nav-setup`, `nav-connections`, `nav-terminals`, `nav-theme`. There is no `nav-agent-control.svg`; one must be added. The rail renders these through a CSS mask with `currentColor` (`shell.html:87, 250-252`), so the asset must be a single-colour codicon-shaped glyph, not a multi-hue mark.
- **`data-panel` must stay `kanban`.** `transport.js:26` derives the verb route prefix from it (`panel === 'kanban' ? '/kanban/verb' : '/' + panel + '/verb'`). Stamping `data-panel="agent-control"` would send every verb to `/agent-control/verb/…`, which does not exist — a 404 on every call and a completely dead panel. Keeping `kanban` also keeps the existing `PANEL_SURFACES` entry (`wsHub.ts:70`, mirrored in `transport.js:112`) valid, so no WS surface change and no touch to the hand-maintained mirror that `src/test/ws-surface-scoping-contract.test.js:105-115` asserts must not drift.
- **`injectBodyAttributes` is safe to apply twice.** `headlessPanelHtml.ts:124-127` prepends attributes and preserves the existing ones (`<body ${attrs}${existing}>`), so wrapping `getBoardHtml`'s output adds `data-view` without disturbing the `data-panel` / `data-initial-workspace-root` / `data-host-capabilities` it already stamped.
- **Standalone shares the same code.** `src/standalone/bootstrap.ts:25-26, 754` imports `getPanelsManifest`/`getPanelHtmlById` from this module, so the standalone host picks the new panel up with no separate change.

## User Review Required

None. Route name, manifest placement, panel id, and the icon convention are decided in this plan.

## Complexity Audit

### Routine
- One route arm, one manifest entry, one `switch` case, one thin HTML getter.
- One new single-colour SVG asset following an established naming and rendering convention.

### Complex / Risky
- The `data-panel="kanban"` decision is invisible but load-bearing: getting it wrong produces a page that renders perfectly and whose every button 404s.
- Manifest ordering affects the default panel, so a careless insert changes what the shell opens on.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Static HTML assembly per request; no shared mutable state.
- **Security:** The route serves the same board HTML the already-public `/board` route serves, under the same header CSP and the same auth treatment as its sibling panel routes. No new data is exposed and no new origin is permitted.
- **Side Effects:** The rail gains an icon in every browser and standalone session. In the browser both `/board` and `/agent-control` stamp `data-panel="kanban"` and therefore share the `sb-state-kanban` localStorage blob — handled by the namespacing rule in the frontend subtask, which is why that rule is not optional.
- **Dependencies & Conflicts:** Requires the `data-view` contract from the frontend subtask. Does not edit `kanban.html`, `KanbanProvider.ts`, `extension.ts`, or `shell.html`.

## Dependencies

None.

## Adversarial Synthesis

Key risks: stamping a new `data-panel` value would silently 404 every verb while the page still looks correct; inserting the manifest entry first would change the shell's default panel; and a multi-hue icon would render as a solid block under the rail's CSS mask. Mitigations: keep `data-panel="kanban"` and add `data-view` alongside it, append the manifest entry rather than prepending, and ship a single-colour glyph matching the existing `nav-*.svg` set.

## Proposed Changes

### `src/services/headlessPanelHtml.ts`

**Context.** `getBoardHtml` (`:168-226`) already does everything this page needs — file resolution with `dist/` then `src/` fallback, nonce, `<script>` rewriting, transport-shim injection with `expectMarker`, `data-panel="kanban"`, host capabilities, the 30-entry `{{ICON_*}}` map, fonts, and theme class.

**Logic.**
1. Add a thin getter that delegates and adds the one marker:
   ```ts
   export function getAgentControlHtml(repoRoot: string, workspaceRoot: string, capabilities?: HostCapabilities, themeClass?: string): PanelHtmlResult {
       const result = getBoardHtml(repoRoot, workspaceRoot, capabilities, themeClass);
       return { ...result, html: injectBodyAttributes(result.html, 'data-view="agent-control"') };
   }
   ```
   Do not copy the icon map or the shim wiring — delegation is the point.
2. Add `case 'agent-control': return getAgentControlHtml(...)` to `getPanelHtmlById` (`:530`).
3. **Append** an entry to `getPanelsManifest()` — after `board`/`project` so the default panel is unchanged: `{ id: 'agent-control', label: 'Agents', icon: \`${iconDir}/nav-agent-control.svg\`, route: '/agent-control', enabled: true }`. No `placement` or `presentation` marker: it is a normal full-area panel.

**Edge Cases.** `getBoardHtml` returns its not-found stub when neither `dist/webview/kanban.html` nor `src/webview/kanban.html` exists; the wrapper forwards that unchanged and `injectBodyAttributes` logs and no-ops on HTML with no `<body>`.

### `src/services/LocalApiServer.ts`

**Context.** The panel route arms at `:4611-4624`.

**Logic.** Add, beside the others:
```ts
} else if ((pathname === '/agent-control' || pathname === '/agent-control.html') && req.method === 'GET') {
    await this._handleServePanelById('agent-control', req, res);
}
```

**Edge Cases.** The id must match the `getPanelHtmlById` case and the manifest `id` exactly; a mismatch returns `null` and the shell renders an icon that opens a blank frame.

### `icons/nav-agent-control.svg`

**Context.** The rail masks the asset with `currentColor`, so colour in the file is discarded.

**Logic.** Add a single-colour, codicon-shaped glyph sized to match the existing `nav-*.svg` set.

**Edge Cases.** A multi-hue or photographic asset renders as a filled block under the mask.

## Verification Plan

### Automated Tests
- `npm run compile`.
- `node --test src/test/ws-surface-scoping-contract.test.js` — proves the `PANEL_SURFACES` server/client mirror was not disturbed.
- `node --test src/test/browser-panel-verb-routing.test.js`.
- `node --test src/test/browser-kanban-pane-order.test.js` and `src/test/headless-feature-management-contract.test.js`.

### Manual
- `GET /panels` lists the `agent-control` entry; the rail shows its icon and it is not the default selection.
- Visit `http://127.0.0.1:<port>/agent-control` — only AGENTS, TEAMS, PROMPTS are visible.
- DevTools console is free of CSP violations; the Network tab shows tab verbs posting to **`/kanban/verb/…`** (the load-bearing check — anything hitting `/agent-control/verb/…` means `data-panel` was changed and the panel is broken).
- Trigger `getAgentGroups` from the Teams tab and confirm the gallery populates.
- Confirm `/board` still renders the full board with all eight tabs.
- Repeat once in the standalone host to confirm the shared manifest path.

## Recommendation

**Send to Coder** (complexity 4).

## Completion Report

Implemented the browser and standalone shell support for Agent Control view. Created the single-colour codicon `nav-agent-control.svg` icon asset, added `getAgentControlHtml` delegation with `data-view="agent-control"` body attribute injection in `headlessPanelHtml.ts`, registered `agent-control` in `getPanelsManifest` and `getPanelHtmlById`, and exposed GET `/agent-control` and `/agent-control.html` route arms in `LocalApiServer.ts`. Files changed: `icons/nav-agent-control.svg`, `src/services/headlessPanelHtml.ts`, and `src/services/LocalApiServer.ts`. No issues encountered.

## Review Findings

Reviewed `src/services/headlessPanelHtml.ts`, `src/services/LocalApiServer.ts`, `icons/nav-agent-control.svg` in commit `744a895f`. This subtask is clean and needs no changes: `getAgentControlHtml` delegates to `getBoardHtml` and layers only the marker; `injectBodyAttributes` anchors past `</head>` and preserves the existing attributes, so the tag renders as `<body data-view="agent-control" data-panel="kanban" …>` and `transport.js` still derives the `/kanban/verb` prefix and the `sb-state-kanban` key — no `PANEL_SURFACES` drift; the manifest `id`, the `getPanelHtmlById` case, and the route arm all spell `agent-control` identically, and both hosts reach it through the single `sharedGetPanelHtmlById` dispatcher (`TaskViewerProvider.ts:3448`, `standalone/bootstrap.ts:760`) with no per-host allow-list; `/static/icons` resolves to `repoRoot/icons` in both hosts so the new single-colour glyph loads under the rail's CSS mask. One CRITICAL is inherited from the shared commit, not from this subtask: `browser-panel-verb-routing.test.js` — named in this plan's Automated section and invoked by CI at `.github/workflows/integration-tests.yml:159` — is red at HEAD because the commit swept in a `phoneAFriendSelected` posting without its generated catalog half. Deferred NITs: the manifest entry is appended dead-last (after `terminals`) rather than after `board`/`project`, and its `enabled: true` is hardcoded while most siblings are availability-gated.

**Review closed — PASS.** All findings resolved across four fix rounds (`513fd654`, `c29377ed`, `cbed74d8`, `6ef4dc10`). `npm run compile` clean; `panel-revival-retention-contract`, `teams-tab-no-start`, `autoban-state` and the kanban.html half of `browser-panel-verb-routing` all green. Two failures remain in the suite and are confirmed pre-existing, not from this work — `connections.js` (`copyTextToClipboard`) and `transport.js` (double-filter) have zero commits in `ba8f5910..HEAD`. Residual risk: `744a895f` bundled four unrelated in-flight features into the same files, so it will not bisect cleanly; and `npm run test:contract:kanban`, named in two of these plans' Automated sections, does not exist in `package.json`.
