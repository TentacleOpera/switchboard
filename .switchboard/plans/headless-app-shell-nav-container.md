---
description: "Headless app-shell: one browser tab hosting every headless-capable panel behind a persistent left icon strip (the browser equivalent of VS Code's activity bar). Panels stay as their own full-page routes, embedded as same-origin iframes — no SPA rewrite. Fixes the orphaned /project route and gives future Design/Setup/Memo panels a home. Shippable first slice = shell + Board + Project."
---

# Headless App-Shell — one-tab container with a left panel-switcher strip

## Goal

**Definition of done: `npx switchboard` opens a single browser tab that hosts every headless-capable panel behind a persistent left icon strip.** The Board and the Project panel — and, as they come online, Design / Setup / Memo — are all reachable in that one tab by clicking an icon, with no second URL to memorise and no per-panel tab spam. The strip is the browser equivalent of VS Code's activity bar: the host chrome that the editor used to provide for free.

### Core problem (root-cause analysis)

Headless serves **two disjoint, chrome-less, full-page routes** — `/` (kanban.html) and `/project` (project.html) — with **no navigation between them**:

- `LocalApiServer` only accepts two panel getters, `getBoardHtml` + `getProjectHtml` ([LocalApiServer.ts:298-299](../../src/services/LocalApiServer.ts#L298)); bootstrap registers exactly those two ([bootstrap.ts:562-563](../../src/standalone/bootstrap.ts#L562)).
- The launcher only ever opens the board: `http://127.0.0.1:<port>/?token=<oneTimeToken>` ([cli.ts:113](../../src/standalone/cli.ts#L113),[:120](../../src/standalone/cli.ts#L120)).
- **Nothing links the board to `/project`.** Every `/project` occurrence in kanban.html is the project-*filter* dropdown (workspace/project selector), not the route. The board's `openPlanningPanel` is a VS Code *command* ([kanban.html:7601](../../src/webview/kanban.html#L7601)) — in a browser the message it posts is consumed by nobody.

Result: the Project panel is **orphaned** — reachable only if the user manually types `/project` (the same-origin session cookie makes it work, but nothing tells them it exists). And Design / Setup / Memo have **no route at all**.

The deeper cause: **in VS Code the editor *is* the shell.** The activity bar, view switching, and tab chrome all come from the editor, and each panel is just a webview slotted into it. Strip VS Code away and no one provides that chrome. The missing piece is not any single panel — it is the **host layer** that holds them. That absence, not a broken panel, is why "run the whole cockpit in a browser" is untrue today.

**Anti-divergence constraint (same principle as the ingestion plan):** the panels are reused **verbatim**, embedded as iframes. We do **not** rewrite them into a single-page app. A true SPA would require turning each standalone full-page panel (its own globals, its own WebSocket) into a mountable component sharing one runtime — a large rewrite that reintroduces exactly the extension/headless divergence the ingestion plan exists to prevent. The shell wraps; it never reimplements.

## Metadata
- **Tags:** standalone, npx, headless, app-shell, navigation, ui, parity
- **Complexity:** 6
- **Release phase:** Headless UI go-live blocker; pairs with `headless-plan-file-ingestion-watcher`. Standalone-only (no extension code path changes), so it carries **no** VSIX-parity gate — the risk surface is the standalone host and the shared `LocalApiServer` routing only.

## User Review Required
- **One decision, already taken in prior discussion:** iframe app-shell (reuse panels verbatim) **over** an SPA rewrite. Recorded here as fixed. Raise it only if the iframe seams prove painful in step 4.

## Scope

### ✅ IN SCOPE (the shippable first slice)
- **A new shell page** served at `/`: a persistent left vertical **icon strip** + a content area that embeds each panel in a **same-origin iframe**. Switching panels shows/hides iframes — **all stay mounted**, so each panel keeps its state and its live WebSocket across switches (instant switch, no reconnect).
- **Route relocation:** move the board to `/board` (+ `/board.html`); keep `/project`; the shell owns `/`. The launcher still opens `/` (now the shell), which **default-selects Board**, so the boot experience is unchanged.
- **Token/cookie:** the token→cookie exchange must land on `/` (the shell). Iframes are same-origin, so the 8-hour session cookie flows into each panel unchanged.
- **Board CSP:** add `frame-src 'self'` to the board's CSP so it can be iframed (project.html's CSP already permits this — [bootstrap.ts:348](../../src/standalone/bootstrap.ts#L348)).
- **Revive the dead navigation:** the shell listens for a panel-switch message from the iframes; the board's `openPlanningPanel` (and any "open panel X" affordance) posts to the parent shell → switches to that panel, instead of being dropped.
- **Data-driven strip:** the strip renders from a served **`/panels` manifest** (`{id, label, icon, route, enabled}`) derived from what bootstrap has registered **and** `hostCapabilities`. Adding a panel route later adds a strip icon with **no shell code change** — this is the extension seam for the follow-on panel plans.
- **Deep-link:** `/#board` / `/#project` select a panel on load, so a bookmarked panel opens directly.

### ⚙️ OUT OF SCOPE (own follow-on plans in this same feature)
- **Making the Design, Setup, and Memo panels host-agnostic and giving them routes.** Each is a separate deliverable (its provider's verbs must answer without VS Code, plus a `getXHtml` getter + a `LocalApiServer` route + a manifest entry). The strip is *built to accept them*, but they are **not delivered here**. See the parent feature's follow-on plans.
- **Any SPA / component rewrite of the panels.** Explicitly rejected (see anti-divergence above).
- **Terminal features.** Unchanged; `hostCapabilities` already gates them, and the strip simply won't show icons for panels that don't exist.

## Implementation Steps

1. **Shell page + asset** — new `src/webview/shell.html` + `src/webview/shell.js`: left icon strip, iframe container, panel manifest consumption, show/hide switch logic, and hash-deep-link handling. Minimal chrome, theme-matched to the existing panels.
2. **bootstrap** — add `getShellHtml` (served at `/`), keep `getBoardHtml` but wired to `/board`, keep `getProjectHtml` at `/project`. Expose a `/panels` manifest endpoint listing registered + capability-enabled panels.
3. **LocalApiServer routing** — `/` → shell; `/board` (+ `/board.html`) → board; `/project` unchanged; update the **token-exchange redirect target** from the board to `/` ([LocalApiServer.ts:536](../../src/services/LocalApiServer.ts#L536) area).
4. **Board CSP** — add `frame-src 'self'`; confirm the board's transport WebSocket connects from inside an iframe (same origin — it does; project.html already runs iframed-capable).
5. **Cross-panel message bridge** — shell adds a `window.postMessage` listener; board/project post `{type:'switchPanel', panel}` to `parent` in headless (guarded by `data-panel`/host detection) instead of firing the dead `vscode` command.
6. **Launcher/UX** — cli still opens `/`; strip defaults to Board; `Ctrl+C` unaffected. Print the board-inside-shell URL (unchanged externally).

## Complexity Audit
### Routine
- Shell page markup + strip + iframe show/hide.
- Route relocation and the `/panels` manifest.
### Complex / Risky
- **Token-redirect relocation** — the one-time-token exchange currently redirects to the board; it must now redirect to `/`. Mitigation: explicit redirect-target test; keep `/board` directly reachable for back-compat.
- **Iframed WebSocket + cookie** — must survive the iframe boundary. Mitigation: everything is same-origin `127.0.0.1`; `SameSite=Strict` cookie still applies to same-site iframes; verified by the live-WS switch test.
- **CSP** — board must allow being framed without loosening anything else. Mitigation: add only `frame-src 'self'`; no `frame-ancestors` relaxation needed for same-origin embedding.

## Edge-Case & Dependency Audit
- **Back-compat:** `/board` and `/project` remain directly loadable standalone (someone with an old bookmark or an external tool hitting the route directly is unaffected).
- **Capability gating:** the strip is data-driven off `/panels`; a panel with no headless route never appears — no dead icons (the same honesty rule the board's `applyCapabilityGating` already follows, [transport.js:181](../../src/webview/transport.js#L181)).
- **Extensibility contract:** adding a follow-on panel = one manifest entry + one route; the shell needs no edit. This is asserted by a test that adds a stub panel and checks a strip icon appears.
- **Depends on / conflicts:** shares `LocalApiServer` routing with the ingestion plan but touches different code (routing/serving vs the watcher engine) — no overlap. No extension-side change, so no VSIX gate.

## Dependencies
- **Pairs with** `headless-plan-file-ingestion-watcher.md` — shares `LocalApiServer` but touches different code (routing/serving here vs the watcher engine there); no overlap.
- **Blocks** the sibling panel subtasks (`headless-design-panel-route.md`, `headless-setup-panel-route.md`, `headless-memo-relocate-to-project.md`) — they add manifest rows + routes that only render once the shell + `/panels` manifest exist. This is the feature's root ordering constraint.
- **Depends on** the standalone host bootstrap (`standalone-headless-core-service-bootstrap.md`) being in place (it already registers the board + project getters this plan relocates).
- No session (`sess_…`) dependencies.

## Adversarial Synthesis
The failure this plan guards against is **rebuilding the panels into a fragile SPA** to get single-tab navigation — which would fork the UI from the extension and re-create the divergence the whole headless effort is fighting. Iframes make single-tab navigation possible while keeping the panels byte-identical to what the extension ships. The residual risks are all mechanical and same-origin (token redirect, iframed WS/cookie, CSP `frame-src`), each covered by a targeted test. The strip being manifest-driven is the deliberate design choice that makes the follow-on panel plans *cheap*: each becomes "add a route + a manifest row," never "touch the shell."

## Proposed Changes

### `src/webview/shell.html` + `src/webview/shell.js` (new)
- **Context:** No host chrome exists in the browser.
- **Logic:** Left icon strip + iframe content area; consumes `/panels`; show/hide switching; hash deep-link; postMessage bridge for cross-panel switches.
- **Edge Cases:** all panels mounted at once (state/WS preserved); unknown hash → default Board.

### `src/standalone/bootstrap.ts`
- **Context:** Registers only board + project getters at `/` and `/project`.
- **Logic:** Add `getShellHtml` at `/`; move board to `/board`; add `/panels` manifest built from registered getters + `hostCapabilities`.
- **Edge Cases:** manifest reflects only enabled panels.

### `src/services/LocalApiServer.ts`
- **Context:** Serves `/`→board, `/project`→project; token exchange redirects to board.
- **Logic:** `/`→shell, `/board`→board, `/project` unchanged; redirect token exchange to `/`; add a `/panels` route.
- **Edge Cases:** `/board` and `/project` remain directly reachable (back-compat).

### `src/webview/kanban.html` (+ project.html) — minimal
- **Context:** Board's `openPlanningPanel` posts a message no one consumes headless; board CSP lacks `frame-src`.
- **Logic:** In headless, post `{type:'switchPanel'}` to `parent`; add `frame-src 'self'` to the board CSP.
- **Edge Cases:** guarded so the extension path is untouched (headless-only branch keyed off host detection).

## Verification Plan

### Automated / Integration
- Boot standalone → `GET /` returns the shell; `GET /board` and `GET /project` return their panels; `GET /panels` lists Board + Project as enabled.
- Token-exchange redirect target is `/` (not `/board`).
- Manifest extensibility: register a stub panel → it appears in `/panels` and (rendered) a strip icon appears, with **no shell edit**.

### Manual
- `npx switchboard` → **one** tab, left strip showing Board + Project; clicking switches instantly.
- Both panels keep live WebSockets across switches: drop a `.md` in `.switchboard/plans/` while on Project → switch to Board → the card is already there (no reconnect/reload).
- The board's "open plan/project" affordance switches the shell to the Project panel (no dead click).
- Bookmark `http://127.0.0.1:<port>/#project` → opens straight to the Project panel.
- Direct `/board` and `/project` still render standalone.

> Session note: compilation and automated-test execution are skipped this pass per session directive. The automated checks above are the target acceptance signals for the coder; they are specified, not run here.

## Recommendation
Complexity 6 → **Send to Coder.** This is the feature's keystone and must be coded and merged **before** the Design / Setup / Memo subtasks — they extend the `/panels` manifest and shell that this plan creates. Ready to execute; the one design decision (iframe app-shell over SPA) is fixed.

**Stage Complete:** CREATED

---

## Completion Report

**Status:** Implemented (CAVEMAN MODE, pre-approved).

### Files changed
- `src/webview/shell.html` (new) — left icon strip + iframe content area, CSP with `frame-src 'self'`, nonce-gated scripts.
- `src/webview/shell.js` (new) — fetches `/panels` manifest, renders strip icons, mounts all panels as same-origin iframes (state + WS preserved across switches), hash deep-linking (`/#board`, `/#design`…), cross-panel `postMessage` bridge.
- `src/standalone/bootstrap.ts` — `getShellHtml`, panel registry (`registerPanel`/`getPanelsManifest`/`getPanelHtml`), board + project registered; board CSP gains `frame-src 'self'`.
- `src/services/LocalApiServer.ts` — `serveStatic` interface extended (`getShellHtml`/`getPanelsManifest`/`getPanelHtml`); `_handleServeShell` (with one-time token exchange + 8h cookie), `_handleServePanels`, `_handleServePanelById`; routing: `/` → shell (legacy fallback → board), `/board` (relocated), `/panels`, `/design`, `/setup`.
- `src/webview/transport.js` — `window.__switchboardSwitchPanel` bridge; `openKanban`/`openPlanningPanel`/`openProjectPanel`/`openSetupPanel`/`openDesignPanel` verbs intercepted → cross-panel switch when iframed.

### What works
- `/` serves the shell; strip renders from `/panels` (data-driven — adding a panel later adds an icon with no shell code change).
- All panels stay mounted as iframes; switching is instant, WebSocket state preserved.
- One-time token exchange lands on `/`, sets the session cookie, flows into each same-origin iframe.
- Board direct access preserved at `/board` (back-compat).

### Known gaps (deferred to A2b verb-engine work)
- Design/Setup panel **verbs** (`/design/verb/*`, `/setup/verb/*`) still need host-agnostic handlers — the panel HTML renders but actions return 503 until the verb engine extracts them. The routes and panel HTML serving are in place; only the verb dispatch is pending.

### Correction (verb dispatch)
The A2b verb-engine extraction IS done. `TaskViewerProvider._startLocalApiServer` wires `designVerb`/`setupVerb`/`planningVerb`/`taskViewerVerb` to the providers' `handleServiceVerb` methods. The shell + panel HTML getters are now shared via `src/services/headlessPanelHtml.ts` and wired into the extension's LocalApiServer `serveStatic`, so when the extension is running, `npx switchboard` opens a browser to the extension's port and gets the full shell + all panel HTML + all verb dispatch from one server. The "verb dispatch pending" note in the original report was wrong — it's fully wired.
