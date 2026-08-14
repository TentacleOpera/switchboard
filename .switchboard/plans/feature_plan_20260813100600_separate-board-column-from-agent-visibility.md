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
- *"Render this agent's Kanban column"* — read by several separate column filters, all keyed
  on the same map:

```ts
// KanbanProvider._filterDynamicColumns (KanbanProvider.ts:3924-3936)
return columns.filter(col => {
    if (col.featureOnly) return occupiedColumns.has(col.id);
    if (!col.role) return true;
    if (visibleAgents[col.role] !== false) return true;
    return occupiedColumns.has(col.id);
});
```

```ts
// TaskViewerProvider._filterVisibleColumns (TaskViewerProvider.ts:4187-4199)
if (column.source === 'built-in' && column.role && visibleAgents[column.role] === false) {
    return false;
}
```

```ts
// PlanningPanelProvider._getKanbanColumnDefinitions (PlanningPanelProvider.ts:7331-7338)
if (visibleAgents[col.role] !== false) return true;
return occupiedColumns.has(col.id);
```

> **Superseded:** the third copy lives in `PlanningPanelProvider._resolveColumns`, and there
> are exactly three copies.
> **Reason:** Both halves are wrong, and each would have cost the implementer a search or a
> missed site. (a) There is **no `_resolveColumns` method** in `PlanningPanelProvider` — the
> predicate lives at the tail of `_getKanbanColumnDefinitions` (`PlanningPanelProvider.ts:7289`,
> filter at `:7331-7338`). (b) There is a **fourth** copy: `TaskViewerProvider._buildSetupKanbanStructure`
> (`:4201-4234`) calls `_filterVisibleColumns` and *then independently recomputes the same
> predicate inline* to populate each item's `visible` field (`:4211-4216`). That inline copy is
> what the Setup panel's checkbox state and the terminals kanban-pane picker actually read.
> **Replaced with:** four copies, at `KanbanProvider._filterDynamicColumns` (`:3924`),
> `TaskViewerProvider._filterVisibleColumns` (`:4187`), `TaskViewerProvider._buildSetupKanbanStructure`'s
> inline `visible` computation (`:4211-4216`), and `PlanningPanelProvider._getKanbanColumnDefinitions`
> (`:7331-7338`). All four must route through the extracted resolver.

The Agents tab exposes exactly one checkbox per role to feed it
(`.agents-tab-visible-toggle` in `kanban.html:3011-3052`), and the collector reads that one
class (`kanban.html:4765-4767`):

```js
document.querySelectorAll('#agents-tab-content .agents-tab-visible-toggle, …').forEach(cb => {
    if (cb.dataset.role) visibleAgents[cb.dataset.role] = cb.checked;
});
```

So "I want a Researcher terminal so my planners can hand off to it" and "I want a
RESEARCHER column on my board" are the same checkbox, and there is no way to express the
first without the second.

`researcher` ships `false` in every defaults map (`TaskViewerProvider._defaultVisibleAgents`
at `:6205-6220`, `KanbanProvider._getVisibleAgents`, and `PlanningPanelProvider`'s own inline
`visibleAgentDefaults` at `:7294-7298`), which is why the column is absent on a fresh install
— and why turning the terminal on is what makes it appear.

### The coupling runs further than the board — two live symptoms in `terminals.js`

Discovered while tracing this plan against `src/`, and both are in scope: they are the same
"one flag, two meanings" defect, and the fix for the board is what surfaces them.

1. **Hiding a column demotes that agent's TERMINAL in the sidebar.** `recomputeRoleOrderMap`
   (`terminals.js:4821-4832`) rebuilds `roleOrderMap` from `kanbanColumnsCache` — the
   *filtered* column structure — and **replaces** rather than merges:
   `roleOrderMap = Object.keys(next).length > 0 ? next : { ...KANBAN_ROLE_ORDER_FALLBACK }`.
   Its own comment states the consequence: *"a hidden role loses its weight and falls to the
   alphabetical tail."* `roleOrderMap` is the sort key for `compareTerminals`
   (`terminals.js:2999-3018`, the sidebar terminal list) and for the FILL GRID role picker
   (`terminals.js:872-880`). So unchecking a board column would silently reorder the
   terminal list — precisely the "the terminal is unaffected" guarantee this plan sells.
   This is already broken today for any hidden agent; this plan makes it reachable through a
   control whose entire promise is that it does *not* touch the terminal.

2. **A pane pinned to a vanished column gets a blank picker.** The terminals kanban pane
   builds its column picker from `POST /kanban/verb/getKanbanStructure`
   (`terminals.js:5536-5541` → `buildColumnList`), which resolves to
   `TaskViewerProvider.handleGetKanbanStructure` (`:6301-6311`) →
   `_buildSetupKanbanStructure` → `_filterVisibleColumns`. When a column disappears from
   that structure, `terminals.js:5133`'s `if (chosen && picker.value !== chosen) { picker.value = chosen; }`
   silently misses (assigning a non-existent `<option>` value blanks a `<select>`), leaving a
   blank picker over a list still fetching the now-hidden column. The pane's existing snap
   logic (`terminals.js:4986-5004`) handles only the aggregate-column case, not a column
   removed outright. `DEFAULT_KANBAN_COLUMN_AGENTS.researcher = false` turns this from a
   theoretical path into an **upgrade-triggered** one for every user who had a Researcher
   terminal on and a pane pinned to RESEARCHER.

   This is the same failure mode the sibling subtask documents as its own root cause #4
   (`runSheetSelect.value = X` missing against a differently-scoped option set), one function
   over in the same file. The sibling plan explicitly defers the fix here, because this plan
   introduces the trigger.

### Background context

- `visibleAgents` is **machine-global**, stored under `~/.switchboard` via
  `GlobalIntegrationConfigService` (`AgentGlobalKey`, `:63`), mirrored through
  `stateConfigBridge`'s `STATE_KEY_TO_CONFIG` as `agents.visibleAgents` (`:31`) with
  `AGENT_GLOBAL_FILE_KEYS` routing (`:14`), and protected by a wipe guard that refuses an
  empty overwrite (`GlobalIntegrationConfigService:504-510`). Any sibling key must join all
  three.
- `stateConfigBridge` exports `stateFs`, a facade that synthesises a `state.json` view from
  the config table plus the machine-global file. `PlanningPanelProvider` imports it as `fs`
  (`PlanningPanelProvider.ts:20`), so its `readFile(statePath)` at `:7290` does reach the real
  values — adding the new key to both bridge sets makes it visible there with no extra read
  path. (Worth stating because `KanbanDatabase`'s own comment notes `state.json` no longer
  exists on disk; that applies to modules importing the *real* `fs`, not to this one.)
- The existing `occupiedColumns.has(col.id)` escape hatch in two of the four copies means
  a column that still holds cards is rendered regardless of the flag. That is what keeps
  hiding a column from stranding work, and it must be preserved verbatim.
- This extension is published with roughly 4,000 installs, many on older versions. A new
  flag that defaults to "off" for everything would delete every user's board columns on
  upgrade. The default resolution below is written specifically to make the upgrade a no-op
  for every role except the one the report names.

## Metadata

- **Complexity:** 7
- **Tags:** backend, frontend, ui, ux, feature, refactor
- **Project:** Browser Switchboard
- **Feature:** 6b06d0de-d630-4f6a-af61-3fb213772c15

> **Superseded:** **Complexity:** 6.
> **Reason:** The score predated three findings that each widen the blast radius: the
> predicate has **four** copies rather than three (one of them an undocumented inline
> recomputation feeding two separate surfaces); `_filterDynamicColumns` has **four** call
> sites (`KanbanProvider.ts:1197, 2044, 3604, 3815`), not two, each needing the new map
> threaded in; and the coupling extends into `terminals.js` in two places that this plan must
> now also fix. The change now spans ~10 files, both hosts, a published-install migration, and
> an extract-and-converge refactor over divergent copies — that is a 7, and it routes to Lead
> Coder rather than Coder.
> **Replaced with:** **Complexity:** 7.

## User Review Required

- None.

## Complexity Audit

**Complex.** Small per site, but the sites are spread across the config plumbing, four
duplicated column filters, two hosts, two webviews, and a published install base.

- **Migration is the risk, not the logic.** Getting the default resolution wrong ships a
  board with missing columns to thousands of installs. The rule below (`inherit
  visibleAgents unless the role has an explicit column default`) makes the upgrade provably
  a no-op except for `researcher`.
- **Four copies of the same predicate, and they already disagree.**
  `KanbanProvider._filterDynamicColumns` and `PlanningPanelProvider._getKanbanColumnDefinitions`
  carry both the `featureOnly` arm and the `occupiedColumns` escape hatch;
  `TaskViewerProvider._filterVisibleColumns` carries neither but adds a `fixed`
  (CREATED/COMPLETED) arm the others don't need; and `_buildSetupKanbanStructure` recomputes
  a fifth variant inline. Adding a fourth input to four divergent copies is how a board ends
  up disagreeing with itself between panels. Extract one resolver in `agentConfig.ts` and
  have all four call it.
- **Four call sites to thread.** `_filterDynamicColumns` is invoked at `KanbanProvider.ts:1197,
  2044, 3604, 3815`. Each must fetch `kanbanColumnAgents` alongside `_getVisibleAgents`. A
  missed site produces a board that flips its column set depending on which refresh path ran.
- **Two hosts.** The standalone bootstrap and the extension host both read agent config; a
  key added to one and not the other produces a board that differs by host.
- **Two webviews.** `kanban.html` owns the new checkbox; `terminals.js` consumes the filtered
  structure and must stop mis-handling a vanished column.

### Routine

- Adding a key to three allowlist/map literals (`AgentGlobalKey`, `AGENT_GLOBAL_FILE_KEYS`,
  `STATE_KEY_TO_CONFIG`) and two `||` branches in the wipe guard.
- Adding one checkbox to eight existing single-line `.startup-row` divs in `kanban.html`.
- A one-word change in `recomputeRoleOrderMap` (replace → merge over the fallback).

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

   **Implementation note — `??` is the wrong operator in code.** The pseudo-rule above reads
   as `??` but must be written as explicit `!== undefined` checks. `false ?? x` is `false`,
   which is what we want, but the reader must not later "simplify" it to `||`, under which a
   user's deliberate `false` would fall through to `true` and un-hide every column they hid.
   The resolver in Proposed Change 1 is written with explicit checks for exactly this reason.

2. **A user who deliberately hid a column** (e.g. unchecked `reviewer`) keeps it hidden —
   the inherit arm carries their `false` through. This is the case a naive `?? true` default
   would break.

3. **Cards already in RESEARCHER.** The `occupiedColumns.has(col.id)` arm keeps the column
   rendered while it holds cards, so turning the column off never strands work. Preserve
   that arm in the extracted resolver, and **add** it to
   `TaskViewerProvider._filterVisibleColumns`, which today lacks it — that filter feeds the
   Setup panel's Kanban-structure view *and* the terminals kanban-pane picker, where a
   hidden-but-occupied column should still be listed.

4. **The Researcher terminal is unaffected.** Unchecking the column must leave the terminal
   in the picker, in `OPEN AGENT TERMINALS`, **at its usual position in the terminal sidebar**
   (see the `roleOrderMap` fix, Proposed Change 6) and — critically — on the
   `/research/dispatch` hand-off, which resolves the researcher from the live fleet and never
   consults column config. Verify explicitly; this is the whole point of the split.

5. **`researcherConfigured` in the planner prompt.** `agentPromptBuilder` chooses between
   `ADVISE_RESEARCH_DIRECTIVE` and `ADVISE_RESEARCH_DIRECTIVE_NO_RESEARCHER`
   (`agentPromptBuilder.ts:1352`) based on `options.researcherConfigured`, which
   `KanbanProvider.ts:5009` resolves via `TaskViewerProvider.isResearcherConfigured()`. That
   method calls `_getAgentNameForRole('researcher')`, which resolves an agent **name** from
   registered terminals / chat agents (`_getAgentNameForRoleGlobal` scans `state.terminals`
   then `state.chatAgents`) — it does not read `visibleAgents` and cannot read the new map.
   So the split is structurally safe here rather than merely intended. Do not "helpfully"
   route it through the new flag; a workspace with a Researcher terminal and no Researcher
   column must still get the hand-off directive. Verified by UAT step 4 regardless.

6. **Custom agents.** `CustomAgentConfig` already has its own `includeInKanban` boolean and
   its own `kanbanOrder`. Custom agents therefore already have this split, and the new key
   must not shadow it: the resolver applies to `source === 'built-in'` columns only; custom
   agent columns keep answering to `includeInKanban`.

7. **Restore Kanban Defaults.** `handleRestoreKanbanDefaults` (`TaskViewerProvider.ts:10999-11046`)
   derives `builtInColumnRoles` from `buildKanbanColumns([])`, builds a `resetPatch` over
   `_defaultVisibleAgents()`, writes it into state, and then persists it with
   `mergeVisibleAgentsToGlobalFile(resetPatch)` (`:11036`) — explicitly a defaults **patch**,
   never a key deletion, because an empty remainder is refused by the wipe guard. It must do
   the same for the new key, which means a sibling
   `mergeKanbanColumnAgentsToGlobalFile` alongside the existing merger
   (`TaskViewerProvider.ts:26099-26118`) — or Restore Defaults will silently leave stale
   column overrides behind.

8. **Wipe guard.** `agentConfigMeaningfulCount` (`GlobalIntegrationConfigService.ts:491-496`)
   special-cases `visibleAgents` to count keys (an all-false map is intentional config). The
   new key has identical semantics and needs the same branch, plus the same entry in the
   guard's key list at `:510`, or an all-false map would be counted as zero and refused.

9. **Drag/drop into a hidden column.** Not reachable — a hidden column renders no drop
   target. Existing cards in it are still moved out normally via the card menu.

10. **Autoban / orchestration.** Column *definitions* are unchanged; only rendering is
    filtered. Any automation that names `RESEARCHER` by id keeps working.
    `DEFAULT_KANBAN_COLUMNS` (`agentConfig.ts:147-158`) is a *display order* list and
    tolerates the column being filtered out — confirmed: `buildKanbanColumns` sorts by
    `order` and every consumer filters afterwards.

11. **`featureOnly` is currently vacuous — do not let that mislead you.** Nothing sets it:
    no entry in `DEFAULT_KANBAN_COLUMNS` carries it, and `buildKanbanColumns`'s custom-column
    mapping (`agentConfig.ts:495-506`) does not emit it. The interface declares it
    (`agentConfig.ts:128`) and four sites consume it. Consequence: adding the `featureOnly`
    arm to `_filterVisibleColumns` (which lacks it today) is **behaviour-preserving right
    now**, but it is a real semantic addition — a future featureOnly column would start
    hiding from the Setup structure list when empty. That is the intended, consistent
    behaviour; it is called out so it is a decision rather than an accident.

12. **`_filterVisibleColumns`'s `fixed` arm must survive.** It returns `true` early for
    `CREATED` and `COMPLETED` (`TaskViewerProvider.ts:4191-4192`). The extracted resolver
    reaches the same answer by a different route (`if (!column.role) return true` — neither
    column has a role), so the arm is redundant *given the resolver*, but it must not be
    dropped in the same change that introduces the resolver: those two columns are the
    board's fixed anchors and a regression there is a dead board. Keep the explicit `fixed`
    check in front of the resolver call.

13. **Readers of `visibleAgents` that must NOT be switched.** The coder will grep
    `visibleAgents` and find more than the four filters. These are agent-identity decisions,
    not column-visibility decisions, and are explicitly **out of scope**:
    - `kanban.html`'s `updateAllColumnAgents()` — renders "No agent assigned" under a column
      header when `lastVisibleAgents[role] === false`. That subline is about the *agent*, and
      an enabled column whose agent is hidden should still say so.
    - `KanbanDatabase._resolveAgentForColumn` (`:8933-8960`) — resolves the agent display name
      for the exported local board mirror, with its own hardcoded default list
      `['tester','researcher','jules','ticket_updater']`. Same reasoning.
    - `terminals.js`'s `fetchPtyVisibleRoles` consumers and `extension.ts`'s `createAgentGrid`
      — the terminal side of the split, which is the half we are preserving.

14. **Only one inbound handler hydrates the checkboxes.** `kanban.html`'s
    `case 'visibleAgents'` (`:9063-9069`) updates `lastVisibleAgents` and repaints the column
    agent sublines — it does **not** touch the checkbox DOM. `case 'startupCommands'`
    (`:9214-9243`) is the one that sets `cb.checked` (`:9219-9221`). So the new toggles hydrate
    there, and the payload must carry the new map: `type: 'startupCommands'` is spread from
    `handleGetStartupCommands()`'s return at six push sites
    (`TaskViewerProvider.ts:6805, 6846, 13150`; `KanbanProvider.ts:11008`;
    `SetupPanelProvider.ts:679`; `setupService.ts:44`), so adding the field to that one
    method's return propagates everywhere for free.

15. **Autosave needs no new wiring.** The change binding at `kanban.html:4784-4786` already
    covers `#agents-tab-content input[type="checkbox"]`, so a new checkbox saves on change
    automatically — provided the collector picks it up.

16. **`handleSaveStartupCommands` filters by type.** `TaskViewerProvider.ts:10785-10790`
    builds `visibleAgentsPatch` by `Object.entries(...).filter(([, v]) => typeof v === 'boolean')`,
    and leaves it `undefined` when the field is absent. The new key must follow the same
    shape exactly — including the `undefined`-when-absent behaviour, so a save from a surface
    that doesn't render the new checkboxes (the Setup panel posts to the same handler,
    `SetupPanelProvider.ts:670`) does not wipe the map.

## Dependencies

- **Ordering only — land after the sibling subtask.** Both this plan and *"Terminals kanban
  pane: the per-row `link` button is inert"* edit `src/webview/terminals.js`. The PRD's
  orchestration discipline is "one agent stream per provider file", so they must serialise.
  The sibling is the smaller, self-contained change and does not depend on anything here;
  this plan's `terminals.js` edits (Proposed Change 6) are in a different region of the file
  and are straightforward to apply on top.

## Adversarial Synthesis

**Risk Summary.** The logic is small; the risk is entirely in coverage and defaults. Getting
the default resolution wrong — writing `||` where `!== undefined` is meant, or defaulting the
new map to `true` — deletes board columns across ~4,000 installs, so the resolver is written
with explicit checks and a per-role override map that leaves every non-`researcher` role
inheriting exactly what it had. The second risk is a partial extraction: the predicate has
four copies (one of them an undocumented inline recomputation) and `_filterDynamicColumns`
has four call sites, so a change that converts "the three filters" leaves the board and the
Setup/terminals structure disagreeing about the same column. The third is scope leakage in
the opposite direction — this plan's whole promise is that the terminal is untouched, and two
`terminals.js` sites currently break that promise (`roleOrderMap` demotes a hidden role's
terminal in the sidebar; a pane pinned to a vanished column renders a blank picker), both now
in scope and both fixed here.

## Proposed Changes

> **Line numbers were re-anchored against `src/` at planning time.** Anchor on the quoted
> code, not the number, if a file has moved.

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
 * THE column-visibility predicate. Four call sites reimplemented this against
 * `visibleAgents` alone and they had already diverged — two carried the occupied-column
 * escape hatch and the featureOnly arm, one carried neither, and a fourth recomputed a
 * variant inline. A fourth input across four divergent copies is how panels end up
 * disagreeing about the same board.
 *
 * `occupiedColumnIds` keeps a column rendered while it still holds cards, so switching a
 * column off can never strand work.
 *
 * NOTE the explicit `!== undefined` checks. Do NOT rewrite this chain with `||`: a user's
 * deliberate `false` would then fall through to the next arm and un-hide a column they hid
 * on purpose — across roughly 4,000 published installs.
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

**Edge Cases.** A caller with no card set passes an empty `Set` — the escape hatch then never
fires, which is correct for surfaces that have no card context. A custom-user column returns
`true` unconditionally and never consults either map.

### 2. Config plumbing — a machine-global sibling of `visibleAgents`

- `src/services/GlobalIntegrationConfigService.ts`
  - extend `AgentGlobalKey` (`:63`) and the `agents` shape (`:56-57`);
  - add it to the key-counting branch (`:495`) and the wipe-guard key list (`:510`):

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

  and the matching entry in `KanbanDatabase._runConfigMigrations` (`:5671`), per the note on
  `STATE_KEY_TO_CONFIG` ("add here AND in ..."). Adding both bridge entries is also what makes
  the key visible to `PlanningPanelProvider`, which reads through the `stateFs` facade
  (`PlanningPanelProvider.ts:20`) rather than the real `fs` — no separate read path needed there.

- `src/services/TaskViewerProvider.ts` — a reader mirroring `getVisibleAgents`'s three-tier
  lookup (global file → globalState → state), returning `{}` when absent so the resolver's
  inherit arm engages:

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

### 3. The four column filters call the resolver

- **`KanbanProvider._filterDynamicColumns`** (`:3924`) gains a `kanbanColumnAgents` parameter;
  its body becomes
  `columns.filter(col => isKanbanColumnEnabled(col, visibleAgents, kanbanColumnAgents, occupiedColumns))`.
  **All four call sites** must fetch the map alongside `_getVisibleAgents`:
  `KanbanProvider.ts:1197`, `:2044`, `:3604`, `:3815`. Missing one produces a board whose
  column set depends on which refresh path last ran.

- **`TaskViewerProvider._filterVisibleColumns`** (`:4187`) same, and **gains the
  occupied-column escape hatch it currently lacks** — it must be passed the card set at its
  call site. Keep the existing `fixed` (CREATED/COMPLETED) early-return in front of the
  resolver call (audit item 12).

- **`TaskViewerProvider._buildSetupKanbanStructure`** (`:4201-4234`) — the copy the earlier
  pass missed. It calls `_filterVisibleColumns` and then recomputes the predicate inline to
  set each item's `visible` field:

```ts
                const visible = fixed
                    ? true
                    : column.source === 'built-in'
                        ? (!column.role || visibleAgents[column.role] !== false)
                        : true;
```

  Replace that inline expression with the resolver so `visible` cannot disagree with the
  filter that produced the list. This matters twice over: the field drives the Setup panel's
  Kanban-structure display, and the same items are what `handleGetKanbanStructure` (`:6301`)
  returns to the terminals kanban-pane picker.

- **`PlanningPanelProvider._getKanbanColumnDefinitions`** (`:7289`, filter at `:7331-7338`)
  same; it reads the flag from the `stateFs` view alongside `visibleAgents`. Its inline
  `visibleAgentDefaults` map (`:7294-7298`) is a fourth hand-maintained defaults literal that
  already omits `claude_artifacts`, `phone_a_friend` and `project_manager` relative to
  `TaskViewerProvider._defaultVisibleAgents()` (`:6205-6220`). Leave that divergence alone —
  it is pre-existing, out of scope, and none of the omitted roles owns a built-in column — but
  do **not** add a second inline copy of `DEFAULT_KANBAN_COLUMN_AGENTS` beside it; import the
  exported one.

### 4. `src/webview/kanban.html` — the checkbox

Add a second checkbox per agent row. The existing rows are **single-line** `<div class="startup-row">`
elements (`:3011-3052`), not the pretty-printed shape shown below — match the file's actual
formatting when editing. The label column is `min-width:70px` and the command input is
`flex:1`, so the new control goes between them at fixed width. Expanded here for readability:

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

Repeat for every built-in agent row that has a column role. Cross-checked against
`DEFAULT_KANBAN_COLUMNS` (`agentConfig.ts:147-158`), that is exactly eight: `planner`,
`lead`, `coder`, `intern`, `reviewer`, `tester`, `ticket_updater`, `researcher`. Rows with no
column role — `analyst` (`:3035`), `project_manager` (`:3037`), `jules` (`:3048`),
`claude_artifacts` (`:3050`), `phone_a_friend` (`:3052`) — get no second checkbox; a column
toggle for an agent with no column is itself a dead control, which is the contract this whole
feature exists to enforce.

Collector (`kanban.html:4757-4774`):

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

The existing autosave binding (`:4784-4786`) already covers
`#agents-tab-content input[type="checkbox"]`, so the new controls save on change with no
extra wiring.

Hydrate in the **`startupCommands`** inbound handler only (`:9214-9243`) — `case 'visibleAgents'`
(`:9063`) does not touch checkbox DOM (audit item 14). Apply the same resolution as the
backend so the checkbox shows the *effective* state rather than an unset blank:

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
`KANBAN_ROLE_ORDER_FALLBACK` in `terminals.js:6290-6299` is already pinned to
`DEFAULT_KANBAN_COLUMNS` by a test, and carries a comment saying so).

### 5. Save path, read path, and Restore Defaults

- `TaskViewerProvider.handleSaveStartupCommands` (`:10783`) persists `data.kanbanColumnAgents`
  through the same `updateState` batch that writes `visibleAgents`, using the identical
  `typeof value === 'boolean'` filter and `undefined`-when-absent shape (`:10785-10790`) so a
  save from the Setup panel — which posts to the same handler (`SetupPanelProvider.ts:670`)
  and renders no column checkboxes — cannot wipe the map.
- `TaskViewerProvider.handleGetStartupCommands` (`:6314-6330`) adds `kanbanColumnAgents` to its
  returned object. All six `type: 'startupCommands'` push sites spread that return, so the
  webview receives it everywhere with no per-site edit (audit item 14).
- Add `mergeKanbanColumnAgentsToGlobalFile`, a sibling of
  `mergeVisibleAgentsToGlobalFile` (`:26099-26118`) with the same empty-remainder guard.
- `handleRestoreKanbanDefaults` (`:10999-11046`) writes a non-empty defaults patch for the new
  key too, alongside the existing `resetPatch`:

```ts
        const columnDefaults: Record<string, boolean> = {};
        for (const role of builtInColumnRoles) {
            columnDefaults[role] = role in DEFAULT_KANBAN_COLUMN_AGENTS
                ? DEFAULT_KANBAN_COLUMN_AGENTS[role]
                : (role in defaultVisibility ? defaultVisibility[role] : true);
        }
```

  persisted with `await this.mergeKanbanColumnAgentsToGlobalFile(columnDefaults);` next to the
  existing `mergeVisibleAgentsToGlobalFile(resetPatch)` at `:11036` — a defaults patch, never
  a key deletion, for the same wipe-guard reason the existing comment gives.

### 6. `src/webview/terminals.js` — stop the column flag leaking into the terminal side

Two fixes, both consequences of this plan's default and both described under "The coupling
runs further than the board". Land these **after** the sibling subtask's edit to this file.

**6a. `recomputeRoleOrderMap` (`:4821-4832`) — merge over the fallback instead of replacing.**

*Context.* `roleOrderMap` is the sort key for the sidebar terminal list (`compareTerminals`,
`:2999-3018`) and the FILL GRID role picker (`:872-880`). Rebuilding it from the *filtered*
column structure means a role with no rendered column has no weight and sorts to the
alphabetical tail — the function's own comment says so. Turning off a Researcher board column
would therefore move the Researcher *terminal*, which is exactly what this plan promises not
to do.

*Implementation.* `KANBAN_ROLE_ORDER_FALLBACK` (`:6290-6299`) already holds the built-in
weights, mirroring `DEFAULT_KANBAN_COLUMNS`:

```js
-        roleOrderMap = Object.keys(next).length > 0 ? next : { ...KANBAN_ROLE_ORDER_FALLBACK };
+        // Merge, don't replace. A role whose BOARD COLUMN is switched off still has a
+        // TERMINAL, and that terminal must keep its position in the sidebar — the two are
+        // now separate settings. Replacing dropped the weight and sorted the terminal to
+        // the alphabetical tail. Live values still win for any role the structure carries.
+        roleOrderMap = { ...KANBAN_ROLE_ORDER_FALLBACK, ...next };
```

*Edge Cases.* An empty `next` (first paint / failed fetch) yields the fallback, matching
today's behaviour. A custom-agent role absent from the fallback still takes its live weight
from `next`. A built-in role whose column was reordered in Setup still takes the live value,
because `next` is spread last.

**6b. Snap a pane off a column that has vanished from the structure.**

*Context.* `renderKanbanPane` computes `columns` (`:5017-5033`) from the filtered structure,
then at `:5133` does `if (chosen && picker.value !== chosen) { picker.value = chosen; }`.
Assigning a value with no matching `<option>` blanks a `<select>`, so a pane pinned to a
now-hidden column shows an empty picker while `fetchBoardCardsForPane` keeps fetching the
hidden column. The existing snap block (`:4986-5004`) only handles the aggregate-column case.

*Implementation.* Insert immediately after `const columns = …` (ends `:5033`) and before
`const pickerSig = …` (`:5037`):

```js
        // The chosen column can disappear from the structure outright — switching a board
        // column off in the Agents tab removes it from getKanbanStructure, which is what
        // this picker is built from. Without this, `picker.value = chosen` below silently
        // misses (assigning an unmatched value blanks a <select>) and the operator gets an
        // empty picker over a list still fetching the hidden column. CREATED is never
        // filterable — it has no role, so every column filter returns it unconditionally.
        if (structureLanded && chosen && !columns.some(c => c.id === chosen)) {
            kanbanPaneColumn[index] = 'CREATED';
            chosen = 'CREATED';
            kanbanPaneCards[index] = [];
            saveLayoutSettings();
            // Deferred for the same reason as the aggregate snap above: this render can be
            // running inside fetchBoardCardsForPane's response handler, where a direct call
            // is swallowed by the in-flight guard.
            setTimeout(() => fetchBoardCardsForPane(index), 0);
        }
```

*Edge Cases.* Gated on `structureLanded` so the pre-structure fallback — which synthesises a
one-item list from `chosen` (`:5010-5015`) — cannot trip it. The aggregate id is already
handled by the earlier snap block, and when `aggregateOffered` is true the aggregate is a
member of `columns`, so this arm does not fire for it. `chosen` must be declared with `let`
(it already is, `:4958`).

### 7. Contract test

Add an assertion that the webview's `DEFAULT_KANBAN_COLUMN_AGENTS` literal matches the
exported map in `agentConfig.ts`, following the existing `KANBAN_ROLE_ORDER_FALLBACK` ↔
`DEFAULT_KANBAN_COLUMNS` precedent, and wire it into
`.github/workflows/integration-tests.yml` so it cannot land defined-but-unrun. Add a second
assertion that `isKanbanColumnEnabled` is the only implementation of the predicate — i.e.
that no provider file still contains a bare `visibleAgents[col.role] !== false` column filter.

## Verification Plan

> **Session directive:** the dispatching prompt carries **SKIP COMPILATION** and **SKIP
> TESTS** — the implementing agent authors the contract test in Proposed Change 7 but does
> not execute the suite or run a TypeScript build. Steps 13-14 are recorded for the user and
> CI. The implementer's gate is the manual UAT.

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
5. **The terminal sidebar order is unchanged (the `roleOrderMap` fix).** With Researcher
   visible and its board column **off**, open several agent terminals including the
   Researcher. Expect the Researcher terminal to sit in its usual position (weight 110, just
   after Planner at 100), **not** demoted to the alphabetical tail. Repeat for a second role
   — turn `tester`'s board column off with the Acceptance Tester terminal open — and confirm
   the same. Check the FILL GRID role dropdown order too.
6. **A pane pinned to a vanished column recovers (the picker fix).** Put a terminals pane in
   kanban mode and select the RESEARCHER column while the column is still on. Now untick
   `board column` for Researcher. Expect the pane to snap to **New (CREATED)** with a
   populated, readable picker and a matching card list — **not** a blank dropdown. Confirm
   the choice persists across a reload (`terminals.kanbanPaneColumn`).
7. **Opt in.** Tick `board column` for Researcher. Column appears without a reload (the save
   marks config dirty and the next refresh rebuilds columns).
8. **Occupied column is never hidden.** With cards sitting in RESEARCHER, untick `board
   column`. Expect the column to remain rendered. Move the last card out; expect the column
   to disappear on the next refresh.
9. **Setup panel parity.** Confirm the Setup panel's Kanban-structure list agrees with the
   board — this is the filter that previously lacked the occupied-column arm, so an occupied
   hidden column must now appear in both, **and its `visible` tick must agree with its
   presence** (the inline recomputation in `_buildSetupKanbanStructure` is the copy that
   could disagree).
10. **Planning panel parity.** Confirm the Planning panel's column list agrees with the board
    for all three configurations above. Four surfaces, one answer.
11. **All four `_filterDynamicColumns` call sites.** Exercise a full board refresh, a
    workspace switch, a project-filter change, and a WS resync in turn, confirming the column
    set is identical each time. A missed call site shows up as a column flickering in or out
    across these paths.
12. **Restore Kanban Defaults.** With Researcher's column ticked and Reviewer's unticked, run
    Restore Defaults. Expect Reviewer back, Researcher's column gone, and the written config
    to contain a non-empty `kanbanColumnAgents` patch (not deleted keys).
13. **Wipe guard.** Save an all-false `kanbanColumnAgents` from the Agents tab, then trigger a
    save from the Setup panel (which sends no column map). Expect the stored value preserved
    and, for a genuinely empty write, the console guard line.
14. **Both hosts.** Repeat steps 3, 6, 7 and 8 under the standalone host and the VS Code
    extension host. Expect identical boards and identical pane behaviour.

### Automated Tests

15. The contract test from Proposed Change 7: webview literal ≡ `agentConfig.ts` export, and
    no residual bare `visibleAgents[col.role] !== false` column filter in any provider.
16. `npm run compile-tests` clean; `node --check` clean for the changed webviews. Per the
    PRD's enforcement section, `npm run verb-returns:check`, `npm run parity:check` and
    `npm run push-routing:check` must stay green — this change adds no verb and no raw
    `postMessage`, so none of the three ceilings should move.

## Resolved Assumptions

Settled from the repo during this pass; do not re-open.

- **Does `researcherConfigured` read any visibility map?** No. `KanbanProvider.ts:5009` →
  `TaskViewerProvider.isResearcherConfigured()` → `_getAgentNameForRole('researcher')`, which
  resolves a name from registered terminals / chat agents (`state.terminals`, then
  `state.chatAgents`). It never consults `visibleAgents`, so it cannot consult
  `kanbanColumnAgents` either. The split is structurally safe here, not merely intended.
- **Does `PlanningPanelProvider` actually see the persisted config, given `state.json` is
  gone from disk?** Yes. It imports `stateFs` from `stateConfigBridge` under the name `fs`
  (`PlanningPanelProvider.ts:20`), so its `readFile(statePath)` goes through the facade that
  synthesises the state view from the config table and the machine-global file. The "state.json
  no longer exists" warning in `KanbanDatabase` applies to modules importing the real `fs`.
- **Is `featureOnly` set anywhere today?** No — not in `DEFAULT_KANBAN_COLUMNS`, and not by
  `buildKanbanColumns`'s custom-column mapping. Only the interface declaration and four
  consumers exist. This is why adding the arm to `_filterVisibleColumns` is behaviour-preserving
  now (audit item 11).
- **Which roles own a built-in column?** Exactly eight — `researcher`, `planner`, `lead`,
  `coder`, `intern`, `reviewer`, `tester`, `ticket_updater` — read off `DEFAULT_KANBAN_COLUMNS`
  (`agentConfig.ts:147-158`). `CREATED` and `COMPLETED` carry no role.
- **Does the terminals kanban pane consume the same filtered structure the Setup panel does?**
  Yes. `terminals.js:5536-5541` posts `/kanban/verb/getKanbanStructure`, which resolves to
  `TaskViewerProvider.handleGetKanbanStructure` (`:6301-6311`) → `_buildSetupKanbanStructure`
  → `_filterVisibleColumns`. Traced end to end; this is the basis for Proposed Change 6b and
  for the ordering constraint with the sibling subtask.

---

**Recommendation: Send to Lead Coder.** Complexity 7 — an extract-and-converge refactor over
four divergent predicate copies and four call sites, plus config plumbing across two hosts, a
default-resolution migration protecting roughly 4,000 published installs, and two `terminals.js`
fixes that keep the terminal side of the split honest. The three failure modes an implementer
could plausibly ship are named above: writing `||` where `!== undefined` is meant, converting
three predicate copies and missing the inline fourth, and leaving `roleOrderMap` replacing
rather than merging so the "your terminal is unaffected" promise quietly fails.
