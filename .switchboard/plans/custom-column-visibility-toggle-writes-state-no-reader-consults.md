# Hiding a Custom Kanban Column Does Nothing — Three Readers Ignore the Key, and the Write Leaks Into the Machine-Global Role Picker

## Metadata

**Complexity:** 6
**Tags:** kanban, columns, visibility, both-hosts, migration, state-namespace
**Project:** Browser Switchboard

## Goal

Make column visibility work for custom columns in both hosts, and stop the toggle writing workspace-scoped column ids into the machine-global **agent role** map. The toggle persists a value three readers structurally ignore; the same write simultaneously leaks the column id into the terminal role picker on every workspace on the machine. Both halves come from one cause — a single flat `visibleAgents` map carrying two different namespaces — and neither is fixable alone.

### Problem analysis and root cause

The Kanban Column Editor offers a visibility toggle on custom columns. It reports success. The column stays visible — immediately, after settle, and after reload. The write lands and every reader discards it.

**Root cause, verified against the tree at HEAD.**

**1. The write is generic and dual-destination.** `TaskViewerProvider.handleToggleKanbanColumnVisibility` (`src/services/TaskViewerProvider.ts:11082-11100`) stores under whatever id it is given, then mirrors that same key into the machine-global agents file:

```ts
// columnId is the role for built-in columns (e.g., 'coder', 'lead')
await this.updateState((state: any) => {
    if (!state.visibleAgents) { state.visibleAgents = {}; }
    state.visibleAgents[columnId] = visible;
});
await this.mergeVisibleAgentsToGlobalFile({ [columnId]: visible });
```

The comment says the quiet part: the parameter is *named* `columnId` but is *documented* as a role. It is reached from `KanbanProvider.ts:11420` for **any** column, custom or built-in. Nothing rejects a custom column id, and nothing stops it reaching the global file.

**2. Three readers, none of which consults the key for a custom column.**

- `_filterVisibleColumns` (`TaskViewerProvider.ts:4187-4200`) — the reader that actually removes a column — drops one only when it is built-in:
  ```ts
  if (column.source === 'built-in' && column.role && visibleAgents[column.role] === false) {
      return false;
  }
  return true;                        // ← custom columns fall through unconditionally
  ```
- `_buildSetupKanbanStructure` (`TaskViewerProvider.ts:4201-4248`) — the reader that reports the checkbox state — hardcodes the flag:
  ```ts
  const visible = fixed ? true
      : column.source === 'built-in' ? (!column.role || visibleAgents[column.role] !== false)
      : true;                         // ← custom columns: always true
  ```
- **`PlanningPanelProvider` (`src/services/PlanningPanelProvider.ts:7332-7340`) is a third reader the earlier analysis missed.** It builds its own `visibleAgents` map from `state.json` over role defaults and filters columns with a *different rule*:
  ```ts
  if (!col.role) return true;                              // ← every custom column, always
  if (visibleAgents[col.role] !== false) return true;
  return occupiedColumns.has(col.id);                      // hidden-but-occupied still shows
  ```

So there are three readers, not two, and they do not merely share a bug — they encode **two different definitions of hidden**. The first two mean "gone". The third means "gone unless it holds cards". Any fix that changes only the first two leaves the plan browser disagreeing with the board about which columns exist.

**3. The write leaks across a namespace boundary into a shipped, machine-global surface.** `mergeVisibleAgentsToGlobalFile` writes into the agents-global `visibleAgents` key, which is the terminal **role** picker's source of truth:

- `GlobalIntegrationConfigService.getPtyVisibleRoles` (`:445-469`) starts from `DEFAULT_VISIBLE_AGENTS`, overlays custom agents, then `Object.assign(visible, fileValue)` — so any key in the file becomes a key in the role map.
- `src/webview/terminals.js:6141` builds the picker as `Object.keys(visible).filter(k => visible[k] !== false && !SYSTEM_ROLES.has(k))`.

A custom column toggled **visible** therefore writes `{ <customColumnId>: true }` into a machine-global file and **surfaces the column id as a selectable agent role in the terminal role picker — in every workspace on the machine**, not only the one that owns the column. This is live today, independent of the visibility bug, and it is a second defect from the same write.

The codebase already knows this class of leak exists. `GlobalIntegrationConfigService.SYSTEM_ONLY_ROLES` (`:439`) exists solely to strip non-user roles that "can leak into the machine-global visibleAgents file via stale config and are preserved by `mergeVisibleAgentsToGlobalFile` (which never removes un-patched keys), so they must be stripped at the read layer." That comment describes this defect's mechanism precisely — it was written about a different set of intruder keys.

**4. Nothing ever cleans the keys up.** `KanbanProvider.cleanupKanbanColumnState` (`:6339-6378`) runs on custom-column change and prunes `kanban.orderOverrides` and `kanban.columnDragDropModes` against the set of valid column ids. It does **not** prune `visibleAgents`. Deleting a custom column therefore leaves its visibility key behind permanently, in both the workspace state and the machine-global file.

**This is not a standalone defect.** All of these sites are in shared services (`TaskViewerProvider`, `KanbanProvider`, `PlanningPanelProvider`, `GlobalIntegrationConfigService`) used by both the extension and the browser host. The doc-parity audit recorded it as a standalone gap (`BRD-089`); that scoping is wrong. It is broken everywhere, and a fix in one host fixes both.

**Why it survived:** the toggle returns `{success: true}` and the write genuinely persists. Every check short of *re-reading the structure and looking at the column* passes. It is the exact shape of defect the parity audits kept classifying as working.

### Migration — this state has shipped

`visibleAgents` is shipped, released state on ~4,000 installs, in two stores (workspace `state.json` and the machine-global agents file). Consequences:

- Installs where a user ever toggled a custom column carry orphan `visibleAgents[<customColumnId>]` keys in both stores, including for columns since deleted. Once readers honour the key, stale entries **become live** — someone who toggled a column months ago and saw nothing happen would find it suddenly hidden after upgrading.
- Keys for `true` toggles are currently polluting the role picker and must be removed from the machine-global file, not merely ignored.
- Unknown/legacy keys unrelated to columns must be preserved, not dropped, by whatever reconciliation runs. The existing wipe guard (`GlobalIntegrationConfigService.setAgentConfig:504-514`) refuses to overwrite a populated `visibleAgents` with an empty one — any migration must work with that guard, not around it.

## User Review Required

None. Decisions taken:

- **Separate the namespaces rather than patching the read layer.** Custom-column visibility moves to its own workspace-scoped state key (e.g. `visibleKanbanColumns`); `visibleAgents` reverts to meaning exactly what its name and the machine-global agents file say — **built-in agent role visibility**, unchanged and byte-compatible per PRD contract #2. The alternative (keep one map, add a second strip-at-read-layer filter beside `SYSTEM_ONLY_ROLES`) was rejected: it leaves the wrong data being written machine-globally and treats the symptom at every future reader. Custom columns are workspace-scoped; their visibility does not belong in a machine-global file at all.
- **Adopt existing stale hidden intent, discard leaked visible intent.** A pre-existing `visibleAgents[<customColumnId>] === false` migrates to the new key and takes effect — the user's expressed intent was to hide the column. A pre-existing `=== true` is the default state and carries no intent, so it is removed from both stores rather than migrated; that is what clears the role-picker pollution. Keys for columns that no longer exist are dropped.
- **The plan browser keeps its occupied-column fallback.** The three readers share one visibility *key resolver*; they do not collapse to one *policy*. `PlanningPanelProvider` showing a hidden-but-occupied column is deliberate — a plan browser that hides a column holding plans makes those plans unreachable. Do not "fix" it into parity with the board.

## Complexity Audit

### Routine

- Extending two conditionals to consult a resolved key.

### Complex / Risky

- **Three readers must change together, and one must change differently.** Fixing `_buildSetupKanbanStructure` alone makes the checkbox render correctly while the column stays on the board, because `_filterVisibleColumns` is what removes it. Fixing the filter alone leaves the checkbox showing the wrong state. Leaving `PlanningPanelProvider` out leaves the plan browser listing columns the board has dropped. All three, with the third keeping its occupied-fallback, or the bug merely changes shape.
- **The keying is inconsistent by design and must stay that way.** Built-in columns key on `column.role`; custom columns have no role and must key on `column.id` — now in a different store. One shared resolver for "where does this column's visibility live" is worth more than three parallel conditionals, and is what stops a fourth reader getting it wrong.
- **Do not touch the built-in path.** It works, it is shipped, and it is the one thing in this area with no defect. PRD contract #2 makes behaviour-preservation on shipped providers non-negotiable.
- **The migration touches a machine-global file shared across workspaces and IDEs.** A migration that runs per-workspace against a machine-global store can race a second window. It must be idempotent and must patch keys rather than rewrite the map wholesale, or the wipe guard will either block it or a concurrent write will lose entries.
- **`CREATED` and `COMPLETED` stay fixed.** They are anchors and must remain visible regardless of state — the `fixed` short-circuit must survive in both `_filterVisibleColumns` and `_buildSetupKanbanStructure`.
- **Hiding a column that holds cards.** The board must not orphan plans sitting in a hidden custom column. The stated behaviour: cards remain in the DB, remain visible in the plan browser (via the occupied-fallback above), and reappear on the board when unhidden. Confirm no read path drops them.
- **Cleanup must be extended, not assumed.** `cleanupKanbanColumnState` prunes two column-keyed maps and not this one. Adding the new key to that prune is what stops orphan accumulation recurring after the migration clears it once.
- **Interaction with next-column resolution.** `standalone-kanban-column-parity-audit.md` owns visibility-aware advance. Once custom columns can genuinely hide, that plan's problem statement widens to include them — link, do not absorb.

## Edge-Case & Dependency Audit

**Race Conditions** — the toggle calls `sendVisibleAgents()` and re-posts setup state, and in standalone additionally re-arms the coalesced full-state push (`PUSH_COALESCE_MS = 40`). All readers must be fixed before the push fires, or the coalesced push re-asserts a visible column ~40 ms later and the fix looks broken. Separately, the machine-global migration can race a second VS Code window — see the idempotence requirement above.

**Security** — none.

**Side Effects** — a column that genuinely hides changes board layout for existing users on upgrade; clearing leaked keys changes the terminal role picker's contents for users who have toggled custom columns. Both are corrections, and both are user-visible. See the migration note.

**Dependencies & Conflicts** — `standalone-kanban-column-parity-audit.md` (visibility-aware next-column resolution) is adjacent; link findings rather than merging the plans. The orphan-write shape here is one of the five shapes `standalone-code-verification-sweep-stubs-and-omissions.md` sweeps for; that sweep is scoped to add findings to this plan rather than open siblings.

## Dependencies

None.

## Implementation

1. Introduce one resolver that answers "where does this column's visibility live" — `visibleAgents[column.role]` for built-in, the new workspace-scoped `visibleKanbanColumns[column.id]` for custom — and route every reader through it.
2. Update `_filterVisibleColumns` (`TaskViewerProvider.ts:4187-4200`) to drop any non-fixed column whose resolved visibility is `false`, regardless of `source`.
3. Update `_buildSetupKanbanStructure` (`TaskViewerProvider.ts:4201-4248`) so `visible` comes from the same resolver instead of hardcoding `true` for custom columns.
4. Update `PlanningPanelProvider`'s column filter (`:7332-7340`) to consult the same resolver for custom columns, **retaining** its `occupiedColumns.has(col.id)` fallback for hidden columns that hold plans.
5. Update `handleToggleKanbanColumnVisibility` (`TaskViewerProvider.ts:11082-11100`) to route custom columns to the new key and to **stop calling `mergeVisibleAgentsToGlobalFile` for them**. Built-in roles keep their current dual write untouched.
6. Write the migration: for each workspace, move `visibleAgents[<customColumnId>] === false` entries to `visibleKanbanColumns`, delete `=== true` entries and entries for columns that no longer exist, and patch the same removals into the machine-global agents file. Idempotent, patch-not-replace, preserving every unrelated key, and compatible with the existing wipe guard.
7. Extend `KanbanProvider.cleanupKanbanColumnState` (`:6339-6378`) to prune the new key against valid column ids, alongside `orderOverrides` and `columnDragDropModes`.
8. Add a regression test that hides a custom column, re-reads the structure, and asserts both the reported `visible` flag and the column's absence from the filtered set — the assertion current code passes vacuously — plus one asserting a custom column id never reaches `getPtyVisibleRoles`' output.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`
- **Context:** `_filterVisibleColumns:4187-4200` and `_buildSetupKanbanStructure:4201-4248` treat custom columns as unconditionally visible; `handleToggleKanbanColumnVisibility:11082-11100` writes column ids into the role map and mirrors them machine-globally.
- **Logic:** Shared visibility-key resolver; honour it in both readers; route custom columns to the workspace-scoped key and drop their machine-global mirror.
- **Edge Cases:** `CREATED`/`COMPLETED` stay fixed; built-in path unchanged; columns holding cards must not orphan them.

### `src/services/PlanningPanelProvider.ts`
- **Context:** `:7332-7340` — third column reader, custom columns always shown, hidden built-ins kept when occupied.
- **Logic:** Consult the shared resolver for custom columns; keep the occupied-column fallback.
- **Edge Cases:** Must not start hiding columns that hold plans — that would make those plans unreachable in the browser.

### `src/services/KanbanProvider.ts`
- **Context:** `cleanupKanbanColumnState:6339-6378` prunes two column-keyed maps, not visibility.
- **Logic:** Prune the new visibility key against valid column ids.

### Migration (new)
- **Logic:** Adopt stale hidden intent, clear leaked visible intent and dead-column keys, in both stores.
- **Edge Cases:** Machine-global store is shared across workspaces/IDEs — idempotent, patch-only, wipe-guard-compatible, unknown keys preserved.

### Regression tests (new)
- **Logic:** (a) hide a custom column → re-read structure → assert `visible: false` **and** absence from the filtered set; (b) assert no custom column id appears in `getPtyVisibleRoles()` output.
- **Edge Cases:** Both must fail against current `main`, or they are not testing the defect.

## Verification Plan

*Per session directive, no compilation or automated-test execution is part of this plan's verification.*

1. Hiding a custom column removes it from the board and it stays removed after reload, in both hosts.
2. Unhiding restores it, with its cards intact.
3. The plan browser continues to list a hidden custom column **while it holds plans**, and stops listing it once empty — the deliberate divergence, confirmed rather than assumed.
4. Built-in role visibility is unchanged — no regression on the path that already worked.
5. `CREATED` and `COMPLETED` remain visible under every combination.
6. Toggling a custom column no longer adds any key to the machine-global agents file, and the terminal role picker contains only roles.
7. On an install carrying a pre-existing `visibleAgents[<customColumnId>]`: a `false` entry results in a hidden column, a `true` entry is gone from both stores, a dead-column entry is gone, and every unrelated key in both maps is intact.
8. Running the migration twice changes nothing the second time.
9. Deleting a custom column leaves no visibility key behind.

## Recommendation

Complexity 6 → **Send to Coder.** The reader changes are small and precisely located. The weight is in changing three readers coherently while deliberately keeping one of them different, and in migrating shipped state out of a machine-global file without tripping the wipe guard or silently activating intent the user recorded months ago.
