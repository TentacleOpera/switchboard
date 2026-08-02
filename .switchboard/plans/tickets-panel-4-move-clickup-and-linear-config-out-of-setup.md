# Move the ClickUp and Linear config tabs out of Setup and into the Tickets panel

## Goal

Relocate the ClickUp and Linear configuration tabs from the Setup panel into the Tickets panel as sibling tabs (`TICKETS` / `CLICKUP` / `LINEAR`), so provider config lives next to the thing it configures. This removes Setup's two largest tabs and collapses a one-job-two-panels split.

### Problem and background

Setup has eleven tabs. ClickUp and Linear are the two largest by a factor of two:

| Tab | Markup lines | | Tab | Markup lines |
|---|---|---|---|---|
| **ClickUp** (`setup.html:851`) | **206** | | Startup/Setup | 105 |
| **Linear** (`setup.html:1057`) | **205** | | Status Bar | 70 |
| Theme | 60 | | Plan Scanner | 59 |
| Notion (`:1262`) | 37 | | Multi-Repo | 27 |
| Database | 22 | | Control Plane | 13 |

They also account for the bulk of `setup.html`'s inline script — 223 `clickup` and 244 `linear` references, against only 16 and 23 in `SetupPanelProvider.ts`, so nearly all of it is webview-side.

Size is the lesser problem. The real one: **ClickUp and Linear are the only Setup tabs that configure something used in a different panel.** Today you set the ClickUp token, ticket import folder, space/list/folder selection and triage pipeline in the **Setup** panel, then use tickets in the **Artifacts** panel — one job, two panels, and neither of them is the ticket panel. Setup's other nine tabs configure the extension itself (database, theme, status bar, control plane, plan scanner, multi-repo, remote).

### Root cause

Setup accreted a tab per integration because "it is configuration, so it goes in Setup". That groups by *kind of thing* rather than *job being done*. The ticket-provider config is the one case where the distinction bites, because the configured feature has a home of its own.

### What moves and what does not

**Moves:** the ClickUp tab and the Linear tab, and their `SETUP_VERBS` entries — `applyClickUpConfig`, `applyLinearConfig`, `saveClickUpAutomation`, `saveClickUpMappings`, `saveLinearAutomation`, `enableTriagePipeline`, `linearBrowseProjects`, `copyLinearAgentSkill`, `saveTicketsAutoSync`, `getIntegrationSetupStates`, plus the renamed tickets-folder trio from plan 3.

**Does not move — Notion stays in Setup.** It is the Remote Control bridge, not a ticket provider (37 lines). Moving it would be grouping by "is an integration" — the same mistake that created this problem.

Config goes in as **sibling tabs, not behind a gear icon.** ClickUp/Linear setup here is not one-and-done: there is token entry, import-folder selection, space/folder/list selection, tag and status mapping, automation settings and the triage pipeline toggle. Users return to it.

## Dependencies

- **Plan 2** must land first — the Tickets panel must exist.
- **Plan 3 must land first, and is not optional.** `saveTicketsFolder`, `browseTicketsFolder` and `listTicketsFolders` exist in both `PLANNING_VERBS` and `SETUP_VERBS` with different meanings, different stores, different scopes, and a **shared response `type`** (`ticketsFoldersListed`) carrying incompatible payloads. They are currently isolated only because `transport.js` namespaces the rail per panel. Landing this plan first would put both UIs on `/tickets/verb/*` and one `window` message stream, where they silently overwrite each other's config. Do not start this plan until plan 3's rename is merged.

## Approach

1. Move the two tab bodies from `setup.html` into `tickets.html`, plus their `<style>` rules and their slice of the inline script (which is most of it — verify against the ~467 combined references).
2. Add the `CLICKUP` and `LINEAR` tab buttons to the Tickets panel tab bar; drop them from Setup's bar at `setup.html:675`/`:676`.
3. Move the corresponding verb handlers from `SetupPanelProvider.ts` to `TicketsPanelProvider.ts`. Regenerate: `npm run catalog:generate` — the verbs must leave `SETUP_VERBS` and appear in `TICKETS_VERBS`.
4. **Leave credential storage completely alone.** Tokens live in VS Code `secretStorage` (editor host) and the machine-global encrypted store (standalone), keyed by name — `switchboard.clickup.apiToken`, `switchboard.linear.apiToken`. They are addressed by key, never by panel, so relocating the UI touches no storage and requires no re-auth for the install base. Any diff that touches the secrets path in this plan is a mistake.
5. Add a cross-panel link from Setup to the moved tabs so users with muscle memory are not stranded. `shell.js` already listens for `postMessage {type:'switchPanel', panel}` from iframes in the standalone host; use it, and use the panel-open command in the editor host.
6. Handle Setup's remembered tab state the same way plan 2 handles Artifacts': a remembered Setup tab of `clickup` or `linear` must not leave a blank panel. Fall back to `setup`, and redirect once to the Tickets panel. This state shipped in released versions, so it gets migrated, not reset.

## Constraints

- **Do not touch the secrets bridge.** `standalone-secrets-bridge-contract.test.js` documents three past bugs where plausible-looking changes silently destroyed a standalone user's only copy of their tokens — an un-awaited migration loop, an activation sweep that deleted mirrored keys, and a decrypt-failure rename that one passphrase-less process could trigger. The store is the *only* copy in standalone; there is no keychain behind it. Relocating UI does not require going near this code, so do not.
- No storage-format changes. `GlobalIntegrationConfigService` keys and shapes stay as they are.
- Notion stays in Setup.
- Both hosts must reach parity. Setup and Tickets are served through different code paths per host.
- The triage pipeline (`enableTriagePipeline`) has side effects beyond config — verify it still works from its new home rather than assuming the handler move is sufficient.

## Verification Plan

- `npm run catalog:generate` then `npm run catalog:check` — clean; diff the allowlist to confirm each moved verb left `SETUP_VERBS` and landed in `TICKETS_VERBS`, with no name in both.
- `npm run parity:check`, `npm run push-routing:check`, `npm run verb-returns:check`, `npm run lint`, `npm run compile-tests`.
- `npm run icons:parity` — the moved markup brings `sb-icon-*` classes with it. Every class used by `tickets.html` needs a mask rule with byte-exact base64 in that panel's own CSS; a missing rule paints a **solid block** rather than nothing. Confirm Setup's now-unused rules are handled consistently with how the repo treats them elsewhere.
- Integration suites, which exercise the real provider clients: `npm run test:integration:clickup`, `npm run test:integration:linear`. Also `npm run test:integration:notion` to prove Notion was not disturbed.
- `npm run test:contract:secrets-bridge` — must pass untouched. If this plan's diff changed its behaviour, something went wrong.
- The ticket contract tests: `test:contract:tickets-assignee-filter`, `test:contract:tickets-sidebar-scoping`, `test:contract:tickets-subtasks`.
- **Credential-survival check, the highest-stakes item.** With a real ClickUp and Linear token already configured on the **previous** version, upgrade and confirm both tokens are still present and working from the new panel, with no re-entry prompt. Do this in the editor host **and** the standalone host — they use different stores.
- **VS Code host, installed VSIX**: from the Tickets panel, enter/replace a token, browse and set the ticket import folder, load spaces/folders/lists (ClickUp) and projects (Linear), save selections, edit tag/status mappings, toggle automation and tickets auto-sync, and run the triage pipeline enable. Then confirm the TICKETS tab still works against that config in the same panel.
- **Standalone browser host**: repeat the entire sweep at `/tickets`, confirming `POST /tickets/verb/<verb>` reaches the new handlers and the WebSocket push path delivers config-changed updates. Confirm `/setup` still serves and its nine remaining tabs work.
- Cross-contamination check carried forward from plan 3, now that both UIs share a rail: set a workspace ticket folder in the TICKETS tab, set a per-provider ticket save location in the CLICKUP tab, reload, and confirm neither moved or cleared the other. This is the specific failure this ordering exists to prevent.
- Confirm the Setup→Tickets link works in both hosts, and that a remembered Setup tab of `clickup` redirects once then settles.

## Metadata

**Complexity:** 6
**Tags:** refactor, frontend, ui, backend
