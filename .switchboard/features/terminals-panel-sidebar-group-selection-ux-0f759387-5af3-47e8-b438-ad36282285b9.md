# Terminals Panel Sidebar & Group Selection UX

**Complexity:** 6

## Goal

Repairs the Terminals panel sidebar and its top-bar group selector so the two surfaces agree. The sidebar filters to the selected group; ungrouped terminals open their own grid instead of being silently conscripted into the locked group; the group paging control moves out of a red full-width banner into the layout toolbar; the cryptic N (Xa/Yx) count badge is removed; and the stacked workspace header tier is replaced with the workspace dropdown every other panel uses.

## How the Subtasks Achieve This

- **Remove the cryptic `N (Xa/Yx)` count badge from the Terminals sidebar headers**: deletes the debug-readout badge from both the workspace header and the worktree sub-header in `renderSidebarList()`, plus the active/exited counting that feeds it and the dead `.worktree-count` CSS rule. `totalItems` is deliberately kept because it gates the "(no terminals — + to open)" notice. Contributes the horizontal budget in the 220px sidebar that the other sidebar subtasks then spend on a group name, a workspace dropdown, and readable workspace titles.
- **Terminals sidebar ignores the active group tab — filter the agent tree to the locked group**: resolves the locked group once per render and filters `fleetList` to its members before the workspace/worktree bucketing pass, stamps the sidebar title with the group name, branches the empty notice so it says *which* group is empty, and suppresses the now-redundant per-row group chip. This is the subtask that makes the top-bar tab strip and the sidebar mean the same thing.
- **Terminals sidebar stacks every workspace as a header tier — replace it with the workspace dropdown every other panel uses**: adds a signature-guarded `<select>` built from the existing `buildWorkspaceList()` above the sidebar ops block, persists the choice as `terminals.sidebarWorkspace`, and — when a specific workspace is picked — drops the workspace header tier entirely so terminals render one level shallower with a `+` beside the dropdown. Brings the last non-conforming surface into line with the dropdown idiom the rest of the product (and this panel's own kanban pane) already uses.
- **Group paging controls are a red full-width banner that shoves the grid down — move them into the layout toolbar**: splits `#layout-fallback-banner`'s two conflated jobs. Paging becomes a `#group-pager` control inside `.layout-toolbar` wearing the panel's theme tokens and reserving its space with `visibility` so it never displaces the pane grid; the banner keeps only the genuine window-too-small warning and is rethemed from a hardcoded red literal to the panel's amber state token. Also fixes the case where a floored layout was never reported because paging won the shared branch.
- **Clicking an ungrouped terminal silently conscripts it into the locked group — give ungrouped terminals their own grid**: reinstates the `Unassigned` pseudo-group as a computed, unstorable remainder across every seam that touches it — `getAllGroups()`, `getGroupMembers()`, `findGroupForTerminalName()`, the locked-click router, and the free-slot fill branch — and makes the write paths (`addTerminalToActiveGroup`, `setGroupOrder`, `deleteGroup`) inert for it. This is the group-model half of the feature: it removes the two wrong outcomes (conscript, or tear the lock down) that a click on an ungrouped terminal could produce.

## Dependencies & sequencing

**Shipping order — three of the five subtasks rewrite the same function (`renderSidebarList()`), so they serialise. The other two are independent.**

1. **Remove the count badge** — first. It is a pure deletion inside the workspace-header block that both following subtasks restructure; landing it first means they rebase onto three fewer lines instead of merging around a badge one of them would delete anyway.
2. **Filter the agent tree to the locked group** — second. It introduces the group-membership filter on the bucketing input and the branched empty notice.
3. **Workspace dropdown** — third. It is the only subtask that changes the render's *control flow* (making the header block conditional), so it is far cheaper to rebase onto the other two than the reverse. The reconciled filter order inside the function is **group filter (on `fleetList`, pre-bucketing) → bucket → workspace filter (on the bucket list)**; never the reverse, or the group filter's own empty-notice branch becomes unreachable.
4. **Ungrouped terminals get their own grid** — last. It changes the *group model* rather than the sidebar, and subtasks 2 and 3 read that model through generic accessors (`getAllGroups()`, `getGroupMembers()`), so landing it last means the sidebar work is written against a stable model and this is written against a stable sidebar.
5. **Group pager moves into the layout toolbar** — **unordered**. Its whole surface is `applyLayoutFloor()` plus toolbar markup and CSS; it shares no edited line with any of the four above and can land at any point in the sequence.

**Prerequisites and guards:**

- **`totalItems` must survive the badge deletion.** It gates the empty-notice branch, which is the `else` arm of the entire row render. Losing it renders the notice on every workspace *and* suppresses every row. This is the one hard prerequisite the later sidebar subtasks depend on.
- **`hasUnmapped` for the workspace dropdown must be probed from the unfiltered fleet, not from the buckets.** Because the group filter narrows `fleetList` before bucketing, deriving the option list from the buckets would make the `Unmapped` option vanish under a group lock, trip the dropdown's stale-selection fallback, and *persist* the reset — destroying the operator's saved workspace selection on a gesture unrelated to workspaces.
- **The group-chip line (`renderTerminalRow`) is jointly owned** by the group-filter and ungrouped-grid subtasks: the pseudo-group makes `findGroupForTerminalName()` return non-`null` for every ungrouped terminal, which would chip most of the fleet with the word "Unassigned" and re-spend the width the badge deletion just freed. Both plans carry the same reconciled line verbatim; implement it once, in whichever lands second.
- **Do not re-add a `parentInstanceId` filter to `getGroupMembers()`'s `manual` branch.** Its removal was deliberate (a team registers head + children explicitly), so manual-team children are members and must appear under a lock. The `Unassigned` complement filters children with its own predicate; both filters are load-bearing and neither replaces the other.
- **`clearGroupLock()` ↔ `applyLayoutFloor()` re-entry is expected, not a defect.** The ungrouped-grid subtask adds a `clearGroupLock()` fallback in `seatActiveGroupPage()`; `clearGroupLock` calls `applyLayoutFloor()` at its tail, whose `changed` branch calls back. It terminates one level deep because `activeGroupId` is nulled first. Neither subtask should add a re-entrancy flag.
- **No migrations required.** `terminals.sidebarWorkspace` is a new key read through `loadSetting(key, default)`, and `groupPrefs.layouts['__unassigned__']` is an additive, downgrade-inert entry in an existing map. Nothing shipped changes shape.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Terminals sidebar ignores the active group tab — filter the agent tree to the locked group](../plans/feature_plan_20260812212100_terminals-sidebar-filters-to-active-group.md) — **PLAN REVIEWED**
- [ ] [Group paging controls are a red full-width banner that shoves the grid down — move them into the layout toolbar](../plans/feature_plan_20260812212101_group-shortfall-pager-moves-into-layout-toolbar.md) — **PLAN REVIEWED**
- [ ] [Clicking an ungrouped terminal silently conscripts it into the locked group — give ungrouped terminals their own grid](../plans/feature_plan_20260812212102_ungrouped-terminals-get-their-own-grid.md) — **PLAN REVIEWED**
- [ ] [Remove the cryptic `N (Xa/Yx)` count badge from the Terminals sidebar headers](../plans/feature_plan_20260812212103_remove-cryptic-count-badge-from-sidebar-headers.md) — **PLAN REVIEWED**
- [ ] [Terminals sidebar stacks every workspace as a header tier — replace it with the workspace dropdown every other panel uses](../plans/feature_plan_20260812212104_terminals-sidebar-workspace-dropdown.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

