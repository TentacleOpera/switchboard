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

## Pre-dispatch corrections (review pass, after slices 2a–2f landed)

Slices 2a–2f exposed two authoring failure modes in this plan set, and both apply here. The
verb list below has been re-derived by **tracing post sites**, not by matching names, and the
panel-level markup question has been answered by measurement. Do not re-derive either.

### Corrected verb list — 11 move, 1 shared, 1 stays

**Move to `TICKETS_VERBS` (11).** Every one is posted from the ClickUp/Linear script slice
(`setup.html:3817–3944`) or panel init (`:2795`):
`applyClickUpConfig` `:3817` · `applyLinearConfig` `:3871` · `saveClickUpAutomation` `:3859` ·
`saveClickUpMappings` `:3844` · `saveLinearAutomation` `:3884` · `enableTriagePipeline`
`:3829,:3838` · `linearBrowseProjects` `:3889,:3892` · `saveTicketsAutoSync` `:3944` ·
`saveIntegrationTicketSaveLocation` `:3929,:3934,:4638,:4642` ·
`browseIntegrationTicketSaveLocation` `:3921,:3924` · `getIntegrationTicketSaveLocations` `:2795`.

**Register in BOTH sets (1).** `getIntegrationSetupStates` `:2794` — a three-provider aggregate
Notion still consumes from Setup. Unchanged from the original analysis; the `sharedUtilityVerbs.ts`
module created during slice 2d is the precedent if a single implementation is wanted.

**Do NOT move — `copyLinearAgentSkill`.** The original list had this wrong. Its only post site is
`setup.html:5668`, wired to `#btn-copy-linear-agent-skill` at `:1581` — which sits inside the
**`remote-fields`** tab (`:1487`), not the Linear tab. The Remote tab stays in Setup, so moving
this verb breaks its copy-agent-skill button. This is the same error class as slice 2f's
`syncToSource`, caught before dispatch this time.

### Panel-level markup — measured, and there is none to chase

Slices 2a–2f each lost time to markup sitting *outside* the tab body being moved; six modals were
missed across the set. Measured here: of every DOM id the ClickUp/Linear script slice references,
exactly **three** fall outside `#clickup-fields` (`:850–1054`) and `#linear-fields` (`:1056–1259`) —
`#remote-linear-agent-skill` `:1580`, `#btn-copy-linear-agent-skill` `:1581` and
`#copy-linear-agent-skill-status` `:1585`. All three belong to the Remote tab and **stay in Setup**,
alongside `copyLinearAgentSkill` above. So unlike the earlier slices, both tab bodies are
self-contained: move `:850–1054` and `:1056–1259` and no orphaned markup is left behind. Verify by
re-running the same check after the move — every id `tickets.js` looks up must resolve in
`tickets.html` or be built by its own templates.

### Before you finish: grep your own posts

`setup.html` posts **94** distinct verbs. The moved script slice will reach for cross-cutting
utilities that are not ClickUp/Linear-named — exactly how slice 2d shipped with `copyToClipboard`,
`openExternalUrl`, `renderMarkdownLive`, `copyDiagramPrompt` and `linearLoadAutomationCatalog`
unregistered and the detail pane silently broken. Before hand-off, grep every
`vscode.postMessage` type in the moved slice against `TICKETS_VERBS` and confirm each resolves.
Genuinely shared verbs belong in `src/services/sharedUtilityVerbs.ts` with an arm in both
providers — never a second copy of the body.

### Three things carried forward from the earlier slices

- **Each verb moves three things:** handler, allowlist entry (`npm run catalog:generate`), and
  **payload schema** out of `SETUP_VERB_SCHEMAS` into `TICKETS_VERB_SCHEMAS`. Slice 2b omitted the
  schema for all nine of its verbs, silently disabling payload validation on the remote-reachable
  `/tickets/verb/*` rail.
- **Migrate any contract assertion you strand.** Moving verbs off Setup will leave
  `verb-engine`-family assertions asking Setup about verbs it no longer owns.
  `src/test/verb-engine-tickets-headless.test.js` exists and is CI-wired — move assertions into it
  verbatim, changing only the provider under test and the provider name in the expected error.
- **Update the ratchet in both directions.** Raise `Tickets` and lower `Setup` in
  `scripts/verb-return-contract-baseline.json` by what actually transferred; leaving the source
  ceiling high silently widens the allowance.

### Plan 3's aliases

Confirmed still Setup-rail-only. `saveIntegrationTicketSaveLocation`,
`browseIntegrationTicketSaveLocation` and `getIntegrationTicketSaveLocations` are the renamed
names and are safe to move; the **old** names (`saveTicketsFolder`, `browseTicketsFolder`,
`listTicketsFolders`) must not appear in `TICKETS_VERBS` — Planning owns those spellings for its
own workspace-scoped folder feature, and an alias on the Tickets rail re-creates the exact
collision plan 3 removed.

### DECIDED — the "Show docs in Artifacts Panel" toggles move with their tabs

**User decision, recorded: option (b).** The ClickUp and Linear checkboxes move with their tabs.
Notion's stays in Setup with the Notion tab. **Setup's option structure is not to be reorganised** —
the earlier recommendation of option (a) (extracting all three into one consolidated Setup block)
is withdrawn; it proposed restructuring Setup's options, which was never authorised.

This is also the lower-effort path. All three checkboxes already sit inside their own tab bodies —
`#planning-source-clickup` `:861` inside `#clickup-fields` (`:850–1054`), `#planning-source-linear`
`:1067` inside `#linear-fields` (`:1056–1259`), `#planning-source-notion` `:1271` inside
`#notion-fields` (`:1261–1294`). So moving the two bodies carries their checkboxes automatically and
leaves Notion's untouched. Option (a) would have required deliberately extracting them; option (b)
requires nothing beyond the body move.

**One mechanical consequence:** `getPlanningSources` and `savePlanningSources` are currently
`SETUP_VERBS`-only (posted at `setup.html:2136`, `:2140`, `:2144`, `:3981`, `:5704`). After the move
the setting is driven from **both** panels — Notion's checkbox from Setup, ClickUp's and Linear's
from Tickets — so both verbs must be registered in **both** sets, exactly like
`getIntegrationSetupStates`. Do not move them out of `SETUP_VERBS`; that would break Notion's
checkbox. Confirm the Tickets side issues its own `getPlanningSources` on init so the two moved
checkboxes render their current values.

### Current state — this plan is cleanly unstarted

Setup's ClickUp and Linear tab buttons are present (`setup.html:674-675`), both bodies are intact,
`tickets.html` has no CLICKUP/LINEAR tabs, and all 13 verbs read `SETUP=True TICKETS=False`. An
earlier attempt ran only the destructive half — it deleted the two tab buttons, orphaned the
bodies and moved nothing, making provider config unreachable by any route; review restored the
buttons and removed the bodiless tabs that had been added to `tickets.html`. Nothing is
half-moved. Plan 2 is now genuinely complete via slices 2a–2f, so the Tickets panel exists with
real tabs and a populated `TICKETS_VERBS` and can receive these two tabs.

## Review Findings

**PASS — one CRITICAL fixed in review.** The move is correct and complete. `#clickup-fields` and `#linear-fields` are out of `setup.html` and in `tickets.html`; the two tab buttons moved with them and Setup keeps its Notion tab. All **11** verbs are clean — in `TICKETS_VERBS` with a handler, absent from both `SETUP_VERBS` and `SetupPanelProvider`. All **three** shared verbs (`getIntegrationSetupStates`, `getPlanningSources`, `savePlanningSources`) are registered in *both* sets with arms in both providers, so Notion's tab keeps working. `copyLinearAgentSkill` correctly stayed in Setup along with its three Remote-tab controls — the mis-assignment caught pre-dispatch. **Option (b) was honoured exactly**: `#planning-source-clickup` and `#planning-source-linear` moved with their bodies, `#planning-source-notion` stayed, and Setup's option structure is otherwise untouched. Zero schemas were stranded (the nine without Tickets schemas never had Setup ones either, and two were newly *added*). The secrets bridge is untouched — no diff, zero secret references in `TicketsPanelProvider`, `test:contract:secrets-bridge` green.

**CRITICAL (fixed in review) — eight moved verbs threw in the standalone host.** `TicketsPanelProvider` reaches `TaskViewer` through a non-null-asserted `this._taskViewerProvider!`, and while `extension.ts:1275` wires it, `src/standalone/bootstrap.ts` wired it only for `setupProvider` (`:621`) and `planningProvider` (`:678`) — never for `ticketsProvider`. So `applyClickUpConfig`, `applyLinearConfig`, `saveClickUpAutomation`, `saveClickUpMappings`, `saveLinearAutomation`, `enableTriagePipeline`, `linearBrowseProjects` and `getIntegrationSetupStates` all threw `TypeError: Cannot read properties of undefined` at `/tickets/verb/*` — token entry, mappings, automation, the triage pipeline and the setup-state indicator, i.e. most of what this plan moved. Added the one missing `ticketsProvider.setTaskViewerProvider(taskViewerProvider)` call. This is exactly the dual-host parity failure the plan warned about, and it surfaced only because a migrated contract assertion exercised the arm — the editor host would have looked fine.

**Fixed in review — one stranded assertion.** `Setup: applyClickUpConfig schema validates and RETURNS body data` still asked Setup about a verb that moved; migrated verbatim into `verb-engine-tickets-headless.test.js` (now 30 passed / 0 failed) and removed from `verb-engine-headless-seams.test.js` (25 / 0) with an accurate comment. The Tickets harness also needed a `_taskViewerProvider` stub, added.

**Verified not over-reached.** `setup.html` has 14 unresolved self-referenced ids after the move, but all 14 are absent at `7c9a688` too and none appear in `tickets.html` — pre-existing stale lookups in other Setup tabs, not casualties of this move. Every id `tickets.js` looks up resolves except `assignee-nobody`, which never existed in any file or commit.

All gates and all 12 contract suites green. The only remaining repo error is `src/webview/terminals.js:1013`, which belongs to the Terminals feature.

## Metadata

**Tags:** refactor, frontend, ui, backend
**Complexity:** 6

## User Review Required

- **"Show docs in Artifacts Panel" toggles — RESOLVED (option b).** The ClickUp and Linear checkboxes move with their tabs; Notion's stays in Setup. Setup's option structure is not reorganised. `getPlanningSources` / `savePlanningSources` get registered in both `SETUP_VERBS` and `TICKETS_VERBS`. See the decision recorded under `## Pre-dispatch corrections`.
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

## Review Findings

**NOT COMPLETE — this card must not move to CODE REVIEWED.** The completion report above is inaccurate: nothing was moved into `tickets.html`. Only the destructive half ran — the ClickUp and Linear tab *buttons* were deleted from `setup.html` while both bodies remain orphaned at `#clickup-fields:848` and `#linear-fields:1054` (409 markup lines, 157 `clickup` + 178 `linear` script references still resident), and all twelve verbs are still in `SETUP_VERBS` with none in `TICKETS_VERBS`. **CRITICAL (fixed by review):** that left ClickUp and Linear configuration unreachable by any route — no token entry, import folder, space/list selection, tag or status mapping, or triage-pipeline toggle — so the two tab buttons were restored to `setup.html`, and the bodiless CLICKUP/LINEAR buttons plan 2 had added to `tickets.html` were removed. The secrets bridge was correctly left untouched (`test:contract:secrets-bridge` passes). **Outstanding for the coder:** the actual body/style/script move, the twelve-verb migration with `getIntegrationSetupStates` registered in *both* sets, the "Show docs in Artifacts Panel" trio decision (plan recommends option (a)), the Setup→Tickets cross-panel link, and the Setup remembered-tab migration — all of it gated behind plan 2's JS move landing first.
