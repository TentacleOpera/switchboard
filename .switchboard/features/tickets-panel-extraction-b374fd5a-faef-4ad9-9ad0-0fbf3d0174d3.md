# Tickets Panel Extraction

**Complexity:** 9

> **Superseded:** **Complexity:** 8
> **Reason:** Plan 2 was re-scored 8 → 9 during the improve-feature reconciliation pass. Its registration surface is eight hardcoded lists rather than the three originally named, and three of the omissions fail silently (a missing `wsHub.SURFACES` member drops the panel's whole WebSocket push stream; a missing `check-icon-parity.js` PANELS entry renders the plan's own headline gate inert; a missing `generate-protocol-catalog.js` PROVIDERS entry emits an empty `TICKETS_VERBS`). The feature roll-up follows its largest subtask.
> **Replaced with:** **Complexity:** 9

## Goal

Extract the TICKETS tab out of the Artifacts panel into a dedicated Tickets panel registered in both the VS Code and standalone hosts, and relocate the ClickUp and Linear provider config alongside it. TICKETS is the only Artifacts tab that reads and writes an external system - different job, different failure modes, different rate limits - while its config lives in a third panel entirely, so one job currently spans three panels. The four plans are a deliberate sequence: prepare the shared helpers, cut the panel, de-collide the verb names, then move the config in. They are grouped because plans 3 and 4 are unsafe to land in any other order.

## How the Subtasks Achieve This

- **Lift the helpers Tickets shares with DOCS/HTML out of planning.js into sharedUtils.js**: promotes the generic helpers (escaping, overflow menus, folder picker, `persistTab`, workspace dropdown) that ticket code calls into the module both panels already inject, so the extraction neither forks security-relevant escaping helpers nor drags all 12,982 lines of `planning.js` into the new panel.
- **Extract the TICKETS tab into its own panel, registered in both the VS Code and standalone hosts**: the core cut — new `tickets.html` / `tickets.js` / `TicketsPanelProvider.ts`, plus every standalone registration point (manifest, verb rail, nav icon, catalog set, push-routing baseline) and the one-time remembered-tab migration for the ~4,000 installs that have `tickets` as their saved Artifacts tab.
- **De-collide the three tickets-folder verbs that Planning and Setup both define with different meanings**: renames Setup's `saveTicketsFolder` / `browseTicketsFolder` / `listTicketsFolders` to provider-scoped names and splits the shared `ticketsFoldersListed` response type. Today the panel boundary is the only thing keeping a workspace-scoped array and a machine-global per-provider string from overwriting each other.
- **Move the ClickUp and Linear config tabs out of Setup and into the Tickets panel**: relocates Setup's two largest tabs (206 and 205 markup lines) as `CLICKUP` / `LINEAR` siblings of `TICKETS`, removing the one-job-two-panels split. Notion deliberately stays in Setup — it is the Remote Control bridge, not a ticket provider.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Lift the helpers Tickets shares with DOCS/HTML out of planning.js into sharedUtils.js](../plans/tickets-panel-1-lift-shared-webview-helpers-into-sharedutils.md) — **LEAD CODED**
- [ ] [Extract the TICKETS tab into its own panel, registered in both the VS Code and standalone hosts](../plans/tickets-panel-2-extract-tickets-tab-into-standalone-panel.md) — **LEAD CODED**
- [ ] [De-collide the three tickets-folder verbs that Planning and Setup both define with different meanings](../plans/tickets-panel-3-decollide-duplicate-tickets-folder-verbs.md) — **LEAD CODED**
- [ ] [Move the ClickUp and Linear config tabs out of Setup and into the Tickets panel](../plans/tickets-panel-4-move-clickup-and-linear-config-out-of-setup.md) — **LEAD CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

> **Superseded:** "**Strict serial order: 1 → 2 → 3 → 4. No parallelism is available in this feature.**"
> **Reason:** Two facts verified during the improve-feature reconciliation pass contradict it. (a) Plans 1 and 3 share no file — plan 1 touches `sharedUtils.js` / `planning.js` / `design.js`, plan 3 touches `SetupPanelProvider.ts` / `setup.html` / response-`type` strings in `PlanningPanelProvider.ts` — so they are genuinely parallel. (b) Under the old order plan 2 had to carve out three verbs it otherwise owns and a later pass had to return for them; landing plan 3 first deletes that carve-out entirely.
> **Replaced with:** **{1, 3} in parallel → 2 → 4.** Plan 3 moves from third to first-wave.

**Execution order: plans 1 and 3 may be worked in parallel; then plan 2; then plan 4.**

- **Plan 1 before plan 2.** Without the shared-helper lift, plan 2 must either duplicate the escaping / overflow-menu / folder-picker helpers into `tickets.js` (two divergent copies of security-relevant escaping) or import `planning.js` wholesale into the new panel, which defeats the extraction entirely. Plan 1 also records its shared / ticket-only / tab-specific classification in its completion notes so plan 2 does not re-derive it — that classification is now **resolved** (comment helpers and mention autocomplete are ticket-only; zero `design.js` references).
- **Plan 3 before plan 2 — recommended, not strictly required.** The three colliding verbs have **zero** `planning.js` callers (verified: `planning.js` drives its folder UI through `addTicketsFolder:9531`, `removeTicketsFolder:3707` and `saveTicketsFolderPaths`, and only *listens* for `ticketsFoldersListed:6026`). They are API-only on the Planning side. Landing plan 3 first lets plan 2 move the entire ticket verb surface in one cut instead of carving three verbs out and returning later.
- **Plan 2 before plan 4.** The Tickets panel must exist before the ClickUp and Linear tabs can be moved into it.
- **Plan 3 before plan 4 — load-bearing, not optional.** `saveTicketsFolder`, `browseTicketsFolder` and `listTicketsFolders` exist in both `PLANNING_VERBS` and `SETUP_VERBS` with different meanings, different stores, different scopes, and **two** shared response `type`s carrying incompatible payloads — `ticketsFoldersListed` **and** `browseTicketsFolderResult` (the second one was missed in the original analysis and is the more dangerous, because `setup.html:4632-4645` reacts to it by immediately posting a save). They are isolated today only because `transport.js:25-26` namespaces the verb rail per panel. Plan 4 puts both UIs on `/tickets/verb/*` and one `window` message stream, where they silently overwrite each other's config — a data-shaped failure, not a visible crash.
- **Plans 3 and 4 must not be worked concurrently** — both edit `SetupPanelProvider.ts` and `setup.html`.

**Review gates.** All four subtasks have now been plan-reviewed (improve-feature pass). Complexities after review: plan 1 → 5, plan 2 → 9, plan 3 → 5, plan 4 → 6. Open decisions the user must settle before dispatch are listed in each plan's `## User Review Required`; the cross-cutting ones are plan 3's deprecated-alias choice (and the corollary that any alias must stay off the Tickets rail, or plan 4 silently re-creates the collision), plan 1's two escaping decisions, and plan 4's "Show docs in Artifacts Panel" toggle placement.

## Reconciled Shared Surfaces (improve-feature pass)

No subtask was merged, deleted or split — the four are genuinely distinct units with a clean dependency chain. The restructuring action taken was **reorder**, plus these single reconciled end-states for every symbol more than one subtask touches:

| Shared surface | Subtasks | Reconciled end-state |
|---|---|---|
| `src/webview/planning.js` | 1, 2 | Plan 1 removes shared helpers; plan 2 removes the ~4,600 ticket lines. Sequential — plan 2's cut shifts every line number, so never concurrent. |
| `escapeHtml` | 1, 2 | Exactly one body survives, promoted to `sharedUtils.js` by plan 1 (decision D1). `tickets.js` must **not** re-declare it — a local declaration inside its IIFE shadows the shared global and re-opens the divergence plan 1 exists to close. |
| Comment + mention helpers | 1, 2 | Classified **ticket-only** (verified: zero `design.js` references). Plan 1 leaves them; plan 2 takes them into `tickets.js`. No longer an open question. |
| `saveTicketsFolder` / `browseTicketsFolder` / `listTicketsFolders` | 2, 3, 4 | Plan 3 renames the **Setup** side to `*IntegrationTicketSaveLocation*` on semantic grounds (Setup's names are the misnomer — they set one per-provider save location, not a folder list). Planning keeps the names. With plan 3 merged first, plan 2 may move the Planning copies to `TicketsPanelProvider` with the rest of the ticket surface. |
| `ticketsFoldersListed`, `browseTicketsFolderResult` | 3, 4 | Both split by plan 3 — Setup emits `integrationTicketSaveLocations` and `integrationTicketSaveLocationBrowsed`; Planning keeps the original names. Plan 4 inherits the split and must not reintroduce either name on the Tickets rail. |
| `getIntegrationSetupStates` | 4 | **Registered in both `SETUP_VERBS` and `TICKETS_VERBS`**, not moved. It is a three-provider aggregate that Notion — which stays in Setup — still consumes. |
| `TICKETS_VERBS` / the generated allowlist | 2, 3, 4 | Plan 2 creates the set; plan 3 must land its rename before either 2 or 4 populates it; plan 4 adds the config verbs. Plan 3's deprecated aliases (if kept) stay on `/setup/verb/*` only. |
| `tickets.html` / `tickets.js` / `TicketsPanelProvider.ts` | 2, 4 | Plan 2 creates with one tab; plan 4 extends to three. Sequential by construction. |
| Remembered-tab migration | 2, 4 | Same two-store problem in both (`persistTab` posts a `persistTabState` verb to a host-side store; `sb-state-<panel>` in `localStorage` is `transport.js:27`'s separate `vscode`-shim blob). Plan 2 establishes which store actually holds the key; plan 4 reuses that finding for Setup. |
| Secrets bridge | 4 only | Untouched by every subtask. Any diff reaching it is a defect. |

**Do not touch the secrets bridge.** Tokens are addressed by secret name, never by panel, so relocating this UI requires no storage change and no re-auth for the install base. `standalone-secrets-bridge-contract.test.js` documents three past bugs where plausible-looking changes destroyed a standalone user's only copy of their tokens. Any diff in plan 4 that touches the secrets path is a mistake.
