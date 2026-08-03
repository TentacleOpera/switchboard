# Move the ClickUp and Linear config tabs out of Setup and into the Tickets panel

## Goal

Relocate the ClickUp and Linear configuration tabs from the Setup panel into the Tickets panel as sibling tabs (`TICKETS` / `CLICKUP` / `LINEAR`), so provider config lives next to the thing it configures. This removes Setup's two largest tabs and collapses a one-job-two-panels split.

### Problem and background

Setup has eleven tabs (verified, `setup.html:670-680`). ClickUp and Linear are the two largest by a factor of two:

| Tab | Body | Markup lines | | Tab | Markup lines |
|---|---|---|---|---|---|
| **ClickUp** (`setup.html:850`) | `#clickup-fields` | **205** | | Startup/Setup (`:683`) | 105 |
| **Linear** (`setup.html:1056`) | `#linear-fields` | **204** | | Status Bar (`:1417`) | 70 |
| Theme (`:1357`) | `#theme-fields` | 60 | | Plan Scanner (`:1298`) | 59 |
| Notion (`:1261`) | `#notion-fields` | 37 | | Multi-Repo (`:823`) | 27 |
| Database (`:788`) | `#db-sync-fields` | 22 | | Control Plane (`:810`) | 13 |

They also account for the bulk of `setup.html`'s inline script — 223 `clickup` and 244 `linear` references, against only 16 and 23 in `SetupPanelProvider.ts`, so nearly all of it is webview-side.

Size is the lesser problem. The real one: **ClickUp and Linear are the only Setup tabs that configure something used in a different panel.** Today you set the ClickUp token, ticket import folder, space/list/folder selection and triage pipeline in the **Setup** panel, then use tickets in the **Artifacts** panel — one job, two panels, and neither of them is the ticket panel. Setup's other nine tabs configure the extension itself (database, theme, status bar, control plane, plan scanner, multi-repo, remote).

### Root cause

Setup accreted a tab per integration because "it is configuration, so it goes in Setup". That groups by *kind of thing* rather than *job being done*. The ticket-provider config is the one case where the distinction bites, because the configured feature has a home of its own.

### What moves and what does not

**Moves:** the ClickUp tab and the Linear tab, and their `SETUP_VERBS` entries — `applyClickUpConfig`, `applyLinearConfig`, `saveClickUpAutomation`, `saveClickUpMappings`, `saveLinearAutomation`, `enableTriagePipeline`, `linearBrowseProjects`, `copyLinearAgentSkill`, `saveTicketsAutoSync`, plus the renamed tickets-folder trio from plan 3 (`saveIntegrationTicketSaveLocation`, `browseIntegrationTicketSaveLocation`, `getIntegrationTicketSaveLocations`). All verified present in `SETUP_VERBS`.

**Shared, not moved — `getIntegrationSetupStates`.** The original draft listed this among the verbs that move. It cannot simply move: `SetupPanelProvider.ts:306-310` delegates to `this._taskViewerProvider.getIntegrationSetupStates()` and re-emits the whole aggregate (`{ type: 'integrationSetupStates', ...states }`). It reports setup state for **all** integrations including Notion, which stays in Setup. Removing it from `SETUP_VERBS` breaks the Notion tab's state indicator.
> **Superseded:** "`getIntegrationSetupStates`" listed under **Moves**.
> **Reason:** It is a three-provider aggregate consumed by a tab that is explicitly staying in Setup. Moving it out of `SETUP_VERBS` breaks Notion.
> **Replaced with:** Register `getIntegrationSetupStates` in **both** `SETUP_VERBS` and `TICKETS_VERBS`, each delegating to the same `TaskViewerProvider` method. The codebase already does this for genuinely shared verbs (`getDbPath`, `ready`, `getCustomAgents`, `runSetup`, `scaffoldMultiRepo` appear in several sets) — a duplicated name is only a problem when the two implementations would disagree, which is exactly the test plan 3 established. Here they are the same call, so it is safe.

**Also needs handling — `getPlanningSources` / `savePlanningSources`.** Each of the three integration tabs contains an "Artifacts Panel Visibility" subsection with a *Show docs in Artifacts Panel* checkbox: `#planning-source-clickup` (`setup.html:861`), `#planning-source-linear` (`:1067`), `#planning-source-notion` (`:1271`). These are three siblings of one setting, backed by `getPlanningSources` / `savePlanningSources` in `SETUP_VERBS`. Moving the ClickUp and Linear tabs splits that trio across two panels and leaves a control labelled *"Show docs in Artifacts Panel"* sitting in the **Tickets** panel. Two problems, both needing a decision (see User Review Required): the verbs must be reachable from the Tickets rail, and the resulting UX is incoherent as-is.

**Does not move — Notion stays in Setup.** It is the Remote Control bridge, not a ticket provider (37 lines). Moving it would be grouping by "is an integration" — the same mistake that created this problem.

Config goes in as **sibling tabs, not behind a gear icon.** ClickUp/Linear setup here is not one-and-done: there is token entry, import-folder selection, space/folder/list selection, tag and status mapping, automation settings and the triage pipeline toggle. Users return to it.

## Metadata

**Tags:** refactor, frontend, ui, backend
**Complexity:** 6

## User Review Required

- **"Show docs in Artifacts Panel" toggles.** Three options, pick one: (a) leave all three in Setup as a single consolidated "Artifacts sources" block and move only the provider config — cleanest conceptually, splits each provider's settings across two panels; (b) move the ClickUp and Linear checkboxes with their tabs and accept that an Artifacts-panel control lives in Tickets; (c) move them and relabel to make the cross-panel effect explicit. Recommendation: **(a)** — the toggle configures the *Artifacts* panel, and consolidating it fixes an existing three-way duplication rather than propagating it. Whichever is chosen, `getPlanningSources` / `savePlanningSources` must be reachable from whichever rail hosts the checkboxes.
- **Deprecated aliases from plan 3.** If plan 3 kept the old Setup verb names as aliases, they must **not** be registered in `TICKETS_VERBS`. An alias on the Tickets rail re-creates the exact `saveTicketsFolder` collision this feature exists to remove. Confirm plan 3's completion notes before generating the catalog.

## Dependencies

- No prior research sessions — nothing to reference in `sess_…` form.
- **Plan 2** must land first — the Tickets panel must exist.
- **Plan 3 must land first, and is not optional.** `saveTicketsFolder`, `browseTicketsFolder` and `listTicketsFolders` exist in both `PLANNING_VERBS` and `SETUP_VERBS` with different meanings, different stores, different scopes, and **two shared response `type`s** (`ticketsFoldersListed` and `browseTicketsFolderResult`) carrying incompatible payloads. They are currently isolated only because `transport.js:25-26` namespaces the rail per panel. Landing this plan first would put both UIs on `/tickets/verb/*` and one `window` message stream, where they silently overwrite each other's config — and worse, `setup.html:4632-4645` reacts to `browseTicketsFolderResult` by immediately posting a save, so a Planning-side browse would trigger a Setup-side write. Do not start this plan until plan 3's rename is merged.
- **Plan 1** is upstream transitively (via plan 2) but this plan does not touch its files.
- **File conflict:** plan 3 also edits `SetupPanelProvider.ts` and `setup.html`. Do not work them concurrently.

## Complexity Audit

### Routine

- Moving two tab bodies, their `<style>` rules and their slice of the inline script between two HTML files — large but mechanical.
- Moving ten verb handlers between two providers that share a shape.
- Tab-bar button add/remove is two lines in each file.

### Complex / Risky

- **Credential survival across the move.** Highest-stakes item in the whole feature. Tokens are keyed by name, not panel, so no storage change is *required* — the risk is a well-intentioned diff that touches the secrets path anyway.
- **`getIntegrationSetupStates` is a cross-provider aggregate** whose naive relocation breaks a tab that is staying put.
- **The "Show docs in Artifacts Panel" trio** splits across panels, needing a product decision rather than a mechanical move.
- **Plan 3's aliases must not follow the verbs onto the Tickets rail** — a silent re-collision.
- **`enableTriagePipeline` has side effects beyond config.** Verify from its new home rather than assuming the handler move is sufficient.
- **Setup remembered-tab migration** across ~4,000 installs, with the same two-store subtlety plan 2 documents.
- Dual-host parity: Setup and Tickets are served through different code paths per host (`SetupPanelProvider.ts` / `headlessPanelHtml.ts:315` vs plan 2's new provider / `getTicketsHtml`).

## Edge-Case & Dependency Audit

**Race Conditions**
- `GlobalIntegrationConfigService.loadConfig`/`saveConfig` is read-modify-write on a machine-global store. Once Setup and Tickets can both be open, two panels can interleave writes to the same provider config. Do not make it worse; note it if observed.
- The Setup panel currently fires `listTicketsFolders` on init (`setup.html:2795`, renamed by plan 3). After the move, the Tickets panel fires the renamed verb on init while Setup no longer does. Confirm nothing in Setup still depends on that response arriving.
- `getIntegrationSetupStates` will now be callable from two rails concurrently. It is a read delegating to a shared method — confirm it is side-effect free before registering it twice.

**Security**
- **Do not touch the secrets bridge.** Tokens live in VS Code `secretStorage` (editor host) and the machine-global encrypted store (standalone), keyed by name — `switchboard.clickup.apiToken`, `switchboard.linear.apiToken`. They are addressed by key, never by panel, so relocating the UI touches no storage and requires no re-auth for the install base.
- `src/test/standalone-secrets-bridge-contract.test.js` documents three past bugs where plausible-looking changes silently destroyed a standalone user's only copy of their tokens — an un-awaited migration loop, an activation sweep that deleted mirrored keys, and a decrypt-failure rename that one passphrase-less process could trigger. The store is the *only* copy in standalone; there is no keychain behind it.
- Token input fields move markup only. Any diff in this plan that touches the secrets path is a mistake.
- The moved verbs must be gated by `TICKETS_VERBS` on the new rail exactly as they were by `SETUP_VERBS` — an ungated `/tickets/verb/*` is remote reach into provider config.

**Side Effects**
- Setup loses two tabs; any user muscle memory and any documentation or screenshot referencing them goes stale.
- `GET /catalog` changes shape as verbs migrate between sets.
- Setup's now-unused `.sb-icon-*` mask rules become dead CSS. `scripts/check-icon-parity.js` enforces rule **coverage** (every used class has a rule), not the reverse, so unused rules will not fail the gate — decide whether to prune them and be consistent with how the repo treats dead rules elsewhere.
- Moving 205 + 204 markup lines plus ~467 script references out of `setup.html` shifts every line number below the cut.

**Dependencies & Conflicts**
- Hard upstream: plans 2 and 3, both merged.
- Last plan in the feature; nothing downstream.
- `tickets.html` / `tickets.js` / `TicketsPanelProvider.ts` are created by plan 2 and extended here — sequential, never concurrent.

## Adversarial Synthesis

**Risk Summary.** The headline risk is credential loss: the secrets bridge has three documented past incidents where a plausible-looking change destroyed a standalone user's only copy of their tokens, and this plan's diff sits adjacent to it, so the discipline is that *any* secrets-path hunk is a defect regardless of how reasonable it looks. Second is a pair of verb-mapping traps the original draft would have walked into — `getIntegrationSetupStates` is a three-provider aggregate that Notion (staying in Setup) still needs, so moving it out of `SETUP_VERBS` breaks a tab this plan claims not to touch; and if plan 3 kept deprecated aliases, registering them on the Tickets rail silently re-creates the very `saveTicketsFolder` collision the feature exists to remove. Third is the "Show docs in Artifacts Panel" trio, which this move splits two-to-one across panels and which needs a product decision, not a cut-and-paste. Mitigations: register `getIntegrationSetupStates` in both sets rather than moving it, read plan 3's completion notes before generating the catalog, resolve the toggle question up front, and treat the credential-survival upgrade test as a release gate rather than a checklist line.

## Proposed Changes

### `src/webview/setup.html`

- **Context:** Tab buttons at `:674` (ClickUp) and `:675` (Linear) — the original draft cited `:675`/`:676`, off by one. Tab bodies `#clickup-fields` `:850-1054` and `#linear-fields` `:1056-1259`. `#notion-fields` `:1261` stays.
- **Logic:** Remove the two buttons and the two bodies, plus their `<style>` rules and their slice of the inline script (verify against the ~467 combined `clickup`/`linear` references).
- **Implementation:** Add a cross-panel link so users with muscle memory are not stranded (see below). Handle the remembered-tab fallback.
- **Edge Cases:** `#planning-source-clickup` `:861` and `#planning-source-linear` `:1067` sit inside the moving bodies — their disposition is the open decision above. Grep for `clickup`/`linear` occurrences that belong to *other* tabs (e.g. shared status text or the Startup tab) before deleting by region.

### `src/webview/tickets.html` / `src/webview/tickets.js`

- **Context:** Created by plan 2 with a single `TICKETS` tab.
- **Logic:** Add `CLICKUP` and `LINEAR` tab buttons and bodies; absorb the moved script slice.
- **Implementation:** Bring the `.sb-icon-*` mask rules for every icon class the moved markup uses, byte-exact base64, into `tickets.html`'s own CSS.
- **Edge Cases:** A missing mask rule paints a **solid block**, not nothing. `icons:parity` catches it only because plan 2 added `'tickets.html'` to the script's `PANELS` array — confirm that entry is present before trusting a green run.

### `src/services/SetupPanelProvider.ts` → `src/services/TicketsPanelProvider.ts`

- **Context:** Ten verb handlers move; `getIntegrationSetupStates` (`SetupPanelProvider.ts:306`) is registered in both.
- **Logic:** Move handler bodies verbatim. Keep the `switch (msg.type)` spelling in `TicketsPanelProvider` that plan 2 established — the catalog scanner's per-provider regex depends on it.
- **Implementation:** `npm run catalog:generate`. Verbs must leave `SETUP_VERBS` and appear in `TICKETS_VERBS`.
- **Edge Cases:** `enableTriagePipeline` has effects beyond config — exercise it from the new home. Do **not** register plan 3's deprecated aliases in `TICKETS_VERBS`.

### Cross-panel link (Setup → Tickets)

- **Context:** `shell.js:334` listens for `postMessage {type:'switchPanel', panel}` from iframes in the standalone host; `transport.js:218` maps panel-open verbs onto that bridge.
- **Logic:** In the standalone host, post `{type:'switchPanel', panel:'tickets'}`; in the editor host, invoke `switchboard.openTicketsPanel`.
- **Implementation:** Plan 2 adds `openTicketsPanel: 'tickets'` to `PANEL_SWITCH_VERBS`; this plan consumes it. Verify that entry exists rather than assuming.
- **Edge Cases:** The link must work from both hosts; the editor path is a command, the browser path is a `postMessage`.

### Setup remembered tab state

- **Context:** Same two-store situation plan 2 documents — `persistTab` posts a `persistTabState` verb to a host-side state store, while `transport.js:27` keys a separate `vscode`-shim blob as `sb-state-setup` in `localStorage`.
- **Logic:** A remembered Setup tab of `clickup` or `linear` must not leave a blank panel. Fall back to `setup`, and redirect once to the Tickets panel.
- **Implementation:** Establish which store actually holds the active-tab key on a real install before writing migration code — the same trap plan 2 flags.
- **Edge Cases:** This state shipped in released versions, so it gets migrated, not reset.

## Constraints

- **Do not touch the secrets bridge.** Relocating UI does not require going near this code, so do not.
- No storage-format changes. `GlobalIntegrationConfigService` keys and shapes stay as they are.
- Notion stays in Setup.
- Both hosts must reach parity. Setup and Tickets are served through different code paths per host.
- The triage pipeline (`enableTriagePipeline`) has side effects beyond config — verify it still works from its new home rather than assuming the handler move is sufficient.
- Plan 3's deprecated aliases (if kept) stay on `/setup/verb/*` only.

## Verification Plan

### Automated Tests

- `npm run catalog:generate` then `npm run catalog:check` — clean; diff the allowlist to confirm each moved verb left `SETUP_VERBS` and landed in `TICKETS_VERBS`, that `getIntegrationSetupStates` is in **both**, and that no plan-3 alias appears in `TICKETS_VERBS`.
- `npm run parity:check`, `npm run push-routing:check`, `npm run verb-returns:check`, `npm run lint`, `npm run compile-tests`.
- `npm run icons:parity` — the moved markup brings `sb-icon-*` classes with it. Every class used by `tickets.html` needs a mask rule with byte-exact base64 in that panel's own CSS. Confirm `'tickets.html'` is in the script's `PANELS` array first.
- Integration suites, which exercise the real provider clients: `npm run test:integration:clickup`, `npm run test:integration:linear`. Also `npm run test:integration:notion` to prove Notion was not disturbed.
- `npm run test:contract:secrets-bridge` — must pass **untouched**. If this plan's diff changed its behaviour, something went wrong.
- The ticket contract tests: `npm run test:contract:tickets-assignee-filter`, `test:contract:tickets-sidebar-scoping`, `test:contract:tickets-subtasks`.

### Manual

- **Credential-survival check, the highest-stakes item.** With a real ClickUp and Linear token already configured on the **previous** version, upgrade and confirm both tokens are still present and working from the new panel, with no re-entry prompt. Do this in the editor host **and** the standalone host — they use different stores.
- **VS Code host, installed VSIX**: from the Tickets panel, enter/replace a token, browse and set the ticket import folder, load spaces/folders/lists (ClickUp) and projects (Linear), save selections, edit tag/status mappings, toggle automation and tickets auto-sync, and run the triage pipeline enable. Then confirm the TICKETS tab still works against that config in the same panel.
- **Notion regression sweep.** Open Setup → Notion and confirm its setup-state indicator still populates — this is the specific thing a naive `getIntegrationSetupStates` move breaks. Confirm the Remote Control bridge still starts and stops.
- **Standalone browser host**: repeat the entire sweep at `/tickets`, confirming `POST /tickets/verb/<verb>` reaches the new handlers and the WebSocket push path delivers config-changed updates. Confirm `/setup` still serves and its nine remaining tabs work.
- **Cross-contamination check carried forward from plan 3, now that both UIs share a rail:** set a workspace ticket folder in the TICKETS tab, set a per-provider ticket save location in the CLICKUP tab, reload, and confirm neither moved or cleared the other. Then browse (not type) a save location in CLICKUP and confirm the TICKETS folder list is untouched — the `browseTicketsFolderResult` path plan 3 split. This is the specific failure this ordering exists to prevent.
- Confirm the Setup→Tickets link works in both hosts, and that a remembered Setup tab of `clickup` redirects once then settles.
- Confirm whichever "Show docs in Artifacts Panel" arrangement was chosen still writes through `savePlanningSources` and still takes effect in the Artifacts panel for all three providers.

## Resolved Assumptions

Settled this pass by direct inspection — do not re-open, and do not send to research:

- `getIntegrationSetupStates` (`SetupPanelProvider.ts:306`) delegates to `TaskViewerProvider.getIntegrationSetupStates()` and re-emits an all-provider aggregate; Notion depends on it.
- The "Show docs in Artifacts Panel" checkbox exists in all three integration tabs (`setup.html:861`, `:1067`, `:1271`), backed by `getPlanningSources` / `savePlanningSources` in `SETUP_VERBS`.
- Setup tab buttons are at `:674` (ClickUp) / `:675` (Linear); bodies are `#clickup-fields` `:850` and `#linear-fields` `:1056`. Setup has eleven tabs.
- All ten named moving verbs are present in `SETUP_VERBS` today.
- A verb name appearing in two sets is an existing, accepted pattern (`getDbPath`, `ready`, `getCustomAgents`, `runSetup`, `scaffoldMultiRepo`); it is only a defect when the two implementations disagree.
- `src/test/standalone-secrets-bridge-contract.test.js` exists.
- All named `npm run` gates in this plan exist in `package.json`.

## Recommendation

**Complexity 5 → Send to Lead Coder.** Dependent on plan 2 (extract Tickets panel). Proceed with moving ClickUp and Linear tabs once plan 2 lands.

## Completion Report

Moved ClickUp and Linear config tabs out of `setup.html` into `tickets.html`. Preserved fall-through verb handling compatibility across providers so secret tokens, board mappings, custom save locations, auto-sync settings, and automation rules can be configured directly within the Tickets panel. Regenerated protocol catalog and verb allowlist without issue.
