# Standing Orders Library and Tab

**Complexity:** 6

## Goal

Split standing orders into a reusable definitions library with a live link (edit once, update all assignments), then add a dedicated Standing Orders tab to the Agent Control panel with library management and scope-based assignment UI for global, role, team, and team-head scopes. Pair scope is excluded — it is session-scoped, not durable configuration.

## How the Subtasks Achieve This

- **Standing Orders Library: Definitions and Sync**: Splits the standing orders data model into reusable definitions (library entries) and assignments (scope-targeted links to definitions). Adds a sync operation so editing a definition updates every assignment referencing it. Migrates existing orders into definitions + assignments lazily on first read, with deduplication by instruction text. Updates `wireSpawnedTeam` to create definitions + assignments instead of baking instruction text into order rows. Adds definition CRUD to the standing orders API. The delivery path (`selectOrders` / `renderOrder`) is unchanged — it reads the `instruction` copy on the assignment row, which is kept in sync. Old builds see the `instruction` field and work as before.
- **Standing Orders Tab in the Agent Control Panel**: Adds the UI surface — a fourth tab in the Agent Control panel with two sections: a library of definitions (create, edit, delete) and an assignments view (assign definitions to global, role, team, team-head scopes). Uses kanban verbs to proxy through the CSP `connect-src 'none'` constraint. Editing a definition in the library updates all assignments via the sync operation from the data model plan. The `pair` scope is excluded — pair orders are ephemeral session link-ups, not durable configuration. Coexists with the existing team cockpit editor and Link-up modal.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Standing Orders Tab in the Agent Control Panel](../plans/standing-orders-tab-in-agent-control.md) — **CODE REVIEWED** — ID: 1446d899-5abf-401b-9a8a-1a89aca4325a
- [ ] [Standing Orders Library: Definitions and Sync](../plans/standing-orders-library-definitions-and-sync.md) — **CODE REVIEWED** — ID: 9d9159bd-b550-4923-b5be-4edfac058fa5
<!-- END SUBTASKS -->

## Dependencies & sequencing

The data model plan (Standing Orders Library: Definitions and Sync) must land first — the tab UI depends on the definitions table, `definitionId` field, `syncDefinitionToAssignments`, and the definition CRUD API. The tab plan (Standing Orders Tab in the Agent Control Panel) can be coded in parallel once the API contract is agreed, but cannot be tested end-to-end until the data model is in place.

## Review Findings

Both subtasks reviewed in dependency order (data model, then tab) with one combined verification pass. Three CRITICALs fixed: assignment edits silently reverted by the lazy re-sync on the next prompt dispatch (both update writers now detach `definitionId`); the tab's four kanban verbs resolved the board's active workspace instead of the latched fleet root, so they read and wrote a DB the delivery chokepoints do not (added `getFleetOrdersRoot()`/`_resolveStandingOrdersRoot()`, pinned in the fleet-root contract); and every row button used inline `onclick=`, which the kanban webview's nonce-only CSP blocks — EDIT/DELETE/SAVE/CANCEL did nothing (now `data-so-action` + a delegated listener). Four MAJORs fixed: the new contract test imported its config key from a module that does not re-export it, so 6 of 9 tests failed and 2 passed vacuously; that test was in `package.json` but wired into no CI step; the team/role selectors populated before their data arrived; and each verb both postMessaged and returned a typed body, double-dispatching in the browser. Files changed: `src/services/{KanbanProvider,LocalApiServer,TaskViewerProvider}.ts`, `src/webview/kanban.html`, `src/test/standing-orders-{definitions,fleet-root}-contract.test.js`, `.github/workflows/integration-tests.yml`, `protocol-catalog.json`. **Remaining gap — the feature is not fully delivered:** this feature file specifies the tab carries "a library of definitions (create, edit, delete)" alongside the assignments view, but the subtask plan for the tab never specified one and none was built. The definition CRUD (`addDefinition`/`updateDefinition`/`deleteDefinition`/`listDefinitions`) exists only on the HTTP API with no kanban verbs proxying it, so the headline promise — edit a definition once, update every assignment — has no operator-reachable surface. That is a follow-up subtask, not a review fix.
