# Standing Orders Library Section in the Tab

## Goal

Give the standing-orders **definitions library** an operator-reachable surface: a Library section at the top of the existing Standing Orders tab (create, edit, delete definitions, with a usage count per entry), and an "assign from library" path on the assignment add form so a definition can be attached to a new order. This is the half of the "Standing Orders Library and Tab" feature that was specified but never built.

### The problem, and the root cause

The feature file `standing-orders-library-and-tab-b597eb54-c6c2-484d-b1e3-37bf9d6f4eda.md` describes the tab as carrying "two sections: a library of definitions (create, edit, delete) and an assignments view". Two subtasks shipped. Neither built the library section:

1. **`standing-orders-library-definitions-and-sync.md`** built the whole data model — `StandingOrderDefinition`, `terminals.standingOrderDefinitions`, `definitionId` on `StandingOrder`, `syncDefinitionToAssignments`, `reSyncAssignmentsToDefinitions`, the lazy migration, and definition CRUD on the HTTP API (`LocalApiServer.ts:4549-4680`: `listDefinitions` / `addDefinition` / `updateDefinition` / `deleteDefinition`).
2. **`standing-orders-tab-in-agent-control.md`** built the tab, but its own Proposed Changes section never mentions definitions — it specifies a scope filter and an assignment list, and that is exactly what it delivered.

The result is a **feature whose headline promise has no UI**. "Define once, assign to anything, edit once to update all" is fully implemented in the backend and reachable only by `curl`-ing `POST /terminals/standing-orders` with `action: 'addDefinition'`. The kanban webview cannot reach it at all: its CSP is `connect-src 'none'`, so every call must go through a kanban verb, and the four verbs that exist (`getStandingOrders`, `addStandingOrder`, `updateStandingOrder`, `deleteStandingOrder` — `KanbanProvider.ts:12829-13037`) cover assignments only.

Three consequences are live today, not hypothetical:

- **The library fills up and nobody can see it.** The lazy migration mints one definition per unique instruction text on first read, and `wireSpawnedTeam` mints two per team spawn. Definitions accumulate; the data-model plan's stated cleanup path was "the operator can delete them from the UI" — a UI that does not exist.
- **Orphaned definitions are invisible.** When a team is deleted its assignments go and its definitions stay. There is no way to see which definitions are used by nothing.
- **Editing an assignment silently detaches it.** The code review of the data-model plan found that keeping `definitionId` on an edited assignment made the lazy re-sync revert the operator's text on the next prompt dispatch, and fixed it by detaching the row on edit. That is the correct behaviour, but the operator gets no signal: they edit a team standing order in the cockpit, the row quietly leaves the library, and a later edit to the definition no longer reaches it. The library section is where that signal belongs.

## Metadata
- **Complexity:** 5
- **Tags:** frontend, backend, api, ui, feature

## User Review Required

None. Every open question below is decided in this plan.

## Background & Problem Analysis

### Verified facts (read from source during this pass)

- **The definitions CRUD already exists on the HTTP API.** `LocalApiServer._handleStandingOrdersWrite` handles `listDefinitions` (4549), `addDefinition` (4557), `updateDefinition` (4581, runs the eager `syncDefinitionToAssignments` when the instruction changes), `deleteDefinition` (4648, removes the definition and unlinks every assignment while keeping its `instruction` copy). No new server-side business logic is needed — only verb proxies.

- **The GET already returns definitions.** `_handleStandingOrdersList` ends with `res.end(JSON.stringify({ success: true, available: true, orders, definitions }))` (`LocalApiServer.ts:3866`). The kanban `getStandingOrders` verb does **not** — it returns `{ success, available, orders }` only (`KanbanProvider.ts:12857`). Extending it is strictly cheaper than adding a second read verb, and it makes the two hosts agree on one response shape.

- **`addStandingOrder` drops `definitionId` on the floor.** `KanbanProvider.ts:12917` calls `makeStandingOrder(parent, child, instruction, scope, teamId || undefined, role || undefined)` — six arguments. `makeStandingOrder` takes a seventh, `definitionId` (`standingOrders.ts:525-545`), and the HTTP `add` action already threads it. The verb must too, or "assign from library" cannot create a linked order.

- **The fleet-root resolver is settled.** All four existing verbs resolve their DB via `this._resolveStandingOrdersRoot(msg.workspaceRoot)` (`KanbanProvider.ts:1130`), which prefers `TaskViewerProvider.getFleetOrdersRoot()` — the latched fleet root — and falls back to the board root only when no TaskViewerProvider is wired. `standing-orders-fleet-root-contract.test.js:302` iterates a hard-coded verb list asserting exactly this. New verbs must use the same resolver **and** be added to that list, or the contract silently stops covering them.

- **The browser needs no new routes.** The generic `/kanban/verb/<name>` dispatcher reaches any new `_handleMessage` case; the previous subtask confirmed this and added none.

- **Verb responses must NOT carry a `type` field.** `KanbanProvider.postMessage` mirrors through the broadcaster to the WS hub, and in the browser `transport.js` *also* dispatches the HTTP return body as a MessageEvent. A typed return makes the panel handle every response twice. The four existing verbs postMessage the typed payload and return an untyped `{ success, ... }` — the `getIconPalette` / `getAgentGroups` precedent, documented in the comment at `KanbanProvider.ts:12836`.

- **Inline `onclick=` is dead in this webview.** The CSP is `script-src 'nonce-${nonce}' ${webview.cspSource}` (`KanbanProvider.ts:~13803`) with no `'unsafe-inline'`, so an inline handler attribute is silently inert. `kanban.html` contains zero of them. The Standing Orders tab dispatches row actions through `data-so-action` / `data-so-id` attributes and one delegated listener on `#standing-orders-list` (`kanban.html:6914-6926`).

- **`validateInstruction` rejects empty and marker-bearing text** (`standingOrders.ts:518-522`), and runs on `addDefinition` and on `updateDefinition` when the instruction changes.

- **The tab's client state is `{ available, orders }`** (`kanban.html:6673`), populated by the `standingOrders` message case (`kanban.html:11121`). Rendering is a full `innerHTML` rebuild of `#standing-orders-list` (`kanban.html:6761`).

- **`mutateStandingOrderDefinitions` writes unconditionally** (`standingOrders.ts:96-107`) — it calls `setConfigJson` even when the mutator returns its input untouched, which is every `ensureStandingOrderDefinition` cache hit, i.e. every team re-spawn.

- **The role badge has no not-found state.** `standingOrdersTabScopeBadge` (`kanban.html:6692`) renders `TEAM: <id> (team not found)` when a `teamId` resolves to nothing, but `ROLE: <role>` unconditionally. The tab plan's edge-case list specified a "role not found" badge; it was not built.

### Plan sizing

One plan. The three deliverables — verb proxies, the Library section, and assign-from-library — share one root cause, land in one tab and one provider switch, and none is shippable alone: verbs with no caller ship nothing, and assign-from-library without a library to pick from is a dropdown over an empty list.

## Complexity Audit

### Routine
- Three `case` blocks in `KanbanProvider.ts` proxying to `mutateStandingOrderDefinitions` / `syncDefinitionToAssignments`.
- Extending `getStandingOrders` to read and return `definitions`.
- Threading `definitionId` into the `makeStandingOrder` call in `addStandingOrder`.
- A Library section in `kanban.html`: list, inline create form, inline edit form, delete button.
- A "From library" `<select>` on the existing assignment add form.
- `npm run catalog:generate`.

### Complex / Risky
- **The usage count is a join the webview must do itself.** Nothing on a definition records which assignments reference it. The count is `orders.filter(o => o.definitionId === def.id).length`, computed client-side from the single `standingOrders` payload. This is correct only because both arrays arrive in the same message — a second round trip would let them skew. This is the reason for extending `getStandingOrders` rather than adding a `getStandingOrderDefinitions` verb.
- **Editing a definition rewrites N assignments.** `updateDefinition` runs the eager sync, so a single edit changes what is appended to every prompt those N assignments cover. The blast radius must be visible *before* the edit, as an informational count — not as a confirm gate (CLAUDE.md).
- **Two divergent empty-instruction conventions now coexist.** On an assignment, empty instruction routes to delete (the team cockpit editor's convention, already implemented at `kanban.html:6817`). On a definition it must not: blanking a definition would either be rejected by `validateInstruction` or, if routed to delete, silently unlink N assignments the operator never looked at. Definitions reject empty with an inline error.
- **The delegated listener currently scopes to `#standing-orders-list`.** The Library section is a sibling container, so it needs its own delegated listener (or the existing one must move up to a shared ancestor). Two listeners on two containers is the smaller change and keeps each section's actions namespaced.

## Edge-Case & Dependency Audit

- **Race Conditions:** All writes go through `mutateStandingOrderDefinitions` / `mutateStandingOrders`, which share one module-level `_writeChain`. `updateStandingOrderDefinition` must call `syncDefinitionToAssignments` **after** the definition write returns, never from inside the definitions mutator — `syncDefinitionToAssignments` itself awaits `mutateStandingOrders`, so nesting it inside a chained mutator deadlocks the chain. The HTTP handler at `LocalApiServer.ts:4581` already gets this ordering right; the verb must copy it, not improvise.
- **Security:** No new attack surface. `validateInstruction` runs on add and on instruction-changing update, same as the HTTP path. Verbs go through `_checkAuth` in the browser and the trusted webview bridge in VS Code.
- **Side Effects:** Editing a definition changes future prompts for every scope its assignments cover. Running agents do not re-read — the tab's existing effect note already says so and covers both sections.
- **Dependencies & Conflicts:**
  - Depends on the definitions data model and CRUD — landed.
  - Depends on the Standing Orders tab — landed.
  - Depends on `_resolveStandingOrdersRoot` and `getFleetOrdersRoot` — landed in the review pass.
  - No conflict with the team cockpit editor or Link-up modal: both edit `instruction` on the assignment, which detaches the row, which is the intended behaviour.
- **A definition used by zero assignments** is an orphan (team deleted, or every assignment edited and detached). It renders with `Used by 0 orders`; that is the whole cleanup affordance the data-model plan promised.
- **A definition whose text an assignment has diverged from** cannot exist after the review fix — divergence means the row was detached and carries no `definitionId`.
- **`available === false`:** the Library section hides behind the same gate as the assignment list; its Add button disables with the existing one.
- **Deleting a definition that is in use** is allowed and immediate. Assignments are unlinked, their `instruction` copies survive, delivery is unchanged. No confirm gate.
- **The board view** must never see the Library section: it lives inside `#standing-orders-tab-content`, which is `display: none !important` without `body[data-view="agent-control"]` (`kanban.html:2925-2927`). No new CSS rule is needed.

## Adversarial Synthesis

The failure mode this plan is most likely to reproduce is the one it exists to fix: building the mechanism and skipping the surface. The specific traps are (1) adding a separate `getStandingOrderDefinitions` read verb, which splits the two arrays across two round trips and makes the usage count race; (2) reintroducing `onclick=`, which is inert under this CSP and leaves every Library button dead exactly as the assignment buttons were; (3) using `_resolveWorkspaceRoot` on the new verbs, which points them at the board's active workspace instead of the latched fleet root; (4) returning a `type`-bearing body, which double-dispatches in the browser; and (5) calling `syncDefinitionToAssignments` from inside a `mutateStandingOrderDefinitions` callback, which deadlocks the shared write chain. Mitigations: extend the existing read verb; `data-so-action` delegation only; `_resolveStandingOrdersRoot` plus an extension of the contract test's verb list; untyped returns; and sync strictly after the definition write returns.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — extend one verb, add three

**Context:** `getStandingOrders` (12829) returns orders only. The definition CRUD has no verb proxy. `addStandingOrder` (12871) drops `definitionId`.

**Logic:**

1. **`getStandingOrders`** — after building `orders`, read `db.getConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, [])`, coerce to an array, and include it in both the postMessage payload and the return: `{ type: 'standingOrders', available: true, orders, definitions }` / `return { success: true, available: true, orders, definitions }`. Import `STANDING_ORDER_DEFINITIONS_CONFIG_KEY` and the `StandingOrderDefinition` type from `standingOrders`.

2. **`addStandingOrder`** — read `const definitionId = typeof msg.definitionId === 'string' ? msg.definitionId.trim() : '';` and pass `definitionId || undefined` as the seventh argument to `makeStandingOrder`.

3. **`case 'addStandingOrderDefinition'`** — `{ name, instruction }`. Resolve the root via `_resolveStandingOrdersRoot`. Default a blank `name` to `instruction.slice(0, 60)`. Run `validateInstruction`; on failure post `{ type: 'standingOrderDefinitionAdded', success: false, error }`. Otherwise `mutateStandingOrderDefinitions(db, defs => [...defs, makeStandingOrderDefinition(name, instruction)])`, capturing the created row. Post `{ type: 'standingOrderDefinitionAdded', success: true, definition }`; return the same without `type`.

4. **`case 'updateStandingOrderDefinition'`** — `{ id, name?, instruction? }`. Mirror `LocalApiServer.ts:4581` exactly, including its ordering: run the definitions mutator first, tracking `found`, `instructionChanged` and the final instruction text; if not found post a failure carrying `id`; **then**, outside the mutator, `await syncDefinitionToAssignments(db, id, finalInstruction)` when the instruction changed, wrapped in try/catch (the lazy re-sync is the recovery path). Post `{ type: 'standingOrderDefinitionUpdated', success: true, definition }`.

5. **`case 'deleteStandingOrderDefinition'`** — `{ id }`. `mutateStandingOrderDefinitions` to filter it out, then `mutateStandingOrders` to strip `definitionId` from every row that referenced it (destructure-and-drop, as `LocalApiServer.ts:4648` does). Post `{ type: 'standingOrderDefinitionDeleted', success: true, id }`.

**Edge Cases:** Every failure payload carries `id` where the webview needs to target an inline error slot — the assignment `updateStandingOrder` verb was fixed for exactly this and the definition verbs must not repeat it. No returned object carries a `type` field. All four handlers resolve through `_resolveStandingOrdersRoot`.

### 2. `protocol-catalog.json` + `src/generated/verbAllowlist.ts` — regenerate

Run `npm run catalog:generate` after the `case` blocks exist. The three new verbs must appear in `KANBAN_VERBS` or `browser-panel-verb-routing.test.js` fails on the posted-but-unlisted verb. Note that the catalog stores line numbers, so the diff is large and mostly line shifts — that is expected churn, not drift.

### 3. `src/webview/kanban.html` — the Library section

**Context:** The tab content container is `#standing-orders-tab-content` (3712). The assignment section is the `.db-subsection` holding the scope filter, add form and `#standing-orders-list` (3764). State is `standingOrdersTabState` (6673); the message case is at 11121; the delegated listener is at 6914.

**Logic:**

1. **State:** add `definitions: []` to `standingOrdersTabState`, and populate it in the `standingOrders` message case alongside `orders`.

2. **Markup** — a new `.db-subsection` inserted **above** the existing assignments subsection, so the library reads as the thing assignments draw from:
   - Header `Library`, with a one-line description: `Reusable instructions. Editing one updates every order that follows it.`
   - `+ NEW ENTRY` button (`#standing-orders-def-add-btn`), disabled by the same `available` gate as the assignment Add button.
   - Inline create form (`#standing-orders-def-add-form`, hidden by default): optional `Name` input, required `Instruction` textarea, error slot, SAVE / CANCEL.
   - `#standing-orders-def-list` for the rows, plus a `#standing-orders-def-empty` line reading `No library entries yet.`

3. **Row rendering** (`standingOrdersTabRenderDefRow`): name in bold; instruction below, `white-space: pre-wrap`; a usage line `Used by N order(s)` computed as `standingOrdersTabState.orders.filter(o => o.definitionId === def.id).length`, rendered as `Used by no orders — safe to delete` when N is 0; EDIT and DELETE buttons carrying `data-so-def-action="toggle-edit" | "delete"` and `data-so-def-id`. The inline edit form mirrors the create form (name + instruction + error slot) and, when N > 0, carries the line `Saving updates the instruction on N order(s).` — informational, never a gate.

4. **Delegated listener:** a second listener on `#standing-orders-def-list` keyed on `data-so-def-action`, wired inside the existing `standingOrdersTabWireEvents()` guard, plus direct listeners for the create form's own buttons. No `onclick=` anywhere.

5. **Message cases:** `standingOrderDefinitionAdded` / `...Updated` / `...Deleted` — on success, hide the relevant form and re-post `getStandingOrders` (one refresh repopulates both arrays); on failure, write `msg.error` into the create form's error slot, or into `'standing-orders-def-edit-error-' + msg.id` for an update.

6. **Assign from library** — on the assignment add form, a `From library` `<select>` (`#standing-orders-add-def`) listing `(none)` plus every definition by name. Choosing an entry fills the instruction textarea with the definition's text and marks the form's `dataset.definitionId`; typing in the textarea afterwards clears that dataset field back to empty, because the order would no longer match its definition. `standingOrdersTabSubmitAdd` sends `definitionId` when the dataset field is set. The select is hidden when there are no definitions.

7. **Linked-assignment notice** — in `standingOrdersTabRenderRow`, when `o.definitionId` resolves to a definition, render `Follows library entry «name» — editing here detaches this order` above the edit form. This is the missing signal for the detach-on-edit behaviour.

8. **Role-not-found badge** — in `standingOrdersTabScopeBadge`, render `ROLE: <role> (role not found)` when the role is neither one of the ten built-ins nor an id/name in `lastCustomAgents`, matching the existing `(team not found)` treatment.

**Edge Cases:** Empty instruction on a definition edit shows the inline error and does not delete — deliberately unlike the assignment convention, because a definition delete has blast radius across N assignments the operator is not looking at. Delete is immediate, no confirm gate. A blank name on create is filled client-side from `instruction.slice(0, 60)` so the operator is never made to name the same text twice; the server requires a non-empty `name` and would 400 otherwise.

### 4. `src/services/standingOrders.ts` — one identity guard

`mutateStandingOrderDefinitions` (96) calls `setConfigJson` unconditionally. Skip the write when the mutator returns the array it was given: `if (next !== defs) { await db.setConfigJson(...); }`. This removes a redundant write on every `ensureStandingOrderDefinition` cache hit, i.e. every team re-spawn. `ensureStandingOrderDefinition` already returns `defs` by reference on the hit path (203), so the guard fires without any other change.

### 5. Tests

- **`src/test/standing-orders-fleet-root-contract.test.js:302`** — add `addStandingOrderDefinition`, `updateStandingOrderDefinition`, `deleteStandingOrderDefinition` to the verb list. Without this the new verbs are uncovered by the one gate that catches wrong-root resolution, which is invisible in a single-root CI workspace.
- **`src/test/standing-orders-definitions-contract.test.js`** — add: a linked assignment created with `definitionId` survives `loadEffectiveStandingOrders` still linked; `mutateStandingOrderDefinitions` performs no write when the mutator returns its input (assert via a `setConfigJson` call counter on the stub db); deleting a definition leaves every formerly-linked assignment rendering byte-identically.
- **`src/test/browser-panel-verb-routing.test.js`** — no edit; it passes once the catalog carries the three verbs. Verify, do not modify.

## Dependencies

- **Definitions data model + HTTP CRUD** (`standingOrders.ts`, `teamWiring.ts`, `LocalApiServer.ts:4549-4680`) — landed.
- **Standing Orders tab** (`kanban.html`, the four assignment verbs) — landed.
- **`_resolveStandingOrdersRoot` / `getFleetOrdersRoot`** (`KanbanProvider.ts:1130`, `TaskViewerProvider.getFleetOrdersRoot`) — landed in the review pass.
- **`data-so-action` delegation pattern** (`kanban.html:6914`) — landed in the review pass; the Library section extends it rather than inventing a second mechanism.

## Approach

### 1. Backend
Extend `getStandingOrders` with `definitions`, thread `definitionId` through `addStandingOrder`, add the three definition verbs beside them, add the identity guard to `mutateStandingOrderDefinitions`, run `npm run catalog:generate`.

### 2. Frontend
Add the Library subsection above the assignments subsection, its two forms, its delegated listener, its three message cases, the `From library` select on the assignment add form, the linked-assignment notice, and the role-not-found badge.

### 3. Tests and gates
Extend the fleet-root verb list and the definitions contract test. Run compile, compile-tests, `catalog:check`, and the standing-orders contract trio.

## Edge cases

- **No definitions yet:** Library shows `No library entries yet.`; the `From library` select is hidden.
- **Definition used by zero orders:** row reads `Used by no orders — safe to delete`.
- **Definition deleted while in use:** assignments unlink, keep their `instruction`, delivery unchanged.
- **Assignment edited while linked:** detaches (existing behaviour), and the notice said so before the operator typed.
- **Blank name on create:** filled client-side from the first 60 characters of the instruction.
- **Empty instruction on a definition edit:** inline error, no delete, no write.
- **Instruction containing the standing-orders marker:** `validateInstruction` rejects; the error lands in the form's error slot.
- **`available === false`:** both sections' Add buttons disable behind the existing gate.
- **Board view:** the whole tab container is `display: none !important` without the `data-view` attribute; nothing new is needed.
- **Concurrent definition edit and assignment write:** serialized through the shared `_writeChain`; the sync runs after the definition write returns, never nested inside it.

## Verification Plan

### Automated
- `npm run compile` — clean.
- `npm run compile-tests` — clean.
- `npm run catalog:generate` then `npm run catalog:check` — the three new verbs present in `protocol-catalog.json` and `KANBAN_VERBS`, no drift.
- `npm run test:contract:standing-orders-definitions` — existing 12 pass plus the three new cases.
- `npm run test:contract:standing-orders-fleet-root` — passes with the extended verb list (it will fail first if the new verbs use the wrong resolver, which is the point).
- `npm run test:contract:standing-orders-marker` — 64 pass, delivery path untouched.
- `npm run test:contract:browser-panel-verb-routing` — the three new verbs are reachable. Note this test has one pre-existing failure at HEAD (`connections.js: copyTextToClipboard`) unrelated to standing orders; the standing-orders assertions must pass and the failure count must not increase.
- `npm run test:contract:panel-revival-retention` — `getState()` ordering preserved (no new `getState()` calls are expected; if one is added it must sit below the `sb-initial-state` seed block).
- `npm run verb-returns:check` and `npm run parity:check`.
- **CI wiring:** every check above is already a step in `.github/workflows/integration-tests.yml`. No new script is introduced, so no new step is needed — confirm this rather than assuming it.

### Manual
- **Library CRUD:** open the tab, create an entry, confirm it lists with `Used by no orders`. Edit its name and instruction, confirm both persist. Delete it, confirm it disappears immediately with no dialog.
- **Assign from library:** create an entry, add a global order choosing it from `From library`, confirm the order lists and the entry now reads `Used by 1 order`.
- **Edit once, update all:** assign one entry to a global order and a role order. Edit the entry's instruction. Confirm both orders show the new text, and that a prompt dispatched to a matching seat carries it.
- **Detach signal:** edit the linked assignment directly, confirm the notice was shown, and confirm the entry's usage count drops.
- **Delete in use:** delete an entry used by 2 orders. Confirm both orders survive with their instruction text and still deliver.
- **Migrated definitions:** on a workspace with pre-existing standing orders, confirm the Library lists one entry per unique instruction with correct usage counts.
- **Orphans:** spawn a team, delete it, confirm its two definitions remain and read `Used by no orders`.
- **Browser cockpit:** repeat library CRUD at `/agent-control` in the browser. Confirm one refresh per action, not two.
- **Board unchanged:** open the Kanban panel, confirm no Library section and all eight tabs present.

## Recommendation

**Send to Coder** (complexity 5). The backend is three verb proxies over CRUD that already exists and is already tested, plus two one-line threading fixes. The frontend is a second section in a tab whose patterns — availability gate, delegated `data-so-action` dispatch, refresh-by-re-posting-`getStandingOrders` — are established by the section directly below it. The real risk is not difficulty but repetition of the four traps named in the Adversarial Synthesis, each of which is invisible in a single-root VS Code smoke test and each of which has a gate listed above.
