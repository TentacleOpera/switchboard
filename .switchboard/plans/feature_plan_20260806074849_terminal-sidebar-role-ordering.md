# Order Terminal Sidebar Rows by Kanban Column Role Instead of Map Insertion Order

## Goal

Make the terminals-panel sidebar list terminals in a stable, meaningful order: grouped by agent role, with roles sequenced by the position of their owning column on the Kanban board. Roles with no Kanban column fall to the end, ordered alphabetically by role (not by terminal name). Exited terminals sink to the bottom of their workspace/worktree group.

### The problem

The sidebar order is currently perceived as random, and it genuinely is unstable — **nothing sorts it anywhere in the chain**. The only `.sort()` call in all 4,368 lines of `src/webview/terminals.js` is at line 2146, and it sorts Kanban columns for the pane picker, not terminals.

The order that reaches the screen is raw `Map` insertion order:

1. `PtyFleetService.list()` (`src/standalone/ptyFleetService.ts:135`) returns `Array.from(this.terminals.values())` — a `Map`, so this is creation order within the current host process lifetime.
2. `ptyListTerminals` (`src/standalone/ptyHost.ts:89`; `src/standalone/bootstrap.ts:1122`) maps that 1:1 with no reordering.
3. `fetchTerminalList()` (`src/webview/terminals.js:690`) assigns `fleetList = data.terminals` verbatim.
4. `renderSidebarList()` (`src/webview/terminals.js:1102`) buckets into parent-workspace groups and worktree subgroups by **appending in `fleetList` order** (lines 1158–1186), then renders those arrays in place.

### Root causes of the "random" feel

Four distinct behaviours perturb insertion order, which is why it reads as random rather than merely chronological:

- **Name↔position correlation is broken by slot reuse.** `PtyFleetService.create()` (lines 76–81) searches for the first *free* `${role}-N`. Kill `claude-2` out of `claude-1/2/3` and the next spawn is named `claude-2` again — but it is `set()` at the **end** of the Map. The operator sees `claude-1, claude-3, claude-2`. This is the largest single contributor.
- **Rename teleports a row to the bottom.** `PtyFleetService.rename()` (lines 159–171) does `this.terminals.delete(name)` then `this.terminals.set(newAlias, handle)`. A Map re-insert appends, so tidying a terminal's name moves its row to the end of the entire list.
- **Natural exit and explicit kill behave differently.** `handle.onExit` (line 103) only flips `status = 'exited'` and leaves the entry in the Map; `kill()` (line 147) deletes it. So dead terminals sit interleaved mid-list indefinitely on one path and vanish on the other.
- **Worktree subgroup order is also first-appearance.** `targetGroup.worktreesMap` (line 1177) is a `Map` keyed by worktree path, populated in `fleetList` order, so subgroup sequence inherits the same instability.

None of this is persisted, so a host restart reshuffles everything again.

### Why the Kanban column is the right ordering key

`getKanbanStructure` already returns exactly what is needed. `TaskViewerProvider._buildSetupKanbanStructure()` (`src/services/TaskViewerProvider.ts:3805-3837`) emits `{ id, label, role, order, visible, source, ... }` per column, built from `_buildKanbanColumnsForWorkspace()` — which folds in custom agent columns, custom user columns, and any drag-reordering the operator has done in Setup. Using it means the sidebar tracks the operator's *actual* board layout, not a hardcoded default.

The role sequence derived from `DEFAULT_KANBAN_COLUMNS` (`src/services/agentConfig.ts:132-143`) at defaults:

| order | column id | role |
| --- | --- | --- |
| 0 | `CREATED` | *(none)* |
| 100 | `PLAN REVIEWED` | `planner` |
| 110 | `RESEARCHER` | `researcher` (after the companion column fix; `90` before it) |
| 180 | `LEAD CODED` | `lead` |
| 190 | `CODER CODED` | `coder` |
| 200 | `INTERN CODED` | `intern` |
| 300 | `CODE REVIEWED` | `reviewer` |
| 350 | `ACCEPTANCE TESTED` | `tester` |
| 9000 | `TICKET UPDATER` | `ticket_updater` |
| 9999 | `COMPLETED` | *(none)* |

Roles with no column — `analyst`, `claude_artifacts`, `phone_a_friend`, `jules_monitor`, `project_manager`, plus any custom role whose column was deleted — form the alphabetical tail.

**Use `column.role`, not `columnToPromptRole()`.** Two column→role mappings exist and they disagree. `KanbanColumnDefinition.role` names the agent that *produces* the column (`PLAN REVIEWED` → `planner`, `LEAD CODED` → `lead`). `columnToPromptRole()` (`src/services/agentPromptBuilder.ts:1816`) names the agent that *consumes* it (`PLAN REVIEWED` → `lead`, `LEAD CODED` → `reviewer`). The desired sidebar order is planner → lead → coder → intern → reviewer, which is the **producer** mapping. Do not use `columnToPromptRole` here.

### No per-role exceptions

Every role's rank comes from its column's `order`. There are no special cases in the comparator.

An earlier draft of this plan pinned `researcher` after `planner` as an exception, because `RESEARCHER` sits at `order: 90` — ahead of `PLAN REVIEWED`/`planner` at 100 — which put researcher terminals at the top of the sidebar. That column position is itself a bug: research is triggered *by* the planner and feeds *into* coding, so the column belongs between Planned and Lead Coder. It is fixed at source in the companion plan **"Fix Researcher Column Position and Forward Flow"**, which re-weights `RESEARCHER` to 110.

**Dependency:** land the Researcher column fix first. Once it is in, this plan produces `planner → researcher → lead → …` with no workaround. If the sidebar ships first, researcher terminals will sort to the top until the column fix lands — cosmetic and self-correcting, not a blocker. Do not add a comparator exception to paper over the gap.

### Column reordering (Setup → Kanban structure)

Reordering columns in Setup is a **slot permutation, not a renumbering**. `_projectVisibleKanbanWeights()` (`TaskViewerProvider.ts:3871-3890`) takes the `order` values of the currently visible reorderable columns, sorts them ascending, and reassigns them positionally to the dragged sequence. The *set* of weight values is preserved exactly — only which column holds which weight changes. Consequences the implementation depends on:

- Weights stay in the same numeric range; there is no unbounded drift, so the comparator can use raw `order` values directly.
- `handleUpdateKanbanStructure()` (line 10130) persists the result three ways: custom agents to `state.customAgents[].kanbanOrder`, custom user columns to `state.customKanbanColumns[].order`, and built-ins to a per-workspace `kanbanOrderOverrides` map. `_buildKanbanColumnsForWorkspace()` (line 3782) feeds those overrides back into `buildKanbanColumns`, so `getKanbanStructure` returns post-reorder weights and the sidebar tracks the operator's board automatically.
- `CREATED` and `COMPLETED` are `fixed`/non-reorderable and carry no role, so they never participate.
- **Hidden columns are excluded from the slot pool** (`visibleItems` filters on `visible !== false`, and `_filterVisibleColumns` already removed hidden built-ins upstream). No override is written for them, and their static default weight becomes meaningless relative to the permuted live ones. This is why hidden roles go to the alphabetical tail rather than being backfilled — see step 1.

### One ordering key for the whole sidebar

`kanbanOrderOverrides` is stored **per workspace**, but the sidebar renders terminals from every mapped parent workspace in one list. The decision: **the selected workspace's column order is the single ordering key applied to all groups.** `fetchKanbanColumnStructure()` therefore sends no `workspaceRoot` and takes whatever the host resolves as selected.

The alternative — one structure fetch per mapped workspace, each group sorted by its own board — was rejected: the same roles would appear in different sequences down a single sidebar, which is harder to scan than one consistent convention, and it multiplies fetches by workspace count. The trade-off to accept is that reordering columns in `switchboard` also changes how `viaapp`'s terminals are ordered.

### Decided behaviour (do not re-litigate)

- **Role order sorts terminals *within* the existing workspace/worktree groups.** The parent-workspace and worktree headers stay exactly as they are, including their per-workspace `+` spawn buttons and the `empty-parent-notice`. Role does **not** become a new grouping level.
- **No role headers or dividers.** Sort order only. Terminal names already carry the role (`planner-1`, `coder-2`), and the sidebar is 220px wide — headers would consume vertical space to repeat what each row already says.
- **Exited terminals sink to the bottom of their bucket**, below every live terminal regardless of role. Exited status is the *primary* sort key.
- **A role whose column is hidden sorts to the alphabetical tail**, exactly like a role with no column at all.
- **One ordering key for the whole sidebar** — the selected workspace's, applied to every parent group.
- **No per-role exceptions in the comparator.** Every rank comes from column order. The researcher's position is fixed at source by the companion column plan, not worked around here.

## Metadata

**Tags:** frontend, ui, ux, bugfix
**Complexity:** 4
**Project:** Browser Switchboard

## User Review Required

Yes. Two decisions worth an explicit nod before dispatch:

1. **One ordering key for the whole sidebar.** The selected workspace's column order is applied to every parent-workspace group, so drag-reordering columns in `switchboard` also changes how `viaapp`'s terminals are ordered. The plan rejected per-workspace fetches (same roles in different sequences down one sidebar is harder to scan), but the cross-workspace side effect is a deliberate trade-off the operator should accept.
2. **Landing order vs. the companion plan.** This plan depends on "Fix Researcher Column Position and Forward Flow" re-weighting `RESEARCHER` to 110. If this plan ships first, researcher terminals sort to the top until the column fix lands (cosmetic, self-correcting). Confirm the intended sequence.

## Complexity Audit

### Routine
- Adding a mirrored role→order fallback constant near `GRID_BUILTIN_ROLES` (existing mirror precedent: `GRID_BUILTIN_ROLES` mirrors `allBuiltInAgents`; `kanban.html:9488` mirrors `columnToPromptRole`).
- Adding `role: item.role || null` to `buildColumnList()`'s pushed object — an extra field no existing consumer reads.
- Writing `compareTerminals(a, b)` — a pure 7-key total-order comparator with no I/O.
- Sorting `parentGroup.direct` and each `wtGroup.items` in place before the render loop.

### Complex / Risky
- Extracting the kanban-structure fetch out of the pane-gated poll loop into a standalone `fetchKanbanColumnStructure()`, called at init, from `fetchTerminalList()` (throttled), and on `window` focus with the throttle **bypassed**. The focus-bypass path is a new, unbounded fetch trigger (fires on every focus return, including alt-tab).
- **Replace-not-merge** semantics for `roleOrderMap`: a live structure must wholesale replace the fallback, never merge, or hidden roles inherit stale default weights and land mid-list.
- The sort insertion point is constrained by two contract tests that slice `renderSidebarList`'s opening guard (`terminal-solo-popout-contract.test.js:155`, `multi-parent-terminals-contract.test.js:304`) and one that asserts exactly 2 `appendChild(renderTerminalRow(item))` call sites (`multi-parent-terminals-contract.test.js:314`).

## Edge-Case & Dependency Audit

- **Race Conditions:** `fetchKanbanColumnStructure()` is async; a focus fetch and a `terminalsChanged`-driven fetch can overlap. Both reassign `kanbanColumnsCache` and recompute `roleOrderMap`. The last successful fetch wins; a failed fetch preserves the prior map (existing `catch { /* ignore — keep stale cache */ }` semantics). No lock is needed — the map is a derived snapshot and `renderSidebarList()` reads it synchronously at sort time. A render scheduled between two fetches re-renders with whichever map is current.
- **Security:** No new inputs. `getKanbanStructure` is an existing read verb; the fetch sends `body: '{}'` with no `workspaceRoot` (deliberate). No injection surface.
- **Side Effects:** Sorting is render-only. `PtyFleetService.list()` order and the `runtime.terminals` registry are untouched. No persistence, no backend write, no schema change.
- **Dependencies & Conflicts:** Depends on the companion plan "Fix Researcher Column Position and Forward Flow" (`0ae2edb3-d4f2-468b-bfc4-e94202d6dcfa`) re-weighting `RESEARCHER` from 90 to 110, so researcher sorts after planner with no comparator special case. The fallback constant must mirror `DEFAULT_KANBAN_COLUMNS` as it exists at implementation time — see the Superseded note in step 1. All edits land in `src/webview/terminals.js` (one file) plus one new test file, so this is a single agent stream — no same-file parallelisation hazard.

## Dependencies

- `feature_plan_20260806081500_researcher-column-position-and-flow` (`0ae2edb3-d4f2-468b-bfc4-e94202d6dcfa`) — re-weight the `RESEARCHER` column to `order: 110` so the sidebar's researcher tier lands after planner without a comparator exception.

## Adversarial Synthesis

Key risks: (1) the mirrored fallback constant can drift from `DEFAULT_KANBAN_COLUMNS` if one is edited without the other — mitigated by a contract test asserting the match (Verification step 2); (2) the focus-bypassed fetch is unbounded on frequent focus returns — `getKanbanStructure` is a cheap read, but a short focus throttle (e.g. 5s) would be safer than a full bypass and still clears the stale-on-quiet-fleet case; (3) replace-not-merge must hold or hidden roles inherit stale weights and land mid-list — mitigated by the explicit recompute-on-reassign rule and the contract test. Mitigations are in place; the plan is sound.

## Scope

**In scope** — `src/webview/terminals.js` only, plus one new contract test file. No backend, no API, no schema change.

**Out of scope** — fixing `PtyFleetService.rename()`'s delete-then-set reinsert (sorting at render makes Map order irrelevant, so the underlying reinsert no longer has a visible effect); persisting a manual drag-to-reorder; changing worktree *subgroup* sequence; the pane grid's ordering; the extension-side sidebar in `implementation.html`.

## Proposed Changes

### src/webview/terminals.js

**Context:** The sidebar order is raw `Map` insertion order end-to-end (see "Root causes" above). The fix is render-time only: derive a role→order map from the live Kanban structure (with a mirrored fallback for first paint), and sort each workspace/worktree bucket by a total-order comparator before the render loop. No backend, no persistence, no new grouping level.

### 1. Add the mirrored role-order fallback constant

In `src/webview/terminals.js`, near `GRID_BUILTIN_ROLES` (line 3044), add a role→order map mirroring the `role`/`order` pairs of `DEFAULT_KANBAN_COLUMNS`:

```
researcher: 90, planner: 100, lead: 180, coder: 190,
intern: 200, reviewer: 300, tester: 350, ticket_updater: 9000
```

> **Superseded:** The fallback constant above lists `researcher: 90`, mirroring `DEFAULT_KANBAN_COLUMNS` as it stands today (`RESEARCHER` at `order: 90`).
> **Reason:** This plan's own dependency guidance says to land the companion "Fix Researcher Column Position" plan FIRST, which re-weights `RESEARCHER` to `110`. Implementing this plan after that fix means `DEFAULT_KANBAN_COLUMNS` already carries `110`, so a faithful mirror must use `110` — otherwise first paint sorts researcher above planner (the exact cosmetic gap this plan removes), and the contract test asserting the mirror matches `DEFAULT_KANBAN_COLUMNS` (Verification step 2) fails.
> **Replaced with:** The `researcher` entry must equal `DEFAULT_KANBAN_COLUMNS`' `RESEARCHER` `order` at the time this plan is implemented: `110` after the companion plan lands, `90` only if this plan ships first. The contract test guards drift, so a stale mirror fails the suite rather than silently misordering.

Comment it the way `GRID_BUILTIN_ROLES` is commented — state that it mirrors `DEFAULT_KANBAN_COLUMNS` in `src/services/agentConfig.ts` and must be updated in lockstep. Mirrored constants already have precedent in this codebase (`GRID_BUILTIN_ROLES` mirrors `allBuiltInAgents`; `src/webview/kanban.html:9488` mirrors `columnToPromptRole`).

**This constant has exactly one job: first paint.** The sidebar renders before any Kanban structure fetch resolves; without a fallback the very first paint would be alphabetical and then visibly re-sort. Once a live structure lands it **replaces** the fallback wholesale — it is not merged or overlaid.

**Do not use it to backfill hidden columns.** `TaskViewerProvider._filterVisibleColumns()` (line 3791) drops built-in columns whose role has `visibleAgents[role] === false`, so a hidden role is absent from the structure entirely. Backfilling its *static* default weight is wrong, because reordering permutes the live weights among the visible columns only (see "Column reordering", below) — the hidden role's static weight then means nothing relative to them, and it lands in an arbitrary mid-list position. Hidden roles go to the alphabetical tail like any other unmapped role. This is also defensible on behaviour: `resolveGridAgents()` (line 3049) skips roles with `visible[role] === false`, so hiding an agent stops the grid spawning it — a live terminal of a hidden role is already an edge case.

### 2. Build a role→order map and keep `role` through `buildColumnList`

`buildColumnList()` (line 2137) currently discards `role`, keeping only `{ id, label, order }`. Add `role: item.role || null` to the pushed object. The existing sort and the column-picker consumers are unaffected by an extra field.

Add a `roleOrderMap` derived from `kanbanColumnsCache`, keyed `role → order`, containing one entry per cache item with a truthy `role`. **Replace, do not merge:** while the cache is empty the map is the fallback constant; the moment a live structure lands the map becomes purely the live roles. Merging would resurrect stale weights for hidden columns — see step 1.

Recompute the map whenever `kanbanColumnsCache` is reassigned.

### 3. Fetch the column structure unconditionally at boot

Today `kanbanColumnsCache` is only ever populated inside the Kanban-pane poll loop (line 2514), which early-returns when no pane is in `kanban` mode (line 2510). The sidebar must not depend on pane configuration.

Extract the structure fetch into a standalone `fetchKanbanColumnStructure()` that keeps the existing 30s `kanbanStructureTimer` throttle, then:

- Call it once during panel init.
- Call it (throttled) from `fetchTerminalList()`, so the `terminalsChanged` refresh keeps the ordering key fresh without a new timer. The 30s throttle already prevents hammering.
- **Call it on `window` focus, bypassing the throttle.** Reordering columns in Setup fires `_postSidebarConfigurationState`, `postSetupPanelState` and `switchboard.refreshUI` (`TaskViewerProvider.ts:10172-10176`) — **none of which reach terminals.js's `kanbanColumnsCache`**. Without a focus hook, a quiet fleet with no terminal events could hold the pre-reorder order indefinitely, and the operator would come back from Setup to a sidebar that ignored their change. Focus is the moment they return, so it is the right trigger.
- Leave the Kanban-pane poll loop calling the same extracted function rather than duplicating the fetch.
- On a successful fetch that actually changes the map, call `renderSidebarList()` so the order settles.
- Keep the existing `catch { /* ignore — keep stale cache */ }` semantics. A failed fetch must leave the previous map intact and fall through to the constant, never to unsorted.
- **Keep sending `body: '{}'` with no `workspaceRoot`** — this is deliberate, see "One ordering key for the whole sidebar" below.

`getKanbanStructure` is reachable in both hosts: the extension path goes through `KanbanProvider.ts:10360`, and the standalone path reaches the same handler via the `default:` arm of `kanbanVerb` (`src/standalone/bootstrap.ts:1062`) delegating to `kanbanProvider.handleServiceVerb`. The handler's `_taskViewerProvider` dependency (`KanbanProvider.ts:10362`) is satisfied in standalone by `bootstrap.ts:689` (`kanbanProvider.setTaskViewerProvider(taskViewerProvider)`). Confirm this end-to-end during verification rather than assuming it.

### 4. Write the comparator

Add a `compareTerminals(a, b)` helper. Keys in order:

1. **Exited last** — `(status === 'exited' ? 1 : 0)` ascending.
2. **Role tier** — `0` if the role is present in `roleOrderMap`, `1` otherwise.
3. **Within tier 0** — the mapped column `order`, ascending.
4. **Within tier 1** — `localeCompare` on the role string, ascending. Use `item.role || '￿'` so a terminal carrying no role at all sorts to the very end of the tail instead of the front.
5. **Same role — numeric suffix ascending.** Parse a trailing `-N` off `friendlyName` (`/-(\d+)$/`). This must be a *numeric* compare, not lexicographic, or `planner-10` would sort before `planner-2`. A renamed terminal with an arbitrary alias has no suffix — give it `Number.MAX_SAFE_INTEGER` so custom-named terminals sit after the numbered run of their role.
6. **`startTime` ascending** — already present on every record from `ptyListTerminals`.
7. **`friendlyName` `localeCompare`** — final tiebreak, so the comparator defines a total order and the sort is deterministic.

### 5. Apply the comparator in `renderSidebarList`

In `renderSidebarList()`, after the bucketing loop completes (i.e. after line 1186) and before the render loop begins (line 1193), sort `parentGroup.direct` and each `wtGroup.items` for every group in `activeGroupsToRender`, including `unmappedGroup`.

Two placement constraints, both enforced by existing tests:

- The sort must go **below** the `if (!soloTerminalName) { emptyStateEl.style.display … }` guard at the top of the function. `src/test/terminal-solo-popout-contract.test.js:155` and `src/test/multi-parent-terminals-contract.test.js:304` both slice a text block starting at `function renderSidebarList() {` and assert that guard's shape. Inserting above it breaks both.
- It must not add a third `appendChild(renderTerminalRow(item))` call site — `multi-parent-terminals-contract.test.js` asserts exactly 2. Sorting the arrays before iteration preserves this.

`renderGroupSidebar()` (line 1042) renders saved seating groups, not terminals, and is untouched.

## Verification Plan

**Build the VSIX and install it.** Per `CLAUDE.md`, `dist/` is not served during development, and the browser panel's live server serves the installed VSIX's bundle — `src/` edits are invisible until the VSIX is rebuilt and installed. Verifying against a stale VSIX will show the old ordering and read as "the change did nothing".

**Baseline the test suite first.** Several regression tests are already red at `HEAD`. Record the failing set *before* touching anything so new breakage is attributable.

1. `npm test` (or the repo's test entry point) — the two contract files that slice `renderSidebarList` must stay green: `src/test/multi-parent-terminals-contract.test.js` and `src/test/terminal-solo-popout-contract.test.js`.
2. **New contract test** asserting: `renderSidebarList` sorts before rendering; the comparator puts `exited` last; unmapped roles sort alphabetically after mapped ones; the numeric-suffix compare is numeric (a `planner-10` vs `planner-2` case); a live structure **replaces** rather than merges with the fallback constant, so a role missing from the structure cannot inherit a stale default weight; and the fallback constant's role/order pairs match `DEFAULT_KANBAN_COLUMNS`, so the mirror cannot silently drift.
3. **Manual, multi-role fleet.** Open the Agents grid so several roles spawn, then confirm the sidebar reads `planner → researcher → lead → coder → intern → reviewer → tester → ticket_updater`, with `analyst`/`claude_artifacts`/`phone_a_friend`/`jules_monitor` alphabetical below them. (Researcher lands after planner because the companion plan re-weights its column to 110 — not because of any comparator special case. If it still sorts first, the column fix has not landed.)
4. **Slot-reuse regression** (the main complaint). With `planner-1/2/3` live, kill `planner-2`, spawn a new planner. It is renamed `planner-2` by the first-free-slot search — confirm it now renders *between* `planner-1` and `planner-3` rather than at the bottom of the group.
5. **Rename regression.** Rename any terminal to an arbitrary alias. Confirm it stays inside its role's run (after the numbered ones) rather than teleporting to the end of the list.
6. **Exit behaviour.** Let a terminal exit naturally (not via the close button). Confirm it drops to the bottom of its workspace/worktree bucket rather than holding its mid-list slot.
7. **Hidden column falls to the tail.** With a live `intern-1`, hide the Intern agent in the Agents tab — this removes `INTERN CODED` from `getKanbanStructure` via `_filterVisibleColumns`. Confirm `intern-1` moves to the alphabetical tail (between `claude_artifacts` and `jules_monitor`), **not** to a mid-list position. Re-show the agent and confirm it returns between `coder` and `reviewer`.
8. **Operator reordering is respected.** Drag-reorder a column in Setup (e.g. move Reviewed ahead of Coder), return to the terminals panel, and confirm the sidebar order follows the board.
8a. **Reorder reaches the panel without a reload.** Repeat step 8 with the terminals panel already open and a completely idle fleet (no spawns, no exits, so no `terminalsChanged`). Confirm the focus-triggered refetch re-sorts the sidebar on return — this is the path the existing 30s throttle and the missing structure push would otherwise leave stale.
8b. **Reorder plus hidden role.** Hide Intern, then drag Reviewed ahead of Lead Coder. Confirm `intern-1` stays in the alphabetical tail rather than landing between `reviewer-1` and `lead-1` — this is the specific staleness the rejected backfill design would have produced.
8c. **One key across workspaces.** With two parent workspaces mapped and terminals live in both, reorder columns on the selected workspace's board. Confirm *both* groups re-sort to the new order — the second group must not keep its own board's order.
9. **Multi-repo grouping intact.** With two parent workspaces mapped, confirm the workspace and worktree headers, their counts, the per-workspace `+` buttons, and `empty-parent-notice` all still render — role sorting must not have flattened the hierarchy.
10. **Both hosts.** Repeat steps 3 and 8 in the standalone browser panel to confirm `getKanbanStructure` resolves there and the order is not silently stuck on the fallback constant.
11. **Degraded path.** Block or fail the structure fetch and confirm the sidebar still sorts by the fallback constant — never unsorted, and no console error loop.

## Recommendation

Complexity 4 — **Send to Coder.** Single-file render-time change reusing existing patterns, with two moderate, well-scoped risks (replace-not-merge semantics and contract-test-constrained sort placement). Land after the companion Researcher column plan so the fallback constant mirrors `RESEARCHER` at `110`.
