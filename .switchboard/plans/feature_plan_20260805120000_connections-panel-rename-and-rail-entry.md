# Connections Panel — Rename Remote Control and Give It a Rail Entry

## Goal

Turn Remote Control from a buried configuration sub-tab into a first-class **Connections** panel with its own icon in the browser cockpit's left rail, and rename it so the name describes what it does rather than where the user is standing.

### Problem & background

**Root cause 1 — it is undiscoverable.** The only two surfaces Remote Control has today are both dead ends for a user who does not already know the feature exists:

* `src/webview/setup.html:678` — a `Remote` tab that is the **ninth and last** entry in the Setup panel's sub-tab strip, after Setup, Database, Control Plane, Multi-Repo, Notion, Plan Scanner, Theme and Status Bar. The configuration itself lives at `:1084-1160+`.
* `src/webview/kanban.html:2717` — a toolbar toggle `#btn-remote-control` whose tooltip reads *"Start or stop remote control"*. An icon that starts a capability the user has never heard of, whose configuration lives nine tabs deep inside a different panel.

The browser cockpit has **no** surface at all: the left rail is built from `getPanelsManifest()` (`src/services/headlessPanelHtml.ts:460-478`), which returns board, project, memo, tickets, Artifacts, design, setup, terminals. Remote is not a panel, so `shell.js` never renders an entry for it.

**Root cause 2 — the name describes the wrong axis, and this is why an icon alone will not fix it.** "Remote" is a claim about *where the user is*. `.agents/workflows/switchboard-remote.md` opens with it explicitly: *"The local machine and VS Code extension are not running."* That framing fits the phone / away-from-desk case and actively excludes the case that motivated this work: **a second AI surface running side by side with the machine on and the user sitting at it** — e.g. driving the board from Gemini Spark in another window to spend a different AI quota pool. The capability already supports that; the name hides it. A user at their desk does not go looking in a tab called Remote.

So the rename is not cosmetic polish to be done last. It determines the panel label, the icon, the panel copy, the toolbar tooltip and whether the workflow doc's framing needs revising — which makes it the first decision in this plan, not the final one.

**Why a panel and not just a better tab position.** The connections surface is about to grow: the sibling plan *External-Agent Skill Launchers* adds per-surface prompt hand-offs to it, and Remote Control's provider config (Notion / Linear) is already a multi-section form. A tenth Setup sub-tab does not hold that, and Setup is the wrong parent — Setup is about configuring Switchboard itself, whereas Connections is about wiring **external surfaces** into the board.

---

## Metadata
**Complexity:** 6
**Tags:** ui, ux, frontend, refactor
**Project:** browser-switchboard

---

## User Review Required

**None.** The naming decision is made: **Connections**. Chosen over "Companion" (names only the side-by-side case) and "Bridge" (names the mechanism, not the user's intent). "Connections" covers both the away-from-desk and the second-surface cases without asserting either, and it scales to the skill-launcher content arriving in the sibling plan.

---

## Complexity Audit
* **Score:** 6 / 10

### Routine
* Adding a manifest row to `getPanelsManifest()` and a `case` to `getPanelHtmlById()` (`headlessPanelHtml.ts:460-490`).
* Adding a route branch to `LocalApiServer`'s chain alongside the existing `/setup`, `/design`, `/memo` entries (`:3560-3575`).
* Authoring `connections.html` by lifting the existing markup — the Remote form already exists and works.
* Label and tooltip copy changes.

### Complex / Risky
* **Moving shipped UI on ~4,000 installs.** The Remote config form is live and configured for existing users. The DOM ids it depends on (`remote-provider`, `remote-workspace`, `remote-boards-list`, `remote-mode-ingest`, `remote-mode-full`, `remote-comments`, `remote-content`, `remote-push`, `remote-silent-sync`) are wired to handlers and to persisted config under the Kanban DB key `remote.config`. Moving the markup without moving every binding produces a form that renders and silently fails to save.
* **Two hosts, one manifest.** `getPanelsManifest()` is called from `TaskViewerProvider.ts:2296` with an availability bundle and again from the standalone bootstrap. A panel wired in one host and not the other is a dead rail icon (PRD contract #6).
* **Verb routing must exist in both hosts before the icon appears.** PRD contract #7 (two-layer completion): a panel whose verb router is not constructed in a host must be marked disabled in that host's manifest, not merely rendered.
* **Icon treatment is prescribed, not free.** `shell.js:46-77` renders `.svg` entries as CSS-mask glyphs (`buildMaskedGlyph`). A new icon must be a single-colour mask-compatible SVG matching the existing `nav-*.svg` family in `./icons/`, served through `staticRoutes.icons` (`bootstrap.ts:545-550`). A picked-off-the-shelf multi-colour glyph renders as a solid block.

---

## Edge-Case & Dependency Audit

### Race Conditions
* None material. This is UI surfacing over an existing service; `RemoteControlService`'s poll loop, cursors and echo guards are untouched.
* One ordering note: the toolbar toggle in `kanban.html` and the new panel both reflect `remoteControlActive`. The existing hydrate path (`kanban.html:11694`, `applyRemoteControlButtonState` at `:8772`) must keep working — the panel is an additional reader of the same state, not a second writer.

### Security
* No new network surface, no new credentials. Provider tokens continue to live in secret storage and are never rendered into panel HTML.
* The panel inherits the standard CSP + nonce treatment applied by the `headlessPanelHtml` getters (`:348-353`); do not hand-roll a looser policy for the new file.

### Side Effects
* Users who know the feature as "Remote" will not find it under that word. Keep the term discoverable: the Connections panel copy should contain the sentence "formerly Remote Control", and the Setup panel should retain a stub row linking to Connections for at least one release rather than silently deleting the tab.
* `.agents/workflows/switchboard-remote.md` keeps its filename and trigger (`/switchboard-remote`) — renaming a workflow trigger is a separate, breaking change and is **out of scope**. Only its framing paragraph is amended to name both use cases.

### Dependencies & Conflicts
* `getPanelsManifest()` / `getPanelHtmlById()` — `src/services/headlessPanelHtml.ts:460-490`.
* Panel route chain — `src/services/LocalApiServer.ts:3560-3575`.
* Rail renderer — `src/webview/shell.js:46-77` (icon build), `:284-299` (manifest → strip).
* Static icon route — `staticRoutes.icons` → `./icons/` (`src/standalone/bootstrap.ts:545-550`; extension equivalent at `TaskViewerProvider.ts:2324`).
* Existing Remote markup — `src/webview/setup.html:678, 1084-1160+`.
* Toolbar toggle — `src/webview/kanban.html:646-652, 2717, 8772-8776, 11694`.
* Config key `remote.config` in the Kanban DB — unchanged; do **not** rename the key. The UI label changes; the persisted schema does not. Renaming it would strand every existing user's provider configuration.

---

## Dependencies
* None. Ships independently of the two sibling plans; both land more comfortably once this panel exists.

---

## Adversarial Synthesis

Key risks: (1) **silent form breakage** — the Remote config is live on shipped installs and its handlers bind by DOM id, so lifting the markup without every listener and the `remote.config` read/write path produces a form that renders and quietly discards input; (2) **half-wired panel** — a manifest row without a verb router in both hosts is a dead rail icon, the exact failure PRD contract #6 forbids; (3) **rename-as-deletion** — users who know the word "Remote" lose the feature entirely if the old surface vanishes with no signpost. Mitigations: move markup and bindings together and verify persistence by round-tripping a real provider config through a reload; add the manifest row only after both hosts construct the router, and mark it disabled where they do not; keep a Setup stub row pointing at Connections and put "formerly Remote Control" in the panel copy.

---

## Proposed Changes

**Build order:** (1) panel getter + route + manifest → (2) move the Remote form → (3) icon → (4) copy and signposts.

### 1. `src/webview/connections.html` (new) + `src/services/headlessPanelHtml.ts`

**Context:** panels are produced by one shared module so neither host forks the UI (PRD architecture). `getSetupHtml` (`:337-360`) is the template to copy: resolve `dist/webview/…` then `src/webview/…` via `findFile`, mint a nonce, apply the standard CSP, inject the transport shim at the `<!-- SHARED_DEFAULTS_SCRIPT -->` marker, substitute the two font URIs, and set `data-panel` + `data-host-capabilities` body attributes.

**Implementation:**
* Add `getConnectionsHtml(repoRoot, workspaceRoot, capabilities?, themeClass?)` following `getSetupHtml` exactly, with `data-panel="connections"`.
* Add to `getPanelsManifest()` (`:467-476`): `{ id: 'connections', label: 'Connections', icon: `${iconDir}/nav-connections.svg`, route: '/connections', enabled: connectionsEnabled }`, with `connectionsEnabled` threaded through `PanelAvailability` the same way `setup`/`design` are.
* Add `case 'connections': return getConnectionsHtml(...)` to `getPanelHtmlById()` (`:479-490`).

**Logic:** placing the row **after `setup`** keeps the rail's existing order stable for users who navigate by position.

**Edge cases:** `terminals` is `availability?.terminals === true` (fail-closed) because it depends on the pty host. Connections depends only on the Kanban DB and the remote config, so it follows the `!== false` fail-open convention of `setup`/`planning` — but only once change 3 confirms both hosts wire the router.

### 2. `src/services/LocalApiServer.ts` — serve the panel

**Context:** the panel routes sit together at `:3560-3575`.

**Implementation:** add, matching the neighbours' shape:

```ts
} else if ((pathname === '/connections' || pathname === '/connections.html') && req.method === 'GET') {
    await this._handleServeConnections(req, res);
```

with `_handleServeConnections` mirroring `_handleServeProject` / `_handleServeSetup`.

**Edge cases:** the panel is served only when `serveStatic` is configured, as with every other panel — no change to that gate.

### 3. Verb routing in both hosts

**Context:** PRD contract #7. The Remote form's messages are handled today by the Setup panel's provider, because the markup lives in `setup.html`.

**Implementation:** decide and record one of two options, then implement it consistently:
* **(a)** Keep the arms in `SetupPanelProvider` and route `/connections/verb/<name>` to `setupVerb`. Cheapest, zero arm churn, and the precedent already exists — `/project/verb/` and `/memo/verb/` both route to `planningVerb` (`:3567-3572`).
* **(b)** Introduce a `ConnectionsPanelProvider`. Cleaner long-term, but it is a new provider file with a new allowlist block, new schemas and a new ratchet baseline entry.

**Recommendation: (a).** It matches the existing multiplexing pattern, keeps `verbSchemas.ts` and the return-contract baselines untouched, and does not add a provider to the burndown. Revisit only if the Connections surface grows arms that have nothing to do with Setup.

**Edge cases:** whichever option is chosen, confirm the router is constructed in **both** `TaskViewerProvider._startLocalApiServer` and `src/standalone/bootstrap.ts`. Where it is not, the manifest row must report `enabled: false` for that host.

### 4. `src/webview/setup.html` → `src/webview/connections.html` — move the form

**Implementation:** move the `remote-fields` block (`:1084` onward) and every listener and state-hydration path that binds to its ids. Leave the `remote.config` DB key and the payload shape untouched.

Replace the Setup tab (`:678`) with a short signpost row — "Remote Control is now **Connections**" plus a link that opens the Connections panel — rather than deleting the tab outright.

**Edge cases:** verify persistence by round-tripping: configure a provider, reload the window, confirm the settings survive. A form that renders correctly and saves nothing is the specific failure mode here, and it looks identical to success until the next reload.

### 5. `icons/nav-connections.svg` (new)

**Implementation:** a single-colour, mask-compatible SVG matching the existing `nav-*.svg` family in `./icons/`. `shell.js:46-54` applies it via `webkitMaskImage`/`maskImage`, so any fill, stroke colour or multi-path colouring in the source is discarded — the silhouette is the whole design.

**Edge cases:** a multi-colour or photographic asset renders as a solid block. Check it against the rail in both themes before calling it done.

### 6. Copy, tooltip and workflow framing

* Panel intro copy names **both** use cases explicitly: driving the board while away from the machine, **and** running a second AI surface side by side with it. Include "formerly Remote Control" so the old term stays searchable.
* `kanban.html:2717` tooltip: "Start or stop Connections sync" (or equivalent) — the toggle's behaviour is unchanged.
* `.agents/workflows/switchboard-remote.md`: amend the opening framing to cover the side-by-side case. **Keep the filename and the `/switchboard-remote` trigger.** Edit `.agents/` + `AGENTS.md` as the source of truth — `CLAUDE.md` and `.claude/skills/` are generated mirrors.

---

## Verification Plan

### Automated Tests
Tests are skipped per session directive, and compilation is skipped per session directive. Target coverage for the coding pass:
* A manifest test asserting `connections` is present with the correct route, and `enabled: false` when its availability flag is off.
* A panel-HTML test asserting `getConnectionsHtml` returns non-empty HTML with the nonce-stamped CSP and the `data-panel="connections"` body attribute — the same shape as the existing per-panel tests.

### Manual Verification
1. **Rail entry:** the Connections icon appears in `shell.html`'s strip in both hosts, renders as a mask glyph (not a solid block), and is legible in light and dark themes.
2. **Panel loads:** clicking it opens the Connections panel with the Remote form intact and correctly styled — same fonts, same palette as its neighbours.
3. **Config round-trip (the load-bearing check):** set provider, workspace, boards, mode and each toggle; reload the window; every setting persists. Then confirm the value landed under the existing `remote.config` Kanban DB key, unrenamed.
4. **Toggle still works:** the `kanban.html` toolbar button starts and stops sync, and its active state reflects correctly in both the toolbar and the new panel.
5. **Signpost:** the Setup panel's former Remote tab shows the pointer to Connections and opens it.
6. **Capability honesty:** in a host where the verb router is not wired, the rail entry is disabled or absent — never a dead icon.
7. **Byte-compat:** no existing panel changes behaviour; `npm run parity:check` and `push-routing:check` stay green.
8. **Plan import:** confirm the importer registers this plan on the board.

---

## Recommendation

Complexity 6 → **Send to Coder.**
