# Making an Agent Visible Also Forces a Kanban Column — Split Them With an "Add as Board Column" Checkbox

## Goal

Give every agent in the Agents tab a **separate** "Add as board column" checkbox, so an
agent can exist as a terminal without owning a Kanban column. Ship it **unchecked by
default for Researcher**, whose column is the case that made the coupling visible: the
Researcher is a terminal that planners hand work to, and a column for it is dead weight on
most boards.

### The problem

The Researcher is reached by a **hand-off**, not by a card move. `agentPromptBuilder`'s
research directive tells the planner to POST the research prompt straight to the live
Researcher terminal:

> RESEARCHER HAND-OFF … POST to `http://127.0.0.1:<port>/research/dispatch` with JSON body
> `{"workspaceRoot": …, "prompt": …}` … If a Researcher agent is registered AND live it
> forwards the prompt to that agent, tells it to save its findings to the configured
> research-docs folder …

Nothing in that flow involves a card, a column, or a plan file. Plans do not carry a
research question, and no prompt anywhere instructs a planner to write one into a plan file
— a `grep` for `research question` across `src/` returns nothing. So a card dragged into the
RESEARCHER column arrives at an agent with no question to answer, which is the "it doesn't
get to do anything" the report describes.

The column is not *never* useful — a deliberate "go research this plan" drop is a coherent
gesture, which is why it exists. It is useful *sometimes*, on *some* boards, and it is
currently mandatory the moment the Researcher terminal is switched on.

### Root cause

**One flag drives two unrelated things.** `visibleAgents[role]` is simultaneously:

- *"Show this agent in the terminal-creation picker and open it with OPEN AGENT
  TERMINALS"* — read by `terminals.js` (`fetchPtyVisibleRoles` → the role picker) and by
  `extension.ts`'s `createAgentGrid`.
- *"Render this agent's Kanban column"* — read by three separate column filters, all keyed
  on the same map:

```ts
// KanbanProvider._filterDynamicColumns
return columns.filter(col => {
    if (col.featureOnly) return occupiedColumns.has(col.id);
    if (!col.role) return true;
    if (visibleAgents[col.role] !== false) return true;
    return occupiedColumns.has(col.id);
});
```

```ts
// TaskViewerProvider._filterVisibleColumns
if (column.source === 'built-in' && column.role && visibleAgents[column.role] === false) {
    return false;
}
```

```ts
// PlanningPanelProvider._resolveColumns — a third copy of the same predicate
if (visibleAgents[col.role] !== false) return true;
return occupiedColumns.has(col.id);
```

The Agents tab exposes exactly one checkbox per role to feed it
(`.agents-tab-visible-toggle` in `kanban.html`), and the collector reads that one class:

```js
document.querySelectorAll('#agents-tab-content .agents-tab-visible-toggle, …').forEach(cb => {
    if (cb.dataset.role) visibleAgents[cb.dataset.role] = cb.checked;
});
```

So "I want a Researcher terminal so my planners can hand off to it" and "I want a
RESEARCHER column on my board" are the same checkbox, and there is no way to express the
first without the second.

`researcher` ships `false` in every defaults map (`TaskViewerProvider._defaultVisibleAgents`,
`KanbanProvider._getVisibleAgents`, `PlanningPanelProvider`), which is why the column is
absent on a fresh install — and why turning the terminal on is what makes it appear.

### Background context

- `visibleAgents` is **machine-global**, stored under `~/.switchboard` via
  `GlobalIntegrationConfigService` (`AGENT_GLOBAL_FILE_KEYS`), mirrored through
  `stateConfigBridge`'s `STATE_KEY_TO_CONFIG` as `agents.visibleAgents`, and protected by a
  wipe guard that refuses an empty overwrite. Any sibling key must join all three.
- The existing `occupiedColumns.has(col.id)` escape hatch in two of the three filters means
  a column that still holds cards is rendered regardless of the flag. That is what keeps
  hiding a column from stranding work, and it must be preserved verbatim.
- This extension is published with roughly 4,000 installs, many on older versions. A new
  flag that defaults to "off" for everything would delete every user's board columns on
  upgrade. The default resolution below is written specifically to make the upgrade a no-op
  for every role except the one the report names.

## Metadata

- **Complexity:** 6
- **Tags:** backend, frontend, ui, ux, feature
- **Project:** Browser Switchboard

## Complexity Audit

**Complex.** Small per site, but the sites are spread across the config plumbing, three
duplicated column filters, two hosts, and a published install base.

- **Migration is the risk, not the logic.** Getting the default resolution wrong ships a
  board with missing columns to thousands of installs. The rule below (`inherit
  visibleAgents unless the role has an explicit column default`) makes the upgrade provably
  a no-op except for `researcher`.
- **Three copies of the same predicate.** `KanbanProvider._filterDynamicColumns`,
  `TaskViewerProvider._filterVisibleColumns` and `PlanningPanelProvider._resolveColumns` each
  reimplement column visibility, and two of the three carry the `occupiedColumns` escape
  hatch while the third does not. Adding a fourth input to three divergent copies is how a
  board ends up disagreeing with itself between panels. Extract one resolver in
  `agentConfig.ts` and have all three call it.
- **Two hosts.** The standalone bootstrap and the extension host both read agent config; a
  key added to one and not the other produces a board that differs by host.

## Edge-Case & Dependency Audit

1. **Upgrade must not remove any existing column.** A user who never sees the new checkbox
   must keep exactly the board they have. The resolution is:

   ```
   columnEnabled(role) =
       kanbanColumnAgents[role]                    // explicit user choice, if any
       ?? DEFAULT_KANBAN_COLUMN_AGENTS[role]       // per-role override (researcher: false)
       ?? visibleAgents[role]                      // inherit today's behaviour
       ?? true
   ```

   With `DEFAULT_KANBAN_COLUMN_AGENTS = { researcher: false }`, every other role inherits
   the flag it already had, so the board is byte-identical after upgrade.

2. **A user who deliberately hid a column** (e.g. unchecked `reviewer`) keeps it hidden —
   the inherit arm carries their `false` through. This is the case a naive `?? true` default
   would break.

3. **Cards already in RESEARCHER.** The `occupiedColumns.has(col.id)` arm keeps the column
   rendered while it holds cards, so turning the column off never strands work. Preserve
   that arm in the extracted resolver, and **add** it to
   `TaskViewerProvider._filterVisibleColumns`, which today lacks it — that filter feeds the
   Setup panel's Kanban-structure view, where a hidden-but-occupied column should still be
   listed.

4. **The Researcher terminal is unaffected.** Unchecking the column must leave the terminal
   in the picker, `OPEN AGENT TERMINALS`, and — critically — the `/research/dispatch`
   hand-off, which resolves the researcher from the live fleet and never consults column
   config. Verify explicitly; this is the whole point of the split.

5. **`researcherConfigured` in the planner prompt.** `agentPromptBuilder` chooses between
   `ADVISE_RESEARCH_DIRECTIVE` and `ADVISE_RESEARCH_DIRECTIVE_NO_RESEARCHER` based on whether
   a researcher is configured. That predicate must keep reading **agent visibility / startup
   command**, not the new column flag — a workspace with a Researcher terminal and no
   Researcher column must still get the hand-off directive.

6. **Custom agents.** `CustomAgentConfig` already has its own `includeInKanban` boolean and
   its own `kanbanOrder`. Custom agents therefore already have this split, and the new key
   must not shadow it: the resolver applies to `source === 'built-in'` columns only; custom
   agent columns keep answering to `includeInKanban`.

7. **Restore Kanban Defaults.** `handleRestoreKanbanDefaults` writes a defaults patch over
   `visibleAgents` for every built-in column role and explicitly avoids deleting keys (an
   empty remainder is refused by the wipe guard). It must write the same shape of patch for
   the new key, from `DEFAULT_KANBAN_COLUMN_AGENTS` merged over the visibility defaults —
   or Restore Defaults will silently leave stale column overrides.

8. **Wipe guard.** `agentConfigMeaningfulCount` special-cases `visibleAgents` to count keys
   (an all-false map is intentional config). The new key has identical semantics and needs
   the same branch, or an all-false map would be counted as zero and refused.

9. **Drag/drop into a hidden column.** Not reachable — a hidden column renders no drop
   target. Existing cards in it are still moved out normally via the card menu.

10. **Autoban / orchestration.** Column *definitions* are unchanged; only rendering is
    filtered. Any automation that names `RESEARCHER` by id keeps working. Confirm
    `KanbanProvider`'s column-order array (which lists `RESEARCHER` explicitly) is a
    *display order* list and tolerates the column being filtered out.

## Proposed Changes

### 1. `src/services/agentConfig.ts` — one resolver, one defaults map

```ts
/**
 * Per-role default for "does this agent get a board column", where it differs from
 * the agent's own visibility.
 *
 * A role ABSENT from this map inherits `visibleAgents[role]` — which is exactly the
 * behaviour before the split, and is what makes the upgrade a no-op for every existing
 * install. Only add a role here when its column should NOT follow its terminal.
 *
 * researcher: the Researcher is reached by a HAND-OFF (the planner POSTs its research
 * prompt to /research/dispatch), not by a card move. Plans carry no research question —
 * nothing in the prompt set asks a planner to write one — so a card dropped into the
 * RESEARCHER column arrives with nothing to work on. The column remains available as an
 * opt-in for boards that use it deliberately.
 */
export const DEFAULT_KANBAN_COLUMN_AGENTS: Record<string, boolean> = {
    researcher: false,
};

/**
 * THE column-visibility predicate. Three call sites reimplemented this against
 * `visibleAgents` alone and two of the three carried the occupied-column escape hatch
 * while the third did not; a fourth input across three divergent copies is how panels
 * end up disagreeing about the same board.
 *
 * `occupiedColumnIds` keeps a column rendered while it still holds cards, so switching a
 * column off can never strand work.
 */
export function isKanbanColumnEnabled(
    column: KanbanColumnDefinition,
    visibleAgents: Record<string, boolean>,
    kanbanColumnAgents: Record<string, boolean>,
    occupiedColumnIds: Set<string>
): boolean {
    if (column.featureOnly) { return occupiedColumnIds.has(column.id); }
    if (!column.role) { return true; }
    // Custom agents already carry their own includeInKanban flag; this resolver governs
    // built-in columns only.
    if (column.source !== 'built-in') { return true; }
    const explicit = kanbanColumnAgents[column.role];
    const fallback = DEFAULT_KANBAN_COLUMN_AGENTS[column.role];
    const enabled = explicit !== undefined
        ? explicit
        : (fallback !== undefined ? fallback : visibleAgents[column.role] !== false);
    return enabled || occupiedColumnIds.has(column.id);
}
```

### 2. Config plumbing — a machine-global sibling of `visibleAgents`

- `src/services/GlobalIntegrationConfigService.ts`
  - add `'kanbanColumnAgents'` to `AgentGlobalKey` and to the `agents` shape;
  - add it to the wipe-guard branch and to the key-counting branch beside `visibleAgents`:

```ts
-        if (key === 'visibleAgents') return Object.keys(value as object).length;
+        if (key === 'visibleAgents' || key === 'kanbanColumnAgents') return Object.keys(value as object).length;
```

```ts
-        if (key === 'startupCommands' || key === 'visibleAgents') {
+        if (key === 'startupCommands' || key === 'visibleAgents' || key === 'kanbanColumnAgents') {
```

- `src/services/stateConfigBridge.ts`

```ts
-const AGENT_GLOBAL_FILE_KEYS = new Set<string>(['startupCommands', 'visibleAgents', 'customAgents']);
+const AGENT_GLOBAL_FILE_KEYS = new Set<string>(['startupCommands', 'visibleAgents', 'customAgents', 'kanbanColumnAgents']);
```

```ts
     visibleAgents: 'agents.visibleAgents',
+    kanbanColumnAgents: 'agents.kanbanColumnAgents',
```

  and the matching entry in `KanbanDatabase._runConfigMigrations`, per the note on
  `STATE_KEY_TO_CONFIG` ("add here AND in ...").

- `src/services/TaskViewerProvider.ts` — a reader mirroring `getVisibleAgents`'s three-tier
  lookup (global file → globalState → state.json), returning `{}` when absent so the
  resolver's inherit arm engages:

```ts
    public async getKanbanColumnAgents(workspaceRoot?: string): Promise<Record<string, boolean>> {
        const fileValue = await GlobalIntegrationConfigService.getAgentConfig<Record<string, boolean>>('kanbanColumnAgents');
        if (fileValue !== undefined) { return { ...fileValue }; }
        const globalValue = this._context.globalState.get<Record<string, boolean>>('switchboard.agents.kanbanColumnAgents');
        if (globalValue !== undefined) { return { ...globalValue }; }
        // Absent everywhere: return empty so isKanbanColumnEnabled inherits visibleAgents.
        // Do NOT seed defaults here — the defaults belong in DEFAULT_KANBAN_COLUMN_AGENTS
        // so an explicit user `true` can be told apart from an unset key.
        return {};
    }
```

### 3. The three column filters call the resolver

- `KanbanProvider._filterDynamicColumns` gains a `kanbanColumnAgents` parameter and its body
  becomes `columns.filter(col => isKanbanColumnEnabled(col, visibleAgents, kanbanColumnAgents, occupiedColumns))`.
  Both call sites (`refreshWithData` and the second one further down) fetch the map alongside
  `_getVisibleAgents`.
- `TaskViewerProvider._filterVisibleColumns` same, and **gains the occupied-column escape
  hatch it currently lacks** — it must be passed the card set at its call site.
- `PlanningPanelProvider._resolveColumns` same; it reads the flag from state alongside
  `visibleAgents`, with the same defaults merge.

### 4. `src/webview/kanban.html` — the checkbox

Add a second checkbox per agent row. The label column is already `min-width:70px` and the
command input is `flex:1`, so the new control goes between them at fixed width.

```html
          <div class="startup-row">
            <input type="checkbox" class="agents-tab-visible-toggle" data-role="researcher" style="width:auto;margin:0;flex-shrink:0;">
            <label style="min-width:70px;">Researcher</label>
            <label class="agents-tab-column-label" title="Show this agent's column on the Kanban board. Independent of whether the agent's terminal is available.">
              <input type="checkbox" class="agents-tab-column-toggle" data-role="researcher" style="width:auto;margin:0;flex-shrink:0;">
              board column
            </label>
            <input type="text" data-role="researcher" id="agents-tab-cmd-researcher" placeholder="e.g. claude" style="flex:1;">
          </div>
```

Repeat for every built-in agent row that has a column role (`planner`, `lead`, `coder`,
`intern`, `reviewer`, `tester`, `ticket_updater`, `researcher`). Rows with no column role
(`analyst`, `jules`, `project_manager`, `claude_artifacts`, `phone_a_friend`) get no second
checkbox — a column toggle for an agent with no column is a dead control.

Collector and hydrator:

```js
        function agentsTabCollectConfig() {
          const commands = {}, visibleAgents = {}, kanbanColumnAgents = {};
          …
          document.querySelectorAll('#agents-tab-content .agents-tab-column-toggle, #teams-tab-content .agents-tab-column-toggle').forEach(cb => {
            if (cb.dataset.role) kanbanColumnAgents[cb.dataset.role] = cb.checked;
          });
          return { commands, visibleAgents, kanbanColumnAgents, … };
        }
```

The existing autosave binding already covers `#agents-tab-content input[type="checkbox"]`,
so the new controls save on change with no extra wiring.

In the `visibleAgents` / `startupCommands` inbound handlers, hydrate the new toggles from
`msg.kanbanColumnAgents`, applying the same resolution as the backend so the checkbox shows
the *effective* state rather than an unset blank:

```js
                  document.querySelectorAll('#agents-tab-content .agents-tab-column-toggle').forEach(cb => {
                    const role = cb.dataset.role;
                    if (!role) { return; }
                    const explicit = (msg.kanbanColumnAgents || {})[role];
                    const fallback = DEFAULT_KANBAN_COLUMN_AGENTS[role];
                    cb.checked = explicit !== undefined
                      ? explicit
                      : (fallback !== undefined ? fallback : vis[role] !== false);
                  });
```

with `const DEFAULT_KANBAN_COLUMN_AGENTS = { researcher: false };` declared once in the
panel script and kept in step with `agentConfig.ts` by a contract test (there is precedent:
`KANBAN_ROLE_ORDER_FALLBACK` in `terminals.js` is already pinned to
`DEFAULT_KANBAN_COLUMNS` by a test).

### 5. Save path and Restore Defaults

- `TaskViewerProvider._saveStartupCommands` persists `msg.kanbanColumnAgents` through the
  same `updateState` batch that writes `visibleAgents`, so it lands in the machine-global
  file via the bridge.
- `handleRestoreKanbanDefaults` writes a non-empty defaults patch for the new key too:

```ts
        const columnDefaults: Record<string, boolean> = {};
        for (const role of builtInColumnRoles) {
            columnDefaults[role] = role in DEFAULT_KANBAN_COLUMN_AGENTS
                ? DEFAULT_KANBAN_COLUMN_AGENTS[role]
                : (role in defaultVisibility ? defaultVisibility[role] : true);
        }
```

  — a defaults patch, never a key deletion, for the same wipe-guard reason the existing
  comment gives.

## Verification Plan

1. **Upgrade is a no-op except Researcher.** Take a `~/.switchboard` config from before the
   change with `visibleAgents.researcher = true` and, separately, one with
   `visibleAgents.reviewer = false`. Load each. Expect: the RESEARCHER column **gone** in the
   first (the reported ask), and the Reviewer column still **hidden** in the second (the
   inherit arm carrying an explicit `false`). Every other column unchanged in both.
2. **Fresh install.** No config at all. Board renders exactly the columns it renders today.
3. **The split works.** Check `Researcher` visibility, leave `board column` unchecked. Expect
   the Researcher terminal in the terminals picker and in `OPEN AGENT TERMINALS`, and **no**
   RESEARCHER column on the board.
4. **The hand-off still works.** With that configuration, open a Researcher terminal, run a
   planner, and confirm the planner's prompt still contains the RESEARCHER HAND-OFF section
   and that a `POST /research/dispatch` reaches the terminal (`{"dispatched": true}`). This
   is the assertion that the column flag did not leak into `researcherConfigured`.
5. **Opt in.** Tick `board column` for Researcher. Column appears without a reload (the save
   marks config dirty and the next refresh rebuilds columns).
6. **Occupied column is never hidden.** With cards sitting in RESEARCHER, untick `board
   column`. Expect the column to remain rendered. Move the last card out; expect the column
   to disappear on the next refresh.
7. **Setup panel parity.** Confirm the Setup panel's Kanban-structure list agrees with the
   board — this is the filter that previously lacked the occupied-column arm, so an occupied
   hidden column must now appear in both.
8. **Planning panel parity.** Confirm the Planning panel's column list agrees with the board
   for all three configurations above. Three panels, one answer.
9. **Restore Kanban Defaults.** With Researcher's column ticked and Reviewer's unticked, run
   Restore Defaults. Expect Reviewer back, Researcher's column gone, and the written config
   to contain a non-empty `kanbanColumnAgents` patch (not deleted keys).
10. **Wipe guard.** Save an all-false `kanbanColumnAgents` from the Agents tab, then trigger a
    save from a surface that sends `{}`. Expect the console guard line and the stored value
    preserved.
11. **Both hosts.** Repeat steps 3, 5 and 6 under the standalone host and the VS Code
    extension host. Expect identical boards.
12. **Contract test.** Add an assertion that the webview's `DEFAULT_KANBAN_COLUMN_AGENTS`
    literal matches the exported map in `agentConfig.ts`, wired into
    `.github/workflows/integration-tests.yml` so it cannot land defined-but-unrun.
13. `npm run compile-tests` clean; `node --check` clean for the changed webview.
