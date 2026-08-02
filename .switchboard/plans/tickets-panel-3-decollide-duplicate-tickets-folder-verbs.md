# De-collide the three tickets-folder verbs that Planning and Setup both define with different meanings

## Goal

Give the Setup panel's tickets-folder verbs provider-scoped names distinct from the Planning panel's identically-named verbs, and stop the two from sharing a response `type`. This removes a latent collision that becomes an active bug the moment both UIs share one panel (plan 4).

**This plan ships on its own and moves no UI.** It is a rename plus a message-shape disambiguation.

### Problem and background

Three verbs exist twice in the codebase under the same name, and the two copies are not duplicates — they are different features that happen to share a spelling:

| | `PlanningPanelProvider.ts` (`:2913`, `:2931`, `:2946`) | `SetupPanelProvider.ts` (`:1301`, `:1318`, `:1338`) |
|---|---|---|
| writes | `config.ticketsFolderPaths` — an **array** | `config.ticketSaveLocation` — a **string** |
| via | `LocalFolderService` | `GlobalIntegrationConfigService` |
| scope | **workspace** | **machine-global, per provider** (`clickup` / `linear`) |
| emits | `ticketsFoldersListed { paths[], workspaceRoot }` | `ticketsFoldersListed { provider, path, ticketsAutoSync }` |

The colliding names are `saveTicketsFolder`, `browseTicketsFolder`, and `listTicketsFolders`. All three appear in **both** `PLANNING_VERBS` and `SETUP_VERBS` in `src/generated/verbAllowlist.ts`. Note they also emit the **same response `type`** (`ticketsFoldersListed`) with incompatible payload shapes.

### Root cause

The verb rail is namespaced per panel. `transport.js` derives its route prefix from `document.body.dataset.panel`, so the Planning UI posts to `/planning/verb/*` and the Setup UI to `/setup/verb/*`, and each provider's allowlist gates its own set. That namespacing is the *only* thing keeping these apart. It was never a deliberate design decision that two different features could share a verb name — it is an accident that the panel boundary happened to hide.

Plan 4 moves the ClickUp and Linear config UIs into the Tickets panel. At that point both UIs post to `/tickets/verb/*` and both listen on the same `window` message stream:

- `saveTicketsFolder` becomes ambiguous — one payload carries `folderPath` + `provider`, the other carries `folderPath` alone and means a workspace array. Whichever handler is registered wins, and the other feature silently writes to the wrong store.
- Both listeners receive every `ticketsFoldersListed` message. The ticket browser's folder list gets clobbered by the config tab's per-provider message and vice versa.

This is silent and data-shaped rather than a visible crash, and it hits the standalone host hardest because there the rail is literally one HTTP namespace with one allowlist.

## Approach

1. **Rename the Setup-side trio** to provider-scoped names that say what they do. Suggested — match the surrounding `SETUP_VERBS` naming, which already uses provider prefixes (`applyClickUpConfig`, `saveClickUpMappings`, `linearBrowseProjects`):
   - `saveTicketsFolder` → `saveIntegrationTicketSaveLocation`
   - `browseTicketsFolder` → `browseIntegrationTicketSaveLocation`
   - `listTicketsFolders` → `getIntegrationTicketSaveLocations`

   The Planning trio keeps its current names — it is the older, workspace-scoped meaning and has more call sites.

2. **Split the response `type`.** Setup's emissions become a distinct type (e.g. `integrationTicketSaveLocations`) carrying `{ provider, path, ticketsAutoSync }`. Planning keeps `ticketsFoldersListed` with `{ paths[], workspaceRoot }`. After this, no listener can receive a message shaped for the other feature.

3. Update the Setup-side call sites in `setup.html`'s inline script and every listener keyed on the old type.

4. Regenerate the allowlist: `npm run catalog:generate`, then confirm `catalog:check` is clean and that `SETUP_VERBS` no longer shares these three names with `PLANNING_VERBS`.

5. Audit for other collisions while here. Several verbs legitimately appear in more than one set because separate providers each own a real implementation (`clickupLoadSpaces`, `linearLoadProject`, `clickupImportTask` in both `PLANNING_VERBS` and `TASKVIEWER_VERBS`). Those are fine — the question is not "is the name duplicated" but "would the two implementations disagree if they landed on one rail". Check specifically for pairs that write different stores or emit a shared `type` with different payloads, and report anything found even if it is out of scope to fix here.

## Constraints

- **No storage-format changes.** `config.ticketsFolderPaths` stays an array; `config.ticketSaveLocation` stays a string. This plan renames the wire contract, not the data. Both formats shipped in released versions, so neither may be rewritten here.
- **No user-visible behaviour change.** Both features must work exactly as before, in both hosts, from their current panels.
- Do not "unify" the two features into one. They are genuinely different — workspace-scoped multi-folder browsing versus machine-global per-provider save location. Merging them is a product decision nobody has made.
- External API callers may be posting the old Setup verb names to `/setup/verb/*`. The verb rail is a documented surface (`GET /catalog`). Decide explicitly whether to keep the old Setup names as thin deprecated aliases for a release or to break them, and state the choice in the completion notes. Aliases are cheap here and this is a published extension.

## Verification Plan

- `npm run catalog:generate` then `npm run catalog:check` — clean, and diff `src/generated/verbAllowlist.ts` to confirm the three names now appear in exactly one set each.
- `npm run parity:check`, `npm run verb-returns:check` — the latter guards verb return shapes and is the gate most likely to catch a half-finished rename.
- `npm run lint`, `npm run compile-tests`.
- `npm run test:contract:verb-engine-planning` and `test:contract:verb-engine`, `test:contract:verb-engine-kanban`.
- **VS Code host, installed VSIX** — Artifacts panel: add, browse, remove and list local ticket folders; confirm the workspace-scoped array still persists and reloads. Setup panel, ClickUp and Linear tabs: set and browse the per-provider ticket save location, toggle tickets auto-sync; confirm the machine-global config still persists and reloads.
- **Standalone browser host** — repeat both sweeps against `/planning` and `/setup`, confirming `POST /planning/verb/saveTicketsFolder` and `POST /setup/verb/saveIntegrationTicketSaveLocation` each hit exactly one handler and 404/reject the other's name.
- Cross-contamination check, the point of the whole plan: set a workspace ticket folder in Artifacts, then set a ClickUp ticket save location in Setup, then reload both. Neither value may have moved or cleared the other.
- If deprecated aliases are kept, confirm the old Setup names still resolve and are marked deprecated in `GET /catalog`.

## Metadata

**Complexity:** 5
**Tags:** bugfix, backend, api, refactor
