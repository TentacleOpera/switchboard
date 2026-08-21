# Standing Orders Tab in the Agent Control Panel

## Goal

Add a fourth tab — **Standing Orders** — to the Agent Control panel (`kanban.html` with `data-view="agent-control"`), giving standing orders a prominent, dedicated surface for the first time. Today they are scattered across two buried modals (Link-up modal for `pair`, team cockpit for `team`/`team-head`) and two scopes (`global`, `role`) have no UI at all — they are API-only.

The tab coexists with the existing surfaces (no removal or redirect). It uses a scope-selector + filtered-list layout: a dropdown at top (All / Global / Role / Team / Team-Head / Pair), a list of orders below, and add/edit/delete actions per row. Full add/edit/delete is supported for `global`, `role`, `team`, and `team-head`; `pair` orders are shown in the list with delete only (add/edit stays in the Link-up modal, which has the terminal-pairing selectors the kanban webview lacks).

### The problem, and the root cause

Standing orders are persistent instructions appended to every prompt an agent receives. The backend is fully built — 5 scopes (`global`, `role`, `team`, `team-head`, `pair`), delivery on dispatch/establish/clear, and an API at `/terminals/standing-orders` supporting add/update/delete for all scopes. But the UI is fragmented and incomplete:

1. **`global` and `role` scopes have zero UI.** An operator who wants a global instruction ("always commit with conventional commit messages") or a role-level instruction ("all planners follow the GSD workflow") must curl the API. There is no webview surface to author or even view them.
2. **`team`/`team-head` orders are buried in the team cockpit.** The team cockpit editor (`terminals.js`) is inside the terminals view, not the Agent Control panel. It is a team-scoped editor — you must open a specific team's cockpit to see its orders, with no cross-team overview.
3. **`pair` orders are buried in the Link-up modal.** A terminal-pairing dialog is the only place to see pair-scoped orders, and it shows only the pair being linked, not all pair orders.
4. **No unified view.** An operator cannot see all standing orders in one place, cannot see which scopes have orders and which are empty, and cannot get a quick overview of what every agent is being told.

The Agent Control panel is the natural home — it is the "configure your agents" surface with Agents, Teams, and Prompts tabs. Standing orders are a core part of agent configuration and cross all five scopes, so they don't fit neatly into any one existing tab.

## Metadata
- **Complexity:** 6
- **Tags:** frontend, backend, api, ui, feature
- **Project:** Browser Switchboard

## User Review Required

Yes — the user should review:
- The coexistence decision (pair add/edit stays in Link-up modal; tab shows pair orders read-only + delete).
- The scope-selector + filtered-list layout.
- The verb-naming convention (`getStandingOrders` / `addStandingOrder` / `updateStandingOrder` / `deleteStandingOrder`).

## Background & Problem Analysis

### Verified facts (read from source during this pass)

- **The Agent Control panel is `kanban.html` with `data-view="agent-control"`.** There is no `agent-control.html` (the feature explicitly decided against a copy — `feature_plan_20260819_agent-control-frontend-html.md:6-8`). The view mode is an opt-in body attribute that hides 5 of 8 tabs via a CSS allow-list and re-marks the active tab at runtime.

- **The CSS allow-list shows 3 tabs.** `kanban.html` line ~2853: `body[data-view="agent-control"] .shared-tab-btn:not([data-tab="agents"]):not([data-tab="teams"]):not([data-tab="prompts"]) { display: none; }`. Adding a 4th tab means adding `:not([data-tab="standing-orders"])` to this selector, and adding the content container to the `display: none !important` block.

- **The kanban webview has `connect-src 'none'` CSP.** `KanbanProvider.ts:13618`: `connect-src 'none'`. The webview cannot make HTTP fetch calls. All data must come through `postKanbanMessage` (which is `vscode.postMessage()` in VS Code, and a fetch shim in the browser via `transport.js`).

- **Precedent: `getIconPalette` verb proxies an API call.** `KanbanProvider.ts:12794`: "The kanban webview cannot fetch GET /terminals/icon-palette directly (VS Code webview CSP + no auth cookie), so the TEAMS tab icon picker requests the palette via this verb." This is the exact pattern for standing orders — add kanban verbs that proxy to the standing orders logic.

- **The standing orders API is at `/terminals/standing-orders`.** GET returns `{ success, available, orders }` where each order has `{ id, parent, child, instruction, scope, teamId?, role?, createdAt, stale?, dropped?, effectiveInstruction? }` (`LocalApiServer.ts:3756`). POST accepts `{ action: 'add'|'update'|'delete', ... }` (`LocalApiServer.ts:4290`). The kanban webview cannot reach this endpoint directly.

- **In the browser, `postKanbanMessage` translates to `POST /kanban/{verb}`.** `transport.js:362`: `const url = ${routePrefix}/${encodeURIComponent(verb)}`. So `postKanbanMessage({ type: 'getStandingOrders' })` becomes `POST /kanban/getStandingOrders` in the browser. The browser path needs corresponding routes in `LocalApiServer.ts` under the `/kanban/` prefix.

- **Teams data is already available.** `getAgentGroups` (kanban verb, `KanbanProvider.ts:12779`) returns `{ groups: [{ id, name, members, ... }] }`. This is the team selector data for `team`/`team-head` scope orders.

- **Roles data is already available.** The Prompts tab has a hard-coded `<select id="roleSelect">` with planner, lead, coder, intern, reviewer, tester, analyst, researcher, ticket_updater, jules (`kanban.html:3430-3441`), plus a `<optgroup id="customAgentsGroup">` populated from `getCustomAgents`. The tab can reuse this list for the role selector.

- **The protocol catalog is auto-generated.** `npm run catalog:generate` runs `scripts/generate-protocol-catalog.js --write && scripts/generate-verb-allowlist.js --write`. New verbs must be added to `KanbanProvider.ts` first (the catalog scanner reads `case 'verbName':` lines), then the catalog is regenerated.

- **`browser-panel-verb-routing.test.js` asserts every posted verb is in `KANBAN_VERBS`.** New verbs that appear in the allowlist pass automatically; the test fails only if a verb is posted but not in the allowlist. Regenerating the catalog after adding the `case` blocks keeps this green.

- **State persistence is namespaced.** The Agent Control view persists `{ agentControl: { activeTab, role } }` via `vscode.getState()/setState()`, namespaced under a sub-key to avoid colliding with the board's shared `localStorage` blob (`feature_plan_20260819_agent-control-frontend-html.md:84-87`). The new tab's active state rides on the same `activeTab` key — no new state key needed, just add `'standing-orders'` to the valid-tab set.

- **Tab hydration is click-driven.** The `agents`, `teams`, and `prompts` arms of the tab click handler (`kanban.html:5925-5957`) post messages and call init functions. A new `standing-orders` arm posts `getStandingOrders` and `getAgentGroups` to populate the list and selectors.

- **The `getState()`-below-the-seed ordering is contract-enforced.** `panel-revival-retention-contract.test.js:108-131` asserts the first textual `getState()` is inside the `sb-initial-state` seed block (`kanban.html:3848`). Any new `getState()` call must appear after that line.

## Complexity Audit

### Routine
- Adding a tab button and content container to `kanban.html`.
- Updating the CSS allow-list to include the 4th tab.
- Adding a tab hydration arm that posts `getStandingOrders` + `getAgentGroups`.
- Rendering a scope-selector dropdown and a filtered list of orders.
- Add/edit/delete forms per scope (instruction textarea + scope-specific selector).
- Adding 4 new `case` blocks in `KanbanProvider.ts` that proxy to standing orders logic.
- Adding 4 new `/kanban/{verb}` routes in `LocalApiServer.ts` that proxy to the existing standing orders handlers.
- Running `npm run catalog:generate` to update the allowlist.

### Complex / Risky
- **The kanban webview's CSP (`connect-src 'none'`) means all data must flow through verbs.** This is the central architectural constraint. The `getIconPalette` precedent shows the pattern, but standing orders need 4 verbs (CRUD), not 1 (read).
- **The `pair` scope needs terminal names for a full editor, which the kanban webview doesn't have.** The kanban webview has no "list of live terminals" verb. `getAgentGroups` returns team members only, not standalone terminals. Rather than adding a `getVisibleAgents` kanban verb (which is a TaskViewer verb, not a Kanban verb), `pair` orders are shown read-only + delete in this tab. Add/edit stays in the Link-up modal.
- **The edit is in `kanban.html` (13,368 lines, 20+ contract tests).** The change must be strictly additive and inert when `data-view` is absent (the board must not see the tab). The CSS allow-list must include the new tab or it will be hidden in the Agent Control view.
- **The `getState()` ordering contract.** Any new `getState()` call for persisted-tab restore must sit below `kanban.html:3849`.
- **The browser path needs `/kanban/{verb}` routes in `LocalApiServer.ts`.** The existing standing orders handlers are at `/terminals/standing-orders`. The new kanban routes must proxy to the same logic, not duplicate it.

## Edge-Case & Dependency Audit

- **Race Conditions:** Standing orders writes are serialized through `mutateStandingOrders` (`standingOrders.ts:48`), which uses a module-level promise chain. The new verbs must route through the same chain — the KanbanProvider handler calls the same `mutateStandingOrders` / `db.getConfigJson` / `db.setConfigJson` path, not a parallel one.
- **Security:** The kanban verbs go through `_checkAuth` in LocalApiServer (browser path) and through the VS Code webview message bridge (VS Code path, which is inherently trusted). The `validateInstruction` guard runs on add/update. No new attack surface.
- **Side Effects:** Editing a standing order changes what is appended to future prompts only. Agents already running do not re-read it. The tab should say so, once, plainly — matching the team cockpit editor's pattern (`team-standing-orders-editor.md:81`).
- **Dependencies & Conflicts:**
  - Depends on the standing orders backend (`standingOrders.ts`) — already landed.
  - Depends on the Agent Control view mode (`data-view="agent-control"`) — already landed.
  - Depends on `getAgentGroups` (teams selector) — already a kanban verb.
  - Depends on `getCustomAgents` (roles selector) — already a kanban verb.
  - No conflict with the Link-up modal or team cockpit editor — this tab coexists with both.
- **`standingOrdersAvailable` false:** The GET handler returns `{ available: false }` when no kanban DB is reachable. The tab must gate on this and show a disabled state, matching the Link-up modal's pattern (`terminals.js:9138`).
- **Stale/dropped orders:** The GET response includes `stale`, `dropped`, and `effectiveInstruction` metadata from `describeStandingOrderMigrations`. The list should show these badges so the operator can see when an order is a legacy row awaiting migration.
- **Empty instruction = delete:** The editor routes empty instructions to `delete`, not `update` with an empty string — matching the team cockpit editor's convention (`team-standing-orders-editor.md:57`).
- **No confirm gate:** Delete removes immediately, per CLAUDE.md. No `confirm()`, no modal, no two-click pattern.

## Adversarial Synthesis

Key risks: (1) the CSP constraint forces 4 new verbs through the kanban message bridge — this is the largest part of the work and touches the protocol catalog, verb allowlist, and a contract test; (2) the `pair` scope cannot be fully edited here because the kanban webview has no terminal list — the coexistence decision handles this by keeping pair add/edit in the Link-up modal; (3) the edit lands in `kanban.html`, the repo's most-edited webview with 20+ contract tests — the change must be strictly additive and inert without the `data-view` attribute. Mitigations: follow the `getIconPalette` precedent for verb proxying; gate pair editing to delete-only with a note pointing to the Link-up modal; place all new `getState()` calls below the seed block; update the CSS allow-list to include the new tab.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — 4 new kanban verbs

**Context:** The kanban webview cannot fetch `/terminals/standing-orders` directly (CSP `connect-src 'none'`). The `getIconPalette` verb (`KanbanProvider.ts:12794`) is the precedent: it proxies an API call because the webview cannot reach the HTTP endpoint.

**Logic:** Add 4 `case` blocks in the message handler switch (beside `getAgentGroups` at line 12779):

- `case 'getStandingOrders'`: Resolve the fleet orders DB via `_taskViewerProvider` (or the same DB resolution path the standing orders API uses). Read orders via `db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, [])`. Run `describeStandingOrderMigrations` for staleness metadata. Post `{ type: 'standingOrders', available: true, orders }` back. When no DB, post `{ type: 'standingOrders', available: false, orders: [] }`.
- `case 'addStandingOrder'`: Extract `{ parent, child, instruction, scope, teamId, role }` from the message. Validate scope (accept `'global', 'team', 'pair', 'team-head', 'role'`). Run `validateInstruction`. Call `mutateStandingOrders(db, ...)` with `makeStandingOrder(...)`. Post `{ type: 'standingOrderAdded', order }` back.
- `case 'updateStandingOrder'`: Extract `{ id, instruction }`. Run `validateInstruction`. Call `mutateStandingOrders(db, ...)` to update in place, preserving `id`, `scope`, `teamId`, `parent`, `child`, `createdAt`. Post `{ type: 'standingOrderUpdated', order }` back.
- `case 'deleteStandingOrder'`: Extract `{ id }`. Call `mutateStandingOrders(db, ...)` to filter out the id. Post `{ type: 'standingOrderDeleted', id }` back.

**Edge Cases:** The DB resolution path must match `_resolveFleetOrdersDb` in `LocalApiServer.ts`. When no DB is available, `getStandingOrders` returns `available: false`; the write verbs return an error. The `validateInstruction` guard rejects empty strings and marker-containing instructions. All writes go through `mutateStandingOrders` to join the serialization chain.

**Import:** `KanbanProvider.ts` must import `mutateStandingOrders`, `makeStandingOrder`, `validateInstruction`, `STANDING_ORDERS_CONFIG_KEY`, and `describeStandingOrderMigrations` from `standingOrders.ts` / `teamWiring.ts`. Check existing imports — some may already be present.

### 2. `src/services/LocalApiServer.ts` — 4 new `/kanban/{verb}` routes

**Context:** In the browser, `postKanbanMessage` translates to `POST /kanban/{verb}` (`transport.js:362`). The existing standing orders handlers are at `/terminals/standing-orders` (GET/POST). The new kanban routes must proxy to the same logic, not duplicate it.

**Logic:** In the kanban route dispatcher (where `/kanban/{verb}` routes are resolved), add 4 new cases:

- `getStandingOrders`: Call `_handleStandingOrdersList` logic (or delegate to it). The response body is dispatched back to the webview by `transport.js` as a `MessageEvent` — so the response must include a `type` field (e.g. `{ type: 'standingOrders', success: true, available: true, orders }`) for the webview's message handler to catch it.
- `addStandingOrder`: Call `_handleStandingOrdersWrite` logic with `action: 'add'`. Response: `{ type: 'standingOrderAdded', success: true, order }`.
- `updateStandingOrder`: Call `_handleStandingOrdersWrite` logic with `action: 'update'`. Response: `{ type: 'standingOrderUpdated', success: true, order }`.
- `deleteStandingOrder`: Call `_handleStandingOrdersWrite` logic with `action: 'delete'`. Response: `{ type: 'standingOrderDeleted', success: true, id }`.

**Edge Cases:** The response `type` field is critical — `transport.js:410` dispatches the response body as a `dispatchMessage(result)` call, which fires `window.dispatchEvent(new MessageEvent('message', { data: result }))`. The webview's `window.addEventListener('message', ...)` handler routes by `data.type`. Without a `type` field, the response is silently dropped. The existing standing orders handlers return `{ success, ... }` without a `type` field — the kanban proxy routes must add one.

**Alternative:** Instead of 4 separate routes, the existing `_handleStandingOrdersList` and `_handleStandingOrdersWrite` could be refactored to accept an optional `responseType` parameter. The kanban proxy routes call them with the response type injected. This avoids duplicating the validation/handling logic.

### 3. `protocol-catalog.json` + `src/generated/verbAllowlist.ts` — regenerate

**Logic:** After adding the 4 `case` blocks to `KanbanProvider.ts`, run `npm run catalog:generate`. The catalog scanner reads `case 'verbName':` lines from `KanbanProvider.ts` and writes them to `protocol-catalog.json` (under `providers.Kanban.verbs[]`) and `verbAllowlist.ts` (under `KANBAN_VERBS`). The 4 new verbs (`getStandingOrders`, `addStandingOrder`, `updateStandingOrder`, `deleteStandingOrder`) will appear in both files.

**Edge Cases:** The catalog scanner reads line numbers — if the `case` blocks are added at the wrong indentation or with different quoting, the scanner may miss them. Follow the exact pattern of existing `case` blocks (e.g. `case 'getAgentGroups': {`).

### 4. `src/webview/kanban.html` — the Standing Orders tab

**Context:** The Agent Control view shows 3 tabs via a CSS allow-list. The tab bar is at ~line 2918, content containers at ~3142-3834. The CSS allow-list is at ~2853. The tab click handler is at ~5925. State persistence is namespaced under `agentControl` below line 3849.

**Logic:**

1. **Tab button** (beside the Prompts button, ~line 2926): `<button class="shared-tab-btn" data-tab="standing-orders">Standing Orders</button>`

2. **Content container** (after `#prompts-tab-content`, ~line 3834): `<div id="standing-orders-tab-content" class="shared-tab-content">` containing:
   - A scope-selector dropdown: `<select id="standing-orders-scope-filter">` with options: All, Global, Role, Team, Team-Head, Pair.
   - An "Add" button that opens an inline add form.
   - A list container: `<div id="standing-orders-list"></div>`.
   - An availability gate: a disabled-state message shown when `available === false`.

3. **CSS allow-list update** (~line 2853): Add `:not([data-tab="standing-orders"])` to the button selector. The content container is hidden by default (it's not in the `display: none !important` list because it's a new container that starts without the `active` class — but verify it's hidden when not active, same as the other content containers).

4. **Tab hydration arm** (in the tab click handler, ~line 5925): Add a `standing-orders` arm that posts `getStandingOrders` and `getAgentGroups` to populate the list and team selector.

5. **Message handlers** (in the `window.addEventListener('message', ...)` handler): Add handlers for:
   - `standingOrders`: Store the orders, render the list filtered by the current scope selector.
   - `standingOrderAdded` / `standingOrderUpdated` / `standingOrderDeleted`: Re-post `getStandingOrders` to refresh the list.
   - `agentGroups`: Already handled — reuse the stored groups for the team selector.

6. **List rendering**: Each order row shows:
   - Scope badge (GLOBAL, ROLE: <role>, TEAM: <team name>, TEAM-HEAD: <team name>, PAIR: <parent>→<child>).
   - Instruction text (truncated with expand-on-click).
   - Stale/dropped badges if present.
   - Edit button (opens inline editor with instruction textarea + scope-specific selector).
   - Delete button (removes immediately, no confirm gate).
   - For `pair` orders: no edit button, only delete. Show a note: "Edit in Link-up modal."

7. **Add form**: When the scope selector is set to a specific scope (not "All"), the Add button creates a new order of that scope. The form shows:
   - `global`: instruction textarea only.
   - `role`: instruction textarea + role selector (populated from the Prompts tab's role list + custom agents).
   - `team` / `team-head`: instruction textarea + team selector (populated from `getAgentGroups`).
   - `pair`: disabled with note "Add pair orders via the Link-up modal."

8. **State persistence**: The active tab is already persisted via `agentControl.activeTab`. Add `'standing-orders'` to the valid-tab set in the restore logic (beside `'agents'`, `'teams'`, `'prompts'`). No new state key.

9. **Availability gate**: When `available === false`, show "Standing orders require a Kanban database. Open Setup to configure one." and disable the Add button.

10. **Effect note**: A one-line note at the top of the tab: "Changes apply to future prompts only. Running agents do not re-read them." — matching the team cockpit editor's pattern.

**Edge Cases:**
- Persisted tab is `standing-orders` but the view is the board (not Agent Control) ⇒ the board doesn't have the tab, so the restore logic falls back to AGENTS (the existing fallback for non-allow-listed tabs).
- `getAgentGroups` returns empty (no teams) ⇒ the team selector shows "No teams available" and the add form for team/team-head scope is disabled.
- An order's `teamId` references a deleted team ⇒ show the teamId with a "team not found" badge.
- An order's `role` references a deleted custom agent ⇒ show the role name with a "role not found" badge.
- `getState()` calls for tab restore must sit below `kanban.html:3849` (the seed block).

### 5. `src/test/browser-panel-verb-routing.test.js` — verify new verbs

**Context:** This test asserts every verb posted by the kanban webview is in `KANBAN_VERBS`. After `npm run catalog:generate`, the 4 new verbs are in the allowlist. The test should pass without modification. Verify it does.

## Dependencies

- **Standing orders backend** (`src/services/standingOrders.ts`) — already landed. All 5 scopes, `mutateStandingOrders`, `validateInstruction`, `makeStandingOrder`, `describeStandingOrderMigrations`.
- **Agent Control view mode** (`data-view="agent-control"` in `kanban.html`) — already landed. CSS allow-list, active-tab re-marking, state persistence.
- **`getAgentGroups` kanban verb** — already landed. Provides team data for the team selector.
- **`getCustomAgents` kanban verb** — already landed. Provides custom agent roles for the role selector.
- **`getIconPalette` kanban verb** — precedent for proxying an API call through the kanban message bridge.

## Approach

### 1. Add the 4 kanban verbs (backend)
Add `case` blocks in `KanbanProvider.ts` for `getStandingOrders`, `addStandingOrder`, `updateStandingOrder`, `deleteStandingOrder`. Each proxies to the standing orders logic via `mutateStandingOrders` / `db.getConfigJson`. Add corresponding `/kanban/{verb}` routes in `LocalApiServer.ts` that delegate to the existing `_handleStandingOrdersList` / `_handleStandingOrdersWrite` logic, adding a `type` field to the response for `transport.js` dispatch. Run `npm run catalog:generate`.

### 2. Add the tab UI (frontend)
Add the tab button, content container, CSS allow-list update, hydration arm, message handlers, list rendering, add/edit/delete forms, and state persistence to `kanban.html`. All new code is gated on `document.body.dataset.view === 'agent-control'` — the board never sees the tab.

### 3. Verify
Run the contract test suite, compile, and manually exercise the tab in both VS Code and the browser cockpit.

## Edge cases
- **`available === false` (no DB):** Show disabled state, same as Link-up modal.
- **Stale/dropped orders:** Show badges from `describeStandingOrderMigrations` metadata.
- **Deleted team referenced by a team-scoped order:** Show "team not found" badge.
- **Deleted custom agent referenced by a role-scoped order:** Show "role not found" badge.
- **Empty instruction on edit:** Route to `delete`, not `update` with empty string.
- **Instruction containing the marker text:** `validateInstruction` rejects it — show the error inline.
- **Board view (no `data-view` attribute):** Tab button and content are hidden by CSS; no `standingOrders` key is ever written to state; no `getStandingOrders` message is ever posted.
- **Persisted tab is `standing-orders` but view is board:** Falls back to AGENTS (existing fallback for non-allow-listed tabs).
- **Concurrent writes:** Serialized through `mutateStandingOrders` promise chain.

## Verification Plan

### Automated Tests
- `npm run compile` — clean.
- `npm run catalog:generate` — regenerates `protocol-catalog.json` and `verbAllowlist.ts` with the 4 new verbs.
- `node --test src/test/browser-panel-verb-routing.test.js` — verifies the 4 new verbs are in `KANBAN_VERBS` (should pass after catalog regeneration).
- `node --test src/test/panel-revival-retention-contract.test.js` — verifies `getState()` ordering is preserved (all new `getState()` calls must be below the seed block).
- `node --test src/test/standing-orders-marker-contract.test.js` — verifies the marker contract is unchanged (no changes to `standingOrders.ts` rendering logic).

### Manual
- **Board unchanged:** Open the Kanban panel, confirm all 8 tabs are present and the board renders. The Standing Orders tab is NOT visible.
- **Agent Control view:** Confirm exactly 4 tab buttons (AGENTS, TEAMS, PROMPTS, STANDING ORDERS), AGENTS active on load.
- **Standing Orders tab:** Click the tab, confirm the scope selector and list populate. Add a global order, confirm it appears. Edit it, confirm the change. Delete it, confirm it disappears.
- **Role-scoped order:** Select "Role" in the scope filter, add an order for "planner", confirm it appears with a ROLE: planner badge.
- **Team-scoped order:** Select "Team" in the scope filter, add an order for a team, confirm it appears with a TEAM: <name> badge. Verify the same order is visible in the team cockpit editor (coexistence).
- **Pair-scoped order:** Select "Pair" in the scope filter, confirm existing pair orders are listed with delete only (no edit). Confirm the note "Edit in Link-up modal" is shown.
- **Persistence:** Switch to Standing Orders tab, reload, confirm the same tab is restored.
- **Availability gate:** Open the tab when no DB is configured, confirm the disabled state.
- **Browser cockpit:** Open `/agent-control` in the browser, confirm the tab works identically.
- **No confirm gate:** Delete an order, confirm it is removed immediately with no dialog.

## Recommendation

**Send to Coder** (complexity 6). The backend verb-proxying follows a well-established precedent (`getIconPalette`), and the frontend tab follows the existing Agent Control view-mode pattern. The main risk is the `kanban.html` edit surface, but the change is strictly additive and gated on the `data-view` attribute.
