# Extract the TICKETS tab into its own panel, registered in both the VS Code and standalone hosts

## Goal

Move the TICKETS tab out of the Artifacts panel into a dedicated Tickets panel with its own direct entry point, registered in **both** hosts: the VS Code editor host and the standalone browser host. After this plan, tickets is one click from the status bar instead of open-Artifacts-then-find-the-tab, and `planning.js` sheds roughly a third of its size.

### Problem and background

Tickets is the most frequently opened destination in the Artifacts panel, but it is reached by opening a panel whose default tab is DOCS and then selecting the third of five tabs. It also competes with four unrelated tabs for a single panel slot, so it cannot be kept open alongside the board.

It does not belong in that panel on the merits either. DOCS, HTML, RESEARCH and WEB AGENTS all *prepare or inspect local material for an agent*. TICKETS is the only tab that **reads and writes an external system** — ClickUp/Linear issues, comments, assignees, priorities, tags, sync badges, attachments, and import-to-kanban. Different job, different failure modes, different rate limits.

The size is the second half of the problem. TICKETS accounts for:

- ~4,600 of `planning.js`'s 12,982 lines, across **8 non-contiguous regions** — it is interleaved, not a block
- 114 markup references and 182 style references in `planning.html`, with the tab body at `planning.html:3967` (~103 lines) and the tab button at `planning.html:3709`
- 234 ticket references in `PlanningPanelProvider.ts` (9,988 lines)
- roughly 80 of the ~170 verbs in `PLANNING_VERBS`

### Root cause

The tab was added to the Artifacts panel because that is where the doc-source integrations (ClickUp/Linear/Notion document browsing) already lived, and tickets reuse the same provider clients. Sharing a *client* was mistaken for belonging to the same *panel*. Nothing forces the coupling — the ticket verbs are independently addressable and the credentials are keyed by secret name, not by panel.

## Approach

### New webview files

- `src/webview/tickets.html` — tab chrome plus the ticket markup lifted from `planning.html:3967`+ and its `<style>` rules. Single tab initially (`TICKETS`); plan 4 adds `CLICKUP` and `LINEAR`.
- `src/webview/tickets.js` — the ~4,600 lines of ticket logic from `planning.js`, plus any helper plan 1 classified as **ticket-only**.

Both must receive the same URI-placeholder injections `planning.html` gets — `sharedUtils.js`, `sharedDefaults.js`, `markdownEditor.js` where used — in **both** hosts.

### VS Code host

- `src/services/TicketsPanelProvider.ts` — new provider owning the ticket verbs moved out of `PlanningPanelProvider`. Follow the existing provider shape: `postMessageToWebview` via the broadcast transport, `_resolveWorkspaceRoot`, `_seams()` for UI dialogs, panel revival.
- `switchboard.openTicketsPanel` command in `package.json`.
- Status bar item in `src/extension.ts`, mirroring the artifacts/design items at `extension.ts:2233` and `:2245`.
- Hub button, mirroring `extension.ts:2380`/`:2382`, gated by a new `showTicketsButton` setting with matching `getStatusShowTicketsSetting` / `setStatusShowTicketsSetting` verbs alongside the existing `setStatusShow*` family in `SETUP_VERBS`.

### Standalone host — every registration point

`transport.js` derives its rail from `document.body.dataset.panel`, so setting `data-panel="tickets"` routes automatically to `/tickets/verb/*`. `shell.js` builds the left nav from `GET /panels`, so the panel appears in the strip and `/#tickets` deep-links work with no shell changes. What must be added:

| File | Change |
|---|---|
| `headlessPanelHtml.ts` | `getTicketsHtml()` setting `data-panel="tickets"` (mirror the planning call at `:285`); manifest entry (`getPanelsManifest`, ~`:431`); `getPanelHtmlById` case (~`:447`); `tickets?: boolean` on `PanelAvailability` |
| `LocalApiServer.ts` | `/tickets` + `/tickets.html` → `_handleServePanelById('tickets', …)`; `/tickets/verb/` rail → new `_handleTicketsVerb`; `ticketsVerb?:` on the options interface near `:182` |
| `TaskViewerProvider.ts:2033` | add `tickets: true` to the `sharedGetPanelsManifest({…})` availability call |
| `icons/nav-tickets.svg` | new nav asset — the other seven `nav-*.svg` exist; there is no tickets one |
| `protocol-catalog.json`, `scripts/generate-verb-allowlist.js` | add `{ name: 'Tickets', set: 'TICKETS_VERBS' }` to `PROVIDER_SETS`, then `npm run catalog:generate`. `catalog:check` is a CI drift gate and **will** fail until this is done |
| `scripts/check-push-routing.js` | add a `BASELINES` entry for `src/services/TicketsPanelProvider.ts`. Set it to the number of transport-internal raw sends actually needed — ideally `0`. Never raise an existing baseline |

### Migration — remembered tab state

`persistTab` stores the last active tab per panel: `sb-state-<panel>` in `localStorage` for the browser host, webview state in the editor host. This extension has ~4,000 installs, so a meaningful number of users have `tickets` as their remembered Artifacts tab. On upgrade that tab no longer exists.

Required, not optional:

1. A defensive fallback in the Artifacts panel: an unknown remembered tab resolves to `docs` instead of leaving every tab body hidden.
2. A **one-time redirect**: a remembered Artifacts tab of `tickets` opens the Tickets panel instead, then clears the marker so it fires once. Users who lived in that tab land where they expect rather than being silently dropped on DOCS.

Follow the repo's migration rules — the state shipped in a released version, so it gets migrated rather than reset.

## Constraints

- **Do not touch the dead ticket CSS in `design.html`.** Those 108 `<style>`-only references are out of scope by explicit decision.
- Do not change verb names, payload shapes or storage in this plan; it is a relocation. Behaviour changes belong in plans 3 and 4.
- Leave `saveTicketsFolder` / `browseTicketsFolder` / `listTicketsFolders` on the Planning side alone here. They collide with same-named Setup verbs; plan 3 de-collides them. Moving the Planning copies before that is done risks landing both on one rail.
- The HTML tab stays in Artifacts. Artifacts-HTML (HTML docs) and Design-PREVIEWS (designs) are deliberately separate surfaces.
- Notion config stays in Setup — it is the Remote Control bridge, not a ticket provider.

## Verification Plan

- `npm run lint`, `npm run compile-tests`.
- `npm run catalog:check` and `npm run parity:check` — green. These are the gates that prove the new provider is registered consistently across both hosts.
- `npm run push-routing:check`, `npm run verb-returns:check`, `npm run icons:parity`.
- **`npm run icons:parity` deserves specific attention.** Every `sb-icon-<name>` class used by `tickets.html` needs a matching mask rule with byte-exact inlined base64 *in that panel's own CSS*. A missing rule does not hide the icon — `background-color: currentColor` still paints, producing a **solid block**. This gate is the only thing that catches it.
- Existing ticket contract tests must stay green — they encode behaviour that must survive the move:
  - `npm run test:contract:tickets-assignee-filter`
  - `npm run test:contract:tickets-sidebar-scoping`
  - `npm run test:contract:tickets-subtasks`
- Panel-infrastructure contracts: `test:contract:shim-injection`, `test:contract:panel-scrollbars`, `test:contract:panel-revival-retention`, `test:contract:verb-engine-planning`.
- **VS Code host, from an installed VSIX** (not `dist/`): open Tickets from the status bar, hub button, and command palette. Exercise list, detail, hierarchy nav, subtasks, comments (post + reply), attachments (open/reveal/download), assignee/priority/tag edits, status change, sync badges, import-to-kanban, import-all. Then confirm Artifacts still works with four tabs.
- **Standalone browser host**: confirm `GET /panels` includes `tickets`, the nav icon renders as an icon and not a block, `/tickets` serves, `/#tickets` deep-links, `POST /tickets/verb/<verb>` reaches the new provider, and the WebSocket push path delivers live ticket updates. Repeat the full functional sweep above — the two hosts wire the panel through different code and passing in one proves nothing about the other.
- **Migration check**: seed a remembered Artifacts tab of `tickets` (localStorage `sb-state-planning` for the browser, webview state for the editor), upgrade, and confirm the Tickets panel opens once and the marker clears on the second launch. Separately seed a garbage tab value and confirm it falls back to DOCS with no blank panel.
- Confirm nothing was left behind: no ticket verb answered by both `PlanningPanelProvider` and `TicketsPanelProvider`, and no orphaned ticket markup or style rules in `planning.html`.

## Metadata

**Complexity:** 8
**Tags:** refactor, frontend, ui
