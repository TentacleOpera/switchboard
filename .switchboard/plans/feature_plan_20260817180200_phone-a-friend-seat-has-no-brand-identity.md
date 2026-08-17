# A Phone-a-Friend Terminal Has No Brand Identity — Generic Curtain, Generic Icon, No CLI Name

## Goal

A Phone-a-Friend terminal must be identifiable as the agent CLI it is actually running. Its startup curtain must show that CLI's brand mark and name it ("Starting Antigravity CLI…"), exactly as a Lead or Coder seat does. Today it falls back to the generic grey `>_` placeholder and the bare word "Starting…", and the same blankness follows it into the sidebar row, the pane header and the shell rail.

### Problem analysis

The curtain builds its identity from one lookup (`src/webview/terminals.js:1927-1963`):

```js
const fleetItem = fleetList.find(t => t.friendlyName === name);
const agentLabel = agentLabelForRole(fleetItem && fleetItem.role);
const iconKey = brandIconForCliLabel(agentLabel) || 'default';
const uri = brandIconUri(iconKey) || brandIconUri('default');
…
label.textContent = agentLabel ? `Starting ${agentLabel}…` : 'Starting…';
```

`agentLabelForRole` (`terminals.js:6346-6351`) reads the `agentNames` map, which the webview fetches from `POST /kanban/verb/getStartupCommands` (`KanbanProvider._getStartupCommands`, `KanbanProvider.ts:4716-4736` → `_getAgentNames`).

### Root cause — `_getAgentNames` enumerates kanban COLUMN roles, not agent roles

`KanbanProvider._getAgentNames` (`src/services/KanbanProvider.ts:6471-6476`) builds its role list like this:

```ts
const builtInRoles = buildKanbanColumns([])
    .map(column => column.role)
    .filter((role): role is string => Boolean(role));
const fallbackRoles = [...new Set([...builtInRoles, 'analyst'])];
```

`DEFAULT_KANBAN_COLUMNS` (`src/services/agentConfig.ts:148-157`) carries exactly these roles: `researcher, planner, lead, coder, intern, reviewer, tester, ticket_updater`. Plus the hardcoded `analyst`, plus custom agents.

**`phone_a_friend` has no kanban column, so it is never in the list** — and neither are `claude_designer`, `jules`, or `project_manager`, all of which are real, selectable, terminal-owning roles (`BUILT_IN_AGENT_LABELS`, `src/webview/sharedDefaults.js:38-52`; `DEFAULT_VISIBLE_AGENTS`, `GlobalIntegrationConfigService.ts:346-360`).

### Verified against the live server (2026-08-17)

`POST /kanban/verb/getStartupCommands` on this workspace returns:

```json
"commands":  { …, "intern": "agy --dangerously-skip-permissions",
                  "phone_a_friend": "agy --dangerously-skip-permissions" },
"agentNames":{ "planner":"CLAUDE CLI", "researcher":"Antigravity CLI", "lead":"CLAUDE CLI",
               "coder":"DEVIN CLI", "intern":"Antigravity CLI", "reviewer":"CLAUDE CLI",
               "tester":"No agent assigned", "ticket_updater":"No agent assigned",
               "analyst":"CLAUDE CLI" }
```

The command is configured. The derivation works (`intern` and `researcher`, which run the same `agy` binary, both resolve to `Antigravity CLI` via `TaskViewerProvider.CLI_BRAND_NAMES`, `TaskViewerProvider.ts:1737-1754`). **`phone_a_friend` is simply absent from `agentNames`.**

`POST /terminals/verb/ptyVisibleRoles` on the same server returns `"phone_a_friend": true` in BOTH `visibleAgents` and `hasCommand` — so the seat is selectable in the role picker, the curtain does arm for it (`armStartupCurtain(name, hasCommand[role] === true)`, `terminals.js:6535`), and it is included in "open all" (`GRID_BUILTIN_ROLES`, `terminals.js:6865-6868`). Only its identity is missing.

### What the operator actually sees

With `agentLabel === ''`:

| Surface | Code | Result today |
| --- | --- | --- |
| Startup curtain | `renderStartupCurtain`, `terminals.js:1930-1953` | grey `>_` default glyph (`icons/brand-cli-default.svg`), label reads "Starting…" — nothing brand-specific animates |
| Sidebar row name | `renderTerminalRow`, `terminals.js:2182` | falls back to the raw handle (`phone_a_friend-1`) instead of the CLI name |
| Sidebar row icon | `terminals.js:2193-2202` | `brandIconForCliLabel('')` → `null`, no icon element at all |
| Pane header | `updatePaneElement`, `terminals.js:4783-4802` | `|| 'default'` → generic `>_` mark |
| Shell rail | `postFleetStateToShell`, `terminals.js:1366-1368` | `|| 'default'` → generic `>_` mark |

All five read the same map, so one fix repairs all five. This is not an icon-asset problem — `GET /static/icons/brand-antigravity.svg` returns `200 image/svg+xml`, the `data-brand-icon-antigravity` body attribute is present in the live-served page, and the curtain CSS (`terminals.html:1431-1462`) is brand-agnostic and shipped.

### Ruled out — do not "fix" these

1. The brand asset and its route (verified `200`, byte-identical to `icons/brand-antigravity.svg`).
2. `brandIconForCliLabel` — its `startsWith('antigravity')` arm is first in the chain and works when given a label (`terminals.js:2087`).
3. `brandIconUri` — `ds.brandIconAntigravity` is stamped by `headlessPanelHtml.ts:410` and present in the live page.
4. The curtain animation CSS — `body:not(.cyber-animation-disabled)` is never toggled in this panel, so the breathe and sweep rules always apply to whatever icon renders.
5. Curtain arming — `hasCommand.phone_a_friend === true`, verified live.

## Metadata

- **Complexity:** 3
- **Tags:** bugfix, frontend, ui, backend
- **Project:** Browser Switchboard

## Complexity Audit

### Routine

- Widening one role list in `_getAgentNames`. The name-derivation loop below it (`KanbanProvider.ts:6505-6525`) already handles any role and already emits the `'No agent assigned'` sentinel for a role with no command.
- No webview change: all five surfaces already consume `agentNames` correctly the moment the key exists.

### Complex / Risky

- **The role list is an input to more than the Terminals panel.** `_getAgentNames` also feeds the kanban board's column sublines via `updateAgentNames` (`KanbanProvider.ts:2191-2193`, `3633`). Adding keys is additive — the board looks roles up by key and ignores unknown ones — but the change must be additive only. Removing or renaming an existing key would blank a column subline.
- **`'No agent assigned'` is a load-bearing sentinel, not a bug.** `agentLabelForRole` treats it as "no label" (`terminals.js:6349`), and `deriveAgentDisplayName` passes it through unchanged (`TaskViewerProvider.ts:1750`). A newly-added role with no configured command must produce that exact string, not `''` and not `'undefined CLI'`.
- **Two readers of "which roles exist" must not drift.** `getPtyVisibleRoles` (`GlobalIntegrationConfigService.ts:376-401`) already enumerates the authoritative set — built-in defaults + custom agents, minus system-only roles. `_getAgentNames` should derive from the same source rather than growing a second hardcoded list that the next new role will miss again.
- **`SYSTEM_ONLY_ROLES` must stay excluded** (`GlobalIntegrationConfigService.ts:369`): `orchestrator`, `mcp_monitor`, `jules_monitor`, `scheduler`, `improver_*`. They are launched by automation and are not operator-selectable; naming them in `agentNames` would leak them into surfaces that enumerate the map.

## Edge-Case & Dependency Audit

- **Custom agents:** already merged (`KanbanProvider.ts:6499-6503`, `mergedCommands[agent.role] = agent.startupCommand`). The widened list must not displace that merge — union, not replacement.
- **Roles with a blank command** (`project_manager`, `tester` today): resolve to `'No agent assigned'`, so `agentLabelForRole` returns `''` and every surface behaves exactly as it does now for those roles. No regression, no new blank labels.
- **Standalone/browser host:** `bootstrap.ts` delegates `getStartupCommands` to the same `kanbanProvider` arm, so one fix covers both hosts. No standalone twin needed.
- **`getActualTerminalAgentNames` overlay** (`KanbanProvider.ts:6534-6540`) merges live terminal names over configured ones. It is keyed by role and unaffected by a longer configured list.
- **Failure path:** the `catch` at `KanbanProvider.ts:6526-6531` fills `fallbackRoles` with the sentinel. If the list becomes async-derived, that catch must still produce a usable map — keep a static fallback array for the throw case.
- **Caching:** `agentNames` is fetched once at init and refreshed on `fetchAgentNames()` (`terminals.js:1313`, `1705`). An operator who configures Phone-a-Friend mid-session sees the brand after the next refresh — same as every other role today. No new invalidation needed.
- **Security:** none. Role keys and CLI display names, no user HTML — the label is set via `textContent` and the icon via `img.src` from a same-origin `/static/icons/*.svg` path.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts:6471-6476` — enumerate agent roles, not column roles

```ts
 private async _getAgentNames(workspaceRoot: string): Promise<Record<string, string>> {
     const configuredNames: Record<string, string> = {};
     const builtInRoles = buildKanbanColumns([])
         .map(column => column.role)
         .filter((role): role is string => Boolean(role));
-    const fallbackRoles = [...new Set([...builtInRoles, 'analyst'])];
+    // Column roles are a SUBSET of terminal-owning roles. phone_a_friend,
+    // claude_designer, jules and project_manager own terminals but have no kanban
+    // column, so a column-derived list leaves them with no CLI label — and every
+    // surface that renders a brand (sidebar row, pane header, startup curtain,
+    // shell rail) falls back to the generic `>_` mark. Union with the visible-agent
+    // roster, which is the authoritative "which roles exist" answer and already
+    // strips SYSTEM_ONLY_ROLES.
+    let agentRoles: string[] = [];
+    try {
+        const { visibleAgents } = await GlobalIntegrationConfigService.getPtyVisibleRoles();
+        agentRoles = Object.keys(visibleAgents || {});
+    } catch (e) {
+        console.warn('[KanbanProvider] _getAgentNames: visible-role lookup failed, using column roles only:', e);
+    }
+    const fallbackRoles = [...new Set([...builtInRoles, 'analyst', ...agentRoles])];
```

`getPtyVisibleRoles` returns every role whose visibility the operator can toggle — including ones currently set to `false`, which is what we want: a hidden role that is later shown must already have a name. The existing loop at 6505-6525 then names each one, or stamps `'No agent assigned'`.

### 2. `src/services/KanbanProvider.ts:6526-6531` — keep the catch honest

The `catch` currently fills `fallbackRoles`, which is now computed above the `try`. Confirm it still references a defined array (it does — `fallbackRoles` is declared before the `try`), and leave the sentinel behaviour unchanged.

### 3. `src/webview/terminals.js:1953` — no code change, comment only

Record why the label can be empty, so the next reader does not "fix" it in the webview:

```js
// An empty agentLabel means the role has no entry in the agentNames map
// (KanbanProvider._getAgentNames). That is a HOST-side gap, not a webview one —
// do not paper over it with a role-name fallback here, which would print
// `Starting phone_a_friend…` instead of the CLI's real brand name.
label.textContent = agentLabel ? `Starting ${agentLabel}…` : 'Starting…';
```

### 4. Test — role coverage contract

Add a test asserting that every key in `DEFAULT_VISIBLE_AGENTS` (minus `SYSTEM_ONLY_ROLES`) appears in `_getAgentNames`' output. This is the guard that stops the next terminal-owning role from shipping nameless:

```ts
it('names every operator-selectable agent role, not just kanban column roles', async () => {
    const names = await (provider as any)._getAgentNames(workspaceRoot);
    for (const role of ['lead','coder','intern','reviewer','tester','planner','analyst',
                        'researcher','ticket_updater','jules','claude_designer',
                        'phone_a_friend','project_manager']) {
        expect(Object.keys(names)).toContain(role);
    }
});
```

## Verification Plan

1. **API level.** With the extension running:
   ```
   PORT=$(cat .switchboard/api-server-port.txt)
   curl -s -X POST http://127.0.0.1:$PORT/kanban/verb/getStartupCommands \
     -H 'Content-Type: application/json' \
     -d "{\"workspaceRoot\":\"$PWD\"}" | python3 -m json.tool | grep -A20 agentNames
   ```
   **Expect:** `"phone_a_friend": "Antigravity CLI"` (given the configured `agy …` command). Before the fix the key is absent entirely.
2. **Startup curtain.** Open a Phone-a-Friend terminal from the Terminals cockpit role picker. During boot the curtain must show the Antigravity brand mark (breathing, with the sweep ring) and read **"Starting Antigravity CLI…"**. Before the fix: grey `>_` glyph and "Starting…".
3. **Sidebar row.** The row's name line reads `Antigravity CLI` with the handle on the subline, and carries the brand icon. Before the fix: bare `phone_a_friend-1`, no icon.
4. **Pane header.** The seated pane's header carries the Antigravity mark rather than the generic `>_`.
5. **Shell rail.** The rail button for that terminal shows the Antigravity mark.
6. **No regression on unconfigured roles.** With `project_manager` still blank, its picker entry stays annotated `(plain shell)` and its rows show no CLI label — unchanged behaviour, no `undefined CLI`.
7. **Board sublines.** Open the kanban board and confirm every column subline still names its agent (`CLAUDE CLI`, `DEVIN CLI`, …) — the widened map must be additive.
8. **Contract test** from step 4 of Proposed Changes passes.
