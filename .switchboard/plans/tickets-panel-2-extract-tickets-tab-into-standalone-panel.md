# Extract the TICKETS tab into its own panel, registered in both the VS Code and standalone hosts

## Goal

Move the TICKETS tab out of the Artifacts panel into a dedicated Tickets panel with its own direct entry point, registered in **both** hosts: the VS Code editor host and the standalone browser host. After this plan, tickets is one click from the status bar instead of open-Artifacts-then-find-the-tab, and `planning.js` sheds roughly a third of its size.

### Problem and background

Tickets is the most frequently opened destination in the Artifacts panel, but it is reached by opening a panel whose default tab is DOCS and then selecting the third of five tabs. It also competes with four unrelated tabs for a single panel slot, so it cannot be kept open alongside the board.

It does not belong in that panel on the merits either. DOCS, HTML, RESEARCH and WEB AGENTS all *prepare or inspect local material for an agent*. TICKETS is the only tab that **reads and writes an external system** — ClickUp/Linear issues, comments, assignees, priorities, tags, sync badges, attachments, and import-to-kanban. Different job, different failure modes, different rate limits.

The size is the second half of the problem. TICKETS accounts for:

- ~4,600 of `planning.js`'s 12,982 lines, across **8 non-contiguous regions** — it is interleaved, not a block
- 239 `ticket` references in `planning.html` (verified) across markup and `<style>`, with the tab body at `planning.html:3968` and the tab button at `planning.html:3710`
- 371 `ticket` references in `PlanningPanelProvider.ts` (9,988 lines) — verified
- roughly 80 of the ~170 verbs in `PLANNING_VERBS`

### Root cause

The tab was added to the Artifacts panel because that is where the doc-source integrations (ClickUp/Linear/Notion document browsing) already lived, and tickets reuse the same provider clients. Sharing a *client* was mistaken for belonging to the same *panel*. Nothing forces the coupling — the ticket verbs are independently addressable and the credentials are keyed by secret name, not by panel.

### Why this plan is bigger than "move two files"

A panel is not a file — it is an entry in **eight** hand-maintained registration lists, spread across the runtime and the CI gates. Every one of them is a hardcoded array or record; none of them discovers panels dynamically. Missing one produces a *silent* partial registration, not a build error. The original draft named three of the eight. The complete set is enumerated in **Proposed Changes** and is the main reason this plan is Lead-Coder tier.

The most dangerous of the eight: `scripts/check-icon-parity.js` has a hardcoded `PANELS` array (`design.html`, `kanban.html`, `planning.html`, `setup.html`, `implementation.html`, `project.html`). **`icons:parity` is the gate this plan relies on to catch the solid-block failure mode — and it will not inspect `tickets.html` at all until `tickets.html` is added to that array.** Running the gate and seeing green would otherwise prove nothing.

## Metadata

**Tags:** refactor, frontend, ui, backend
**Complexity:** 9

> **Superseded:** **Complexity:** 8
> **Reason:** The verified registration surface is eight hardcoded lists, not three, and two of the newly-found ones (`wsHub.ts` surface validation, `check-icon-parity.js` PANELS) fail *silently* — one drops the panel's entire WebSocket push stream, the other renders the plan's own safety gate inert. Combined with a state migration across ~4,000 installs and dual-host parity, this is architectural rather than merely multi-file.
> **Replaced with:** **Complexity:** 9 — Lead Coder.

## User Review Required

- **Ordering change (see `## Dependencies`).** Plan 3 should now land **before** this plan, not after it. The original sequence forced this plan to carve out three verbs it otherwise owns; landing plan 3 first removes the carve-out. Confirm the resequence.
- **`showTicketsButton` default.** The existing `statusBar.show*Button` family all default `true` (`extension.ts:2269-2273`). A new Tickets button defaulting `true` adds an item to every existing user's status bar unannounced. Recommendation: default `true` for discoverability (it is replacing a click path users already had), but this is a visible change to 4,000 installs and is the user's call.
- **Fate of `saveTicketsFolder` / `browseTicketsFolder` / `listTicketsFolders` on the Planning side.** Verified: **no `planning.js` code posts any of the three.** They are provider handlers reachable only over `POST /planning/verb/*` — an API-only surface published through `GET /catalog`. Once plan 3 lands they can move here with the rest of the ticket verbs. Decide whether they move, stay in `PlanningPanelProvider` as API-only compatibility, or are deprecated.

## Approach

### New webview files

- `src/webview/tickets.html` — tab chrome plus the ticket markup lifted from `planning.html:3968`+ and its `<style>` rules. Single tab initially (`TICKETS`); plan 4 adds `CLICKUP` and `LINEAR`.
- `src/webview/tickets.js` — the ~4,600 lines of ticket logic from `planning.js`, plus every helper plan 1 classified as **ticket-only**. Plan 1's completion notes already resolve this: the comment helpers (`renderCommentManager`, `formatCommentDate`, `commentAuthorName`, `commentBodyText`, `commentDateRaw`, `optimisticInsertComment`, `rollbackOptimisticComment`, `mergeOptimisticReplies`) and the mention-autocomplete set (`extractMentionsFromText`, `handleMentionAutocomplete`, `handleMentionKeydown`, `closeMentionDropdown`) are ticket-only and come here. Do not re-derive the classification.

Both must receive the same URI-placeholder injections `planning.html` gets — `{{SHARED_UTILS_URI}}`, `sharedDefaults.js`, `markdownEditor.js` where used — in **both** hosts. Name the companion script placeholder `{{TICKETS_JS_URI}}` so `check-icon-parity.js`'s `COMPANION_RE` (`/\{\{([A-Z0-9]+)_JS_URI\}\}/g`) picks up `tickets.js` when scanning for icon-class tokens.

### VS Code host

- `src/services/TicketsPanelProvider.ts` — new provider owning the ticket verbs moved out of `PlanningPanelProvider`. Follow the existing provider shape: `_pushTo(panel, surface, message)` over the broadcast transport (`PlanningPanelProvider.ts:930`), `_resolveWorkspaceRoot`, `_seams()` for UI dialogs, panel revival.
  **Its message switch must be spelled `switch (msg.type)` exactly.** The catalog scanner matches a per-provider regex (`scripts/generate-protocol-catalog.js:33-38`); `switch (message.type)` or `switch (message?.type)` are different patterns owned by other providers. A mismatch yields **zero** extracted verbs and an empty `TICKETS_VERBS` with no error.
- `switchboard.openTicketsPanel` command in `package.json` `contributes.commands`, mirroring `switchboard.openPlanningPanel` / `switchboard.openDesignPanel`.
- `switchboard.statusBar.showTicketsButton` in `package.json` `contributes.configuration`, mirroring the five existing `showKanbanButton` / `showArtifactsButton` / `showDesignButton` / `showProjectButton` / `showMemoButton` entries.
- Status bar item in `src/extension.ts`, mirroring the artifacts/design items (design's command binding is at `extension.ts:2249`).
- **Three** button-list sites in `extension.ts`, not one — each reads the `show*Button` family independently:
  1. `updateStatusBarVisibility()` — reads at `:2269-2273`, shows/hides at `:2292`/`:2298` and `:2335`/`:2341`.
  2. The compact-mode hub markdown tooltip — reads at `:2366-2370`, `hasPanels` at `:2380`, entries at `:2384`/`:2386`.
  3. The `switchboard.openHub` QuickPick command — reads at `:2437-2441`, `hasPanelItems` at `:2469`, entries at `:2481`/`:2495-2499`.

  Plus the configuration-change watcher at `:2409-2410`, which must also observe `switchboard.statusBar.showTicketsButton` or the toggle will not take effect until reload.
  > **Superseded:** "Hub button, mirroring `extension.ts:2380`/`:2382`."
  > **Reason:** Understated by two. There are three independent panel-button lists plus a config watcher; wiring only the markdown hub leaves the status bar and the QuickPick without a Tickets entry, and leaves the setting inert until reload.
  > **Replaced with:** The four-site enumeration above.

### Standalone host — every registration point

`transport.js` derives its rail from `document.body.dataset.panel` (`transport.js:25-26`), so setting `data-panel="tickets"` routes automatically to `/tickets/verb/*`. `shell.js` builds the left nav from `GET /panels` (`shell.js:314`), so the panel appears in the strip and `/#tickets` deep-links work with no shell changes. What must be added:

| File | Change |
|---|---|
| `src/services/headlessPanelHtml.ts` | `getTicketsHtml()` setting `data-panel="tickets"` (mirror `getPlanningHtml` at `:253`, whose `bodyAttr` is built at `:285`); `tickets?: boolean` on `PanelAvailability` (`:415`); manifest entry in `getPanelsManifest` (`:422`); `case 'tickets':` in `getPanelHtmlById` (`:442`) |
| `src/services/LocalApiServer.ts` | `/tickets` + `/tickets.html` → `_handleServePanelById('tickets', …)` (mirror the planning route at `:3496`); `/tickets/verb/` rail (mirror `:3396`) → new `_handleTicketsVerb` (mirror `_handlePlanningVerb` at `:1727`); `ticketsVerb?:` on the options interface beside `planningVerb?:` (`:183`) and `setupVerb?:` (`:202`) |
| `src/services/TaskViewerProvider.ts:2208` | add `tickets: true` to the `sharedGetPanelsManifest({ design: true, setup: true, planning: true, terminals: ptyHostReady() })` availability call |
| `src/services/wsHub.ts` | **`SURFACES` (`:41`) needs a `tickets` member, and `PANEL_SURFACES` (`:68`) needs `tickets: [SURFACES.tickets, SURFACES.common]`.** Without the `SURFACES` entry, `VALID_SURFACES` (`:77`) filters the panel's declared `tickets` surface out at `:217`, the connection subscribes to `common` only, and **every ticket push is silently dropped** — the panel loads, renders, and never live-updates |
| `src/webview/transport.js` | matching `tickets: ['tickets','common']` entry in `PANEL_SURFACES_MAP` (`:95`) — the file's own comment at `:83-94` states it is a hand-maintained mirror of `wsHub.PANEL_SURFACES`; add `openTicketsPanel: 'tickets'` to `PANEL_SWITCH_VERBS` (`:218`) so the editor-host open command becomes a cross-panel switch in the shell |
| `icons/nav-tickets.svg` | new nav asset — **eight** `nav-*.svg` exist (`artifacts`, `board`, `design`, `memo`, `project`, `setup`, `terminals`, `theme`); there is no tickets one |
| `scripts/generate-protocol-catalog.js:33` | add `{ name: 'Tickets', file: 'src/services/TicketsPanelProvider.ts', switchPattern: /switch\s*\(msg\.type\)/ }` to `PROVIDERS`. **This is the source of truth** — `protocol-catalog.json` is a generated artifact (`catalog:generate` runs `generate-protocol-catalog.js --write`), not a file to hand-edit |
| `scripts/verb-switch-helper.js:5` | the **same** `PROVIDERS` entry, duplicated in this second hardcoded list, which backs `verb-returns:check` |
| `scripts/generate-verb-allowlist.js:29` | add `{ name: 'Tickets', set: 'TICKETS_VERBS' }` to `PROVIDER_SETS`, then `npm run catalog:generate`. `catalog:check` is a CI drift gate and **will** fail until this is done |
| `scripts/check-icon-parity.js` | add `'tickets.html'` to the hardcoded `PANELS` array. **Non-optional:** the gate only inspects panels in this list, so without it `icons:parity` passes while checking nothing about the new panel |
| `scripts/check-push-routing.js:27` | add a `BASELINES` entry for `src/services/TicketsPanelProvider.ts`. Set it to the number of transport-internal raw `webview.postMessage` sends actually needed — ideally `0`. For reference the existing baselines are Planning `3`, Kanban/Design/Setup/TaskViewer `1`. Never raise an existing baseline |

> **Superseded:** "`protocol-catalog.json`, `scripts/generate-verb-allowlist.js` — add `{ name: 'Tickets', set: 'TICKETS_VERBS' }` to `PROVIDER_SETS`."
> **Reason:** Named a generated output as an input and omitted the actual source list. `PROVIDER_SETS` in `generate-verb-allowlist.js` only names the *set variable*; the verbs themselves are extracted by `generate-protocol-catalog.js`'s separate `PROVIDERS` list. Editing only `PROVIDER_SETS` produces `export const TICKETS_VERBS = new Set([])` — an empty allowlist that rejects every ticket verb on the standalone rail with no build error.
> **Replaced with:** The three-script enumeration above (`generate-protocol-catalog.js:33`, `verb-switch-helper.js:5`, `generate-verb-allowlist.js:29`), with `protocol-catalog.json` treated as output.

### Migration — remembered tab state

There are **two** independent stores, and the original draft conflated them:

1. **Host-side panel state.** `persistTab` (`planning.js:146`) does **not** write `localStorage`. It debounces 300ms and posts `{type:'persistTabState', tabKey, workspaceRoot, state}`; `PlanningPanelProvider.ts:2593` routes it to `this._stateStore.setPanelState(tabKey, state)` / `setRootState(tabKey, root, state)`. The webview reads it back through `window.getRestoredState` (`planning.js:165-168`), seeded from a host push (`planning.js:5269-5270`, `:5315-5316`). Ticket-scoped keys already in use include `tickets.root` (`PlanningPanelProvider.ts:2612`, `planning.js:5318`).
2. **Browser-host `vscode.getState()` shim.** `transport.js:27` keys the shim's state blob as `` `sb-state-${panel}` `` in `localStorage`, where `panel` comes from `data-panel`. This is the standalone equivalent of the editor's webview state (and is separately seeded from a `<meta name="sb-initial-state">` tag on revival — `planning.js:9-13`).

> **Superseded:** "`persistTab` stores the last active tab per panel: `sb-state-<panel>` in `localStorage` for the browser host, webview state in the editor host."
> **Reason:** `persistTab` writes neither. It posts a verb to the host, which writes the panel state store. `sb-state-<panel>` is `transport.js`'s `vscode` shim blob — a different store with a different lifecycle. A migration written against the wrong store silently no-ops.
> **Replaced with:** The two-store description above. The migration must address whichever store actually holds the active-tab key; establish that first by inspecting a real install's state before writing migration code.

This extension has ~4,000 installs, so a meaningful number of users have `tickets` as their remembered Artifacts tab. On upgrade that tab no longer exists.

Required, not optional:

1. A defensive fallback in the Artifacts panel: an unknown remembered tab resolves to `docs` instead of leaving every tab body hidden.
2. A **one-time redirect**: a remembered Artifacts tab of `tickets` opens the Tickets panel instead, then clears the marker so it fires once. Users who lived in that tab land where they expect rather than being silently dropped on DOCS.
3. Carry the ticket-scoped root selection across: `tickets.root` currently lives under the *planning* panel's state store. Either migrate it to the Tickets panel's store or have the new provider read the planning key on first run. Losing it silently resets every user's ticket workspace selection.

Follow the repo's migration rules — the state shipped in a released version, so it gets migrated rather than reset.

## Complexity Audit

### Routine

- Lifting markup, `<style>` rules and JS regions between files — large but mechanical, and plan 1 has already de-risked the helper boundary.
- The provider shape, the `{{…_URI}}` injection pattern, the manifest entry and the verb-rail handler all have four to seven existing examples to copy verbatim.
- `shell.js` and `transport.js` route by `data-panel` with no per-panel branching, so the nav strip and rail prefix come free.

### Complex / Risky

- **Eight hardcoded registration lists, several failing silently.** `wsHub.SURFACES` omission kills the live push stream with a fully functional-looking panel. `check-icon-parity.js` omission makes the plan's own headline gate inert. `generate-protocol-catalog.js` omission yields an empty `TICKETS_VERBS`, 403-ing every verb on the standalone rail only.
- **`switchPattern` regex coupling.** The new provider's `switch` statement must be spelled exactly `switch (msg.type)` or the catalog extracts nothing.
- **Two-store state migration across ~4,000 installs**, where the original draft named the wrong store.
- **Dual-host parity.** Editor and standalone wire the panel through entirely disjoint code (`PlanningPanelProvider.ts:720` vs `headlessPanelHtml.ts:242`; command palette vs `GET /panels`). Passing in one proves nothing about the other.
- **~4,600 interleaved lines across 8 non-contiguous regions.** Extraction by region boundary, not by search-and-cut; a missed closure or shared module-level variable produces a `ReferenceError` that blanks a whole panel at load.
- `PlanningPanelProvider.ts` carries a push-routing baseline of `3`; the new provider must not inherit raw `webview.postMessage` sites.

## Edge-Case & Dependency Audit

**Race Conditions**
- `sharedUtils.js` is injected as the **first** script in the standalone host (`headlessPanelHtml.ts:244`), ahead of `transport.js` and the panel's own JS. `tickets.js` must not assume any panel global exists at load time.
- `transport.js` generates the per-client `originatorId` before its first WebSocket connect and builds the WS URL with the `surfaces` parameter at that moment (`transport.js:118-121`). The `PANEL_SURFACES_MAP` entry must therefore exist before the first connect — it is read once per connection, not renegotiated.
- Panel revival boots a **new** webview with `getState() === undefined`; the host inlines the pre-reload payload into `<meta name="sb-initial-state">` (`planning.js:5-19`). `tickets.js` must replicate that seed-once-before-first-getState pattern or every persisted preference resets on each window reload.
- Both panels open simultaneously is the normal case after this change. Any ticket state the two providers both read (`tickets.root`) must have exactly one writer.

**Security**
- Escaping helpers arrive from `sharedUtils.js` per plan 1. `tickets.js` must not re-declare `escapeHtml` / `escapeAttr` locally — a local declaration inside the `tickets.js` IIFE silently shadows the shared one and re-opens the divergence plan 1 exists to close.
- The new panel needs its own CSP with a nonce, matching the pattern the other panels use. Inline scripts without a nonce are blocked (`planning.js:5-8` documents this).
- `/tickets/verb/*` is a new authenticated HTTP surface. `_handleTicketsVerb` must gate on `TICKETS_VERBS` exactly as `_handlePlanningVerb` gates on `PLANNING_VERBS` — an ungated rail is remote code reach into the provider.

**Side Effects**
- Adding a `tickets` entry to `GET /panels` changes the manifest every standalone client reads; older cached shells tolerate unknown ids, but confirm.
- A new status bar item is visible to every install on upgrade (see User Review Required).
- Removing ~4,600 lines from `planning.js` shifts every line number below the cut. Any other in-flight branch touching `planning.js` will conflict extensively — coordinate merge order.
- The `tickets` surface is new; nothing currently publishes to it, so a provider that pushes with an unregistered surface string is the failure to watch for.

**Dependencies & Conflicts**
- **Requires plan 1 merged** — otherwise the choice is duplicate escaping helpers or importing `planning.js` wholesale.
- **Should follow plan 3** (resequenced; see below). With plan 3 merged, the three colliding tickets-folder verbs can move here with the rest of the ticket surface instead of being carved out.
- **Blocks plan 4** — the Tickets panel must exist before the ClickUp/Linear tabs can move into it.
- Shares `planning.js` and `planning.html` with plan 1 (sequential, not concurrent). Shares no file with plan 3, which touches only `PlanningPanelProvider.ts` / `SetupPanelProvider.ts` / `setup.html` / the generated allowlist.

## Dependencies

- No prior research sessions — nothing to reference in `sess_…` form.
- **Upstream:** `tickets-panel-1-lift-shared-webview-helpers-into-sharedutils.md` (required, merged). `tickets-panel-3-decollide-duplicate-tickets-folder-verbs.md` (recommended before, see below).
- **Downstream:** `tickets-panel-4-move-clickup-and-linear-config-out-of-setup.md`.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is silent partial registration: a Tickets panel is eight hardcoded list entries, and three of the omissions fail without any error — a missing `wsHub.SURFACES` member makes `VALID_SURFACES` filter the panel's subscription down to `common` so every ticket push is dropped by a panel that otherwise looks perfect; a missing `check-icon-parity.js` PANELS entry makes the very gate this plan leans on inspect nothing; a missing `generate-protocol-catalog.js` PROVIDERS entry emits an empty `TICKETS_VERBS` that 403s the standalone rail only. Second risk is the state migration, which the original draft aimed at the wrong store (`persistTab` posts a verb to a host-side state store; `sb-state-<panel>` is `transport.js`'s separate `vscode`-shim blob) — so a migration could pass review and no-op in production across ~4,000 installs. Mitigation: treat the eight-list table as a checklist verified item-by-item against a running standalone host, prove `icons:parity` actually inspects `tickets.html` before trusting it, and confirm which store holds the active-tab key on a real install before writing migration code.

## Proposed Changes

### `src/webview/tickets.html` (new)

- **Context:** Mirrors `planning.html`'s chrome. Ticket body currently at `planning.html:3968`; tab button at `:3710`.
- **Logic:** `data-panel="tickets"` on `<body>`. One tab (`TICKETS`); plan 4 adds two more. Own CSP + nonce. `{{SHARED_UTILS_URI}}` and `{{TICKETS_JS_URI}}` placeholders.
- **Implementation:** Lift the ticket markup and its `<style>` rules out of `planning.html`. Copy the `.sb-icon-*` mask rules for every icon class the ticket markup and `tickets.js` use — byte-exact base64 in *this* panel's CSS.
- **Edge Cases:** A missing mask rule does not hide the icon; `background-color: currentColor` still paints a **solid block**. Only `icons:parity` catches it, and only once `tickets.html` is in its `PANELS` array.

### `src/webview/tickets.js` (new)

- **Context:** ~4,600 lines from `planning.js` across 8 non-contiguous regions, plus plan 1's ticket-only helper set.
- **Logic:** Single IIFE, same shape as `planning.js`. Reuse the `<meta name="sb-initial-state">` seed-before-first-getState block.
- **Implementation:** Move by region boundary. Bring the comment and mention helper sets named in plan 1's Resolved Assumptions.
- **Edge Cases:** Do not re-declare `escapeHtml` / `escapeAttr` / `persistTab` — they are globals from `sharedUtils.js` after plan 1, and a local declaration shadows them.

### `src/services/TicketsPanelProvider.ts` (new)

- **Context:** Splits ~80 verbs and 371 ticket references out of `PlanningPanelProvider.ts`.
- **Logic:** `switch (msg.type)` — exact spelling required by the catalog scanner. Push through `_pushTo(panel, 'tickets', message)`; zero raw `webview.postMessage`.
- **Implementation:** Copy `PlanningPanelProvider`'s `_resolveWorkspaceRoot`, `_seams()`, revival and `_pushTo` shape.
- **Edge Cases:** `persistTabState` handling and the `tickets.root` key must be carried across, or every user's ticket workspace selection resets.

### `src/services/wsHub.ts`

- **Context:** `SURFACES:41`, `PANEL_SURFACES:68`, `VALID_SURFACES:77`, filter at `:217`.
- **Logic:** Add `tickets: 'tickets'` to `SURFACES` and `tickets: [SURFACES.tickets, SURFACES.common]` to `PANEL_SURFACES`.
- **Implementation:** Both, in the same commit as the `transport.js` mirror — the file comment states they must change together.
- **Edge Cases:** `SURFACES` without `PANEL_SURFACES` leaves the panel fail-open on the full stream (works, but wrong). `PANEL_SURFACES` without `SURFACES` is the silent killer: the declared surface is filtered out and only `common` survives. Note `project` is deliberately absent from `PANEL_SURFACES` (see the `:59-66` comment) — do not "complete" that map while here.

### `src/webview/transport.js`

- **Context:** `PANEL_SURFACES_MAP:95` (hand-maintained mirror), `PANEL_SWITCH_VERBS:218`.
- **Logic:** Add `tickets: ['tickets','common']` and `openTicketsPanel: 'tickets'`.
- **Edge Cases:** Observation for the record, out of scope to fix here — `PANEL_SWITCH_VERBS` currently maps `openPlanningPanel: 'project'`, which looks wrong given `openProjectPanel: 'project'` sits on the next line. Report it; do not fix it in this plan.

### `src/services/headlessPanelHtml.ts` / `src/services/LocalApiServer.ts` / `src/services/TaskViewerProvider.ts`

- As enumerated in the registration table above, with the verified line anchors.

### `scripts/generate-protocol-catalog.js`, `scripts/verb-switch-helper.js`, `scripts/generate-verb-allowlist.js`, `scripts/check-icon-parity.js`, `scripts/check-push-routing.js`, `package.json`, `src/extension.ts`, `icons/nav-tickets.svg`

- As enumerated in the registration table and the VS Code host section above.

## Constraints

- **Do not touch the dead ticket CSS in `design.html`** (88 `ticket` references, `<style>`-only). Out of scope by explicit decision.
- Do not change verb names, payload shapes or storage in this plan; it is a relocation. Behaviour changes belong in plans 3 and 4. *Clarification:* the two net-new verbs this plan adds (`getStatusShowTicketsSetting` / `setStatusShowTicketsSetting`, alongside the existing `getStatusShow*` / `setStatusShow*` family in `SETUP_VERBS`) are additions, not renames, and are in scope.
- **`saveTicketsFolder` / `browseTicketsFolder` / `listTicketsFolders`:** if plan 3 has **not** merged, leave the Planning copies alone — moving them onto the Tickets rail before the Setup side is renamed risks landing both meanings in one namespace. If plan 3 **has** merged (the recommended order), they may move here with the rest of the ticket surface. Verified: no `planning.js` code posts any of the three, so the carve-out costs nothing either way — `planning.js` posts `addTicketsFolder` (`:9531`) and `removeTicketsFolder` (`:3707`) and only *listens* for `ticketsFoldersListed` (`:6026`).
- The HTML tab stays in Artifacts. Artifacts-HTML (HTML docs) and Design-PREVIEWS (designs) are deliberately separate surfaces.
- Notion config stays in Setup — it is the Remote Control bridge, not a ticket provider.

## Verification Plan

### Automated Tests

- `npm run lint`, `npm run compile-tests`.
- `npm run catalog:generate` then `npm run catalog:check` — green, and **diff `src/generated/verbAllowlist.ts` to confirm `TICKETS_VERBS` is non-empty**. An empty set is the signature of a missed `generate-protocol-catalog.js` PROVIDERS entry or a mis-spelled `switch` pattern, and `catalog:check` alone will not flag it.
- `npm run parity:check` — proves the new provider is registered consistently across both hosts.
- `npm run push-routing:check` — must report `TicketsPanelProvider.ts: 0 (baseline 0)`, not merely pass.
- `npm run verb-returns:check` — backed by the second `PROVIDERS` list in `verb-switch-helper.js`; confirm it reports a Tickets row at all.
- **`npm run icons:parity` deserves specific attention, and must be proven live before it is trusted.** Every `sb-icon-<name>` class used by `tickets.html` needs a matching mask rule with byte-exact inlined base64 *in that panel's own CSS*. A missing rule does not hide the icon — `background-color: currentColor` still paints, producing a **solid block**. Before relying on the gate: confirm `'tickets.html'` is in the script's `PANELS` array, then deliberately delete one mask rule and confirm the gate fails. A gate that cannot fail is not a gate.
- Existing ticket contract tests must stay green — they encode behaviour that must survive the move:
  - `npm run test:contract:tickets-assignee-filter`
  - `npm run test:contract:tickets-sidebar-scoping`
  - `npm run test:contract:tickets-subtasks`
- Panel-infrastructure contracts: `npm run test:contract:shim-injection`, `test:contract:panel-scrollbars`, `test:contract:panel-revival-retention`, `test:contract:verb-engine-planning`.

### Manual

- **VS Code host, from an installed VSIX** (not `dist/`): open Tickets from the status bar, the hub tooltip, the `openHub` QuickPick, and the command palette — all four entry points, since they are wired independently. Exercise list, detail, hierarchy nav, subtasks, comments (post + reply), attachments (open/reveal/download), assignee/priority/tag edits, status change, sync badges, import-to-kanban, import-all. Then confirm Artifacts still works with four tabs.
- Toggle `switchboard.statusBar.showTicketsButton` off and on **without reloading** and confirm the item appears and disappears — this proves the `:2409` config watcher was updated.
- **Standalone browser host**: confirm `GET /panels` includes `tickets`, the nav icon renders as an icon and not a block, `/tickets` serves, `/#tickets` deep-links, and `POST /tickets/verb/<verb>` reaches the new provider. Repeat the full functional sweep — the two hosts wire the panel through different code and passing in one proves nothing about the other.
- **WebSocket surface check (the silent-failure probe).** With `/tickets` open in the browser host, mutate a ticket from *outside* that panel and confirm the live update arrives. Then inspect the WS URL and confirm it carries `surfaces=tickets,common`. If the parameter is absent or reduced to `common`, the `wsHub.SURFACES` entry is missing.
- **Migration check**: on a real pre-upgrade install, first establish which store holds the remembered Artifacts tab, then seed it to `tickets`, upgrade, and confirm the Tickets panel opens once and the marker clears on the second launch. Separately seed a garbage tab value and confirm it falls back to DOCS with no blank panel. Separately confirm a pre-existing `tickets.root` selection survives into the new panel.
- Confirm nothing was left behind: no ticket verb answered by both `PlanningPanelProvider` and `TicketsPanelProvider`, and no orphaned ticket markup or style rules in `planning.html`.

## Resolved Assumptions

Settled this pass by direct inspection — do not re-open, and do not send to research:

- `planning.js` posts **none** of `saveTicketsFolder` / `browseTicketsFolder` / `listTicketsFolders`. It posts `addTicketsFolder:9531` and `removeTicketsFolder:3707` and listens for `ticketsFoldersListed:6026`. The three colliding verbs are API-only on the Planning side.
- `persistTab` posts a `persistTabState` verb; `PlanningPanelProvider.ts:2593` writes `_stateStore`. `sb-state-<panel>` in `localStorage` is `transport.js:27`'s separate `vscode`-shim blob.
- Eight `nav-*.svg` assets exist today; `nav-tickets.svg` is not among them.
- `protocol-catalog.json` is generated by `catalog:generate`, not hand-edited.
- `getPanelHtmlById` already cases seven panels (`board`, `project`, `memo`, `planning`, `design`, `setup`, `terminals`); `PanelAvailability` declares only four optional flags (`design`, `setup`, `planning`, `terminals`).
- All named `npm run` gates in this plan exist in `package.json`.

## Recommendation

**Complexity 9 → Send to Coder.** Ready to execute once plan 1 is merged, plan 3 is merged (recommended resequence), and the `showTicketsButton` default and Planning-trio disposition are confirmed.

## Completion Report

Extracted TICKETS tab out of `planning.html` / `planning.js` into standalone `tickets.html`, `tickets.js`, and `TicketsPanelProvider.ts`. Registered panel across all 8 registration surfaces (`wsHub.ts`, `headlessPanelHtml.ts`, `LocalApiServer.ts`, `transport.js`, `TaskViewerProvider.ts`, `generate-protocol-catalog.js`, `generate-verb-allowlist.js`, `check-icon-parity.js`, `check-push-routing.js`). Added status bar controls and configuration in `package.json` and `extension.ts`. Created `nav-tickets.svg` asset. Regenerated protocol catalog and verb allowlist. No issues encountered.
