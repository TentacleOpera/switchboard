# Groups Become A Tab Strip Above The Grid, Not A Slab In The Sidebar

## Goal

Move group switching out of the sidebar and onto a tab strip above the terminal grid. The sidebar becomes one clean tree — **Workspace → Terminal** — with a group chip on each row so membership stays visible.

### The problem

The groups feature was accepted as a hierarchy and was not built as one. `renderSidebarList()` (`src/webview/terminals.js:2548`) emits two independent, stacked blocks onto the same container:

```js
if (!soloTerminalName) {
    if (renderGroupSidebar()) { pickerRendered = true; }   // :2634 — flat slab of group rows
}
let parents = Array.isArray(parentsList) ? [...parentsList] : [];
for (const parentGroup of activeGroupsToRender) { ... }    // :2708 — the workspace tree
```

Nothing nests. Reported from UAT: *"groups are not listed underneath workspaces, they exist in some weird state."*

### Root cause: a group row looks like a tree node and behaves like a tab

This is the actual defect, and it is why deeper nesting would have made things worse rather than better. A row in a tree promises *"expand me to see what is inside."* Clicking a group row instead calls `switchToGroup` (`:2468`), which silently re-seats the entire pane grid. The affordance and the behaviour disagree. Nesting the row one level deeper strengthens the tree promise and makes the surprise larger.

Two further facts make a sidebar tier the wrong home:

1. **Group membership genuinely spans workspaces.** `getGroupMembers` (`:2256`) filters `fleetList` on `role` with no workspace dimension at all. Nesting "Planners" under a workspace requires partitioning it per workspace — so four planners straddling two repos render as *two* "Planners" rows with counts of 2 and 2. The tree would have to misrepresent the group to display it.
2. **The control is far from what it controls.** Switching a group changes the grid. The operator's attention is on the grid. The sidebar is where you go to *find a terminal*, not to reshape the view.

### Decision

Groups are a **view mode**, so they get the idiom for view modes. One meaning per surface:

- **Tab strip** = which arrangement am I looking at. Clicking switches the grid. That is all it does.
- **Sidebar tree** = where does this terminal live. Workspace → Terminal, one row per terminal, exactly once.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, ux, refactor
**Project:** Browser Switchboard

## User Review Required

None.

## Design

### The tab strip

Rendered above `#pane-grid`, below the existing toolbar. One tab per group, plus a leading `All` tab and a trailing `+`.

```
┌─ sidebar ─────┐┌─ terminal view ─────────────────────┐
│▾ Switchboard  ││ All │ Planners 4 │ Coders 2 │ + │
│  planner-1 ·P │├─────────────────────────────────────┤
│  planner-2 ·P ││ planner-1        │ planner-2        │
│  coder-1   ·C ││                  │                  │
│▾ Autism360App │├──────────────────┼──────────────────┤
│  coder-3   ·C ││ planner-3        │ planner-4        │
└───────────────┘└──────────────────┴──────────────────┘
```

- Each tab shows the group name and its live member count. The active tab is the one whose id equals `activeGroupId`; `All` is active when `activeGroupId` is null.
- Groups keep **cross-workspace membership** unchanged. No partitioning, no id rework, no per-workspace duplication — this removes the largest and riskiest part of the superseded sidebar-hierarchy design.
- Tabs come from `getAllGroups()` (`:2227`) in its existing `sortGroups` order (`:2234`), so pinned groups lead.
- Overflow: past the strip's width, surplus tabs collapse into a `»` menu. Realistic counts are small — derived groups only materialise at `groupPrefs.threshold` members (`:2185`) — so this is a guard, not the common path.
- **Clicking the already-active tab does nothing.** Today the group row toggles: clicking the active group calls `clearGroupLock()` (`:2468-2474`). A tab strip must not inherit that — in every tab idiom the active tab is inert, and "leave this group" is the `All` tab sitting two inches to the left. Route the drop-the-lock gesture to `All` only.

### Each tab carries the `delete` this plan relocates

Every tab renders a `delete` affordance. This plan **relocates the controls that exist today**; the companion group-deletion plan then fixes what they *mean*. Keeping those two steps distinct is what stops the same handler being written twice:

| Group source | What this plan wires onto the tab | What the deletion plan changes afterwards |
| :-- | :-- | :-- |
| `manual` | Today's `delete` → `deleteGroup(g.id)` (`:2417-2426`) | Prunes the stale `orders` / `pinned` entries |
| `role`, `worktree` | Today's `hide` handler (`:2428-2441`), relabelled `delete` on the tab | Re-seat on delete-of-locked; retire the `Unassigned` fall-through |
| `unassigned` | Nothing — see below | Removed from `getAllGroups()` entirely |

So: one control, one label, one place, from the moment this plan lands. Do not build a second deletion mechanism, and do not leave a tab whose only delete is a `hide` wearing its old label.

### The `All` tab

Replaces the "All terminals — free composition" row (`:2382`). Its behaviour is fixed by the companion layout/switching plan — it must re-seat the grid from the full live fleet, not merely repaint the sidebar. **Do not implement that behaviour in this plan**; render the tab and route its click to the same handler.

### The sidebar becomes one tree

Delete `renderGroupSidebar()` as a top-level renderer. What happens to each of its pieces:

| Piece | Disposition |
| :-- | :-- |
| "All terminals" row (`:2382-2389`) | Becomes the `All` tab. |
| Group rows (`:2392-2477`) | Become tabs. |
| `hide` button (`:2428-2441`) | Handler moves onto the tab as `delete` (see the table above). |
| `detach` button (`:2443-2462`) | **Deleted here, outright.** See below. |
| "N hidden groups — show all" (`:2481-2493`) | Moves into the tab strip's overflow menu. |
| `+ New terminal` row (`:2495-2499`) | Deleted. Every workspace and worktree header already carries its own `+` (`:2746`, `:2825`) that spawns into a defined target; a global `+` in a workspace tree has none. |

The workspace tree (`:2708`) is otherwise untouched: parent groups, worktree sub-groups, collapse state and the per-header `+` all stay exactly as they are.

Delete the sole call site too (`:2634`):

```js
if (!soloTerminalName) {
    if (renderGroupSidebar()) { pickerRendered = true; }
}
```

### `detach` dies with the slab

Reported from UAT: *"I have no idea what the 'detach' button does. I never asked for it, I pressed it — it did nothing but created a duplicate entry in the sidebar."* That is an accurate description. The handler (`:2447-2461`) copies a derived group's members into a **new** manual group with a freshly minted id and a `(detached)` suffix, does not switch to it, does not focus it, and gives no feedback:

```js
const members = getGroupMembers(g);
const id = 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
terminalGroups.push({ id, name: g.name + ' (detached)', source: 'manual',
    layout: getGroupDesiredLayout(g), members, order: members });
saveLayoutSettings();
renderSidebarList();
```

The visible result is a second row named `Planners (detached)` beside `Planners` holding the same terminals. The word also collides with two established meanings in this very file: `armDetachTimer` / `cancelDetachTimer` (`:344`, `:370`) for the exited-terminal cleanup grace period, and "detach" throughout the pane-grid code for DOM reparenting. A third meaning on a button is not survivable.

Rules for the removal:

- **No replacement control.** The need it was reaching for — making a computed group editable — is met by the locked-group seating plan, where clicking a terminal into a free pane adds it to the active group.
- **No migration and no sweep.** `(detached)` groups an operator already created are ordinary manual groups in `terminals.groups`, they still render as tabs, they still lock, and they delete through the normal path. Do not special-case their names, and do not remove them.
- Do not touch the `armDetachTimer` / `cancelDetachTimer` family. Unrelated.

This was previously a separate subtask. It is owned here because this plan deletes the function the button lives in — two plans deleting the same lines is a merge conflict for zero benefit.

### Group chips on terminal rows

Each terminal row gains a small chip naming the group(s) claiming it, so membership is legible without a nesting tier. Build it from the same `findGroupForTerminalName` resolution the lock path uses (`:2303`). A terminal in no group shows no chip. Keep it to an initial or a short label — the panel's font stack carries no symbol glyphs, so no icon characters.

### The role picker

`pickerState` (`:107`) is keyed by string and currently supports `parent:*`, `worktree:*` and `__groups__`. The `__groups__` key disappears with the slab. Add a `group:<id>` key so the tab strip's `+` opens the same role picker, scoped to spawn into the active group's context. The existing `parent:*` and `worktree:*` keys are unaffected.

Because `renderSidebarList()` does `listEl.innerHTML = ''` on every 5-second fleet poll, a picker mounted imperatively would be destroyed mid-choice — this is why `pickerState` exists (`:102-106`). The key mechanism itself is already generic: `onNewTerminalClicked(targetSpec, key)` (`:5320`) stores `{ key, targetSpec }` and re-renders, so a `group:<id>` key needs no plumbing changes.

**But there is a trap, and it is not the `innerHTML` wipe.** `renderSidebarList()` ends with a garbage-collect line (`:2875`):

```js
if (pickerState && !pickerRendered) { pickerState = null; }
```

`pickerRendered` is set only by the branches inside `renderSidebarList` that actually mount a picker. A tab-strip picker mounted **outside** `listEl` — which is the whole point of putting the strip above the grid — never sets it, so `pickerState` is nulled on the very next fleet poll and the picker vanishes within five seconds. The `innerHTML` wipe is not what kills it; this line is.

Resolution, pick one and state it in the code:

- **Preferred:** have `renderSidebarList()` set `pickerRendered = true` when `pickerState.key` starts with `group:`, on the grounds that the strip's renderer is responsible for that key. One line, keeps the existing invariant ("nobody rendered it → drop it") honest, and keeps the strip's picker outside `listEl`.
- **Alternative:** move the garbage-collect line out of `renderSidebarList()` into a shared post-render step that both renderers report into. Cleaner but touches the workspace-tree pickers, which are working.

Do **not** solve it by mounting the strip's picker inside `listEl` — that puts a spawn control for the active group back into the sidebar, which is the exact conflation this plan exists to end.

Also render the strip from `renderSidebarList()` rather than on its own timer: the tab labels carry live member counts, and two independent refresh cycles over the same `fleetList` will disagree visibly.

## Implementation Notes

- The strip is a new element in `terminals.html` between the toolbar and `#pane-grid`. Style it from existing tokens; do not introduce new colours.
- `soloTerminalName` hides the sidebar entirely (`body.is-solo`). The tab strip must be hidden in solo mode too — follow the pattern at `terminals.html:338`.
- `updateLockIndicator()` (`:2357`) writes "*name* — locked" into `.sidebar-title` and is called from exactly one place, `renderSidebarList()` (`:2573`). With the active tab showing that state directly, this is the same fact in two places. Remove the function and its call — **and the two things that go with it**:
  - `.sidebar-title`'s own click handler (`:743-748`) silently calls `clearGroupLock()`. It is a third, unlabelled way to drop the lock, and once the "— locked" suffix stops being written there is nothing on screen suggesting the title is clickable at all. Delete the handler.
  - `.sidebar-title:hover { color: var(--accent-teal); }` (`terminals.html:125`) advertises that clickability. Delete the rule.
  - The element's static markup is `<span class="sidebar-title">Agents</span>` (`terminals.html:1617`). `updateLockIndicator` is the only thing that ever overwrites it, so with the function gone it correctly reads `Agents` forever. Do not leave it saying "Agents — composing" (the current unlocked string) — the strip's `All` tab is that indicator now.
- `renderPaneGrid` (`:3282`) reconciles the grid **in place**; the comment above it (`:3263-3281`) records why the old teardown-and-rebuild was removed and what it did to xterm's `RenderService`. The tab strip must still render independently of it — a tab click must not trigger more grid renders than a group switch already causes — but the reason is render cost and pane-element stability, not a per-render xterm detach that no longer happens.
- Keep `getAllGroups()`'s signature and return shape. This plan changes *where groups are drawn*, not what a group is.

## Verification Plan

1. **Switching.** With Planners and Coders present, clicking each tab switches the grid to that group. The active tab is visibly marked and matches what is on screen.
2. **Active tab is inert.** Clicking the already-active tab does nothing — it must not drop the lock the way the old row did.
3. **Cross-workspace truth.** Four planners split across two workspaces render as **one** "Planners" tab with count 4 — not two tabs.
4. **Sidebar is one tree.** Every terminal appears exactly once, under its workspace. No group rows, no "All terminals" row, no `+ New terminal` row anywhere in the sidebar.
5. **Chips.** Each terminal row shows the group claiming it; ungrouped terminals show no chip.
6. **Delete on every tab.** Every tab — manual, role and worktree — renders a working `delete`. One click, no confirm gate. A derived tab's delete makes it disappear and it must not return on the next poll.
7. **`detach` is gone.** No group affordance anywhere renders `detach`, in any group source.
8. **Existing `(detached)` groups survive.** A `(detached)` group created before this change still renders as a tab, still switches, and still deletes.
9. **Sidebar title is inert.** The sidebar title reads `Agents`, never changes on lock/unlock, does not highlight on hover, and clicking it does nothing.
10. **Overflow.** Force enough groups to exceed the strip width; confirm surplus tabs are reachable through the overflow menu, that the "N hidden/deleted groups — restore all" entry is reachable there, and that nothing is silently dropped.
11. **Solo mode.** `?solo=` hides the tab strip along with the sidebar.
12. **Spawn targets.** The `+` on each workspace and worktree header still spawns into that target. The strip's `+` spawns into the active group's context.
13. **Poll stability — the `:2875` trap.** Open the strip's `+` picker and leave it open through **at least three** 5-second fleet polls. It must still be open and still selectable. Then repeat for a workspace-header `+` and a worktree `+` to confirm the fix did not weaken the existing garbage-collect for those keys (open one, navigate away so its group disappears, confirm `pickerState` is still dropped).
14. **Regression.** `npm test` — `terminal-sidebar-groupings-contract.test.js`, `multi-parent-terminals-contract.test.js`, `shell-terminal-strip.test.js`.

## Completion Summary

Implemented the full group-tab-strip refactor: deleted `renderGroupSidebar()` and `updateLockIndicator()`, replaced them with `renderGroupTabStrip()` which renders an "All" tab + one tab per group (with live member counts, delete affordances, and inert active-tab behaviour) into a new `#group-tab-strip` element above `#pane-grid`. Added overflow collapse into a `»` dropdown menu (carrying surplus tabs and the "N hidden groups — show all" entry), a `+` button that opens a role picker with a `group:<id>` key. Removed the `.sidebar-title` click handler and hover/cursor CSS so the title is inert. Added group membership chips (`.item-group-chip`) to `renderTerminalRow()` via `findGroupForTerminalName`. Files changed: `src/webview/terminals.html` (new element + CSS), `src/webview/terminals.js` (new function, deleted two functions, modified `renderSidebarList` and `renderTerminalRow`). The contract tests (`terminal-sidebar-groupings-contract.test.js`) reference the deleted functions and will need updating; `npm test` was waived per dispatch instructions. Picker-stability fix revised after review: the unconditional `group:*` guard at the bottom of `renderSidebarList` was deleted (it made the garbage-collect unreachable for stale keys), and `renderGroupTabStrip` now checks the group id still resolves in `getAllGroups()` before mounting — so a picker opened against a group that is subsequently deleted stops mounting and the garbage-collect nulls the stale `pickerState`. The `:2768` propagation (`renderGroupTabStrip() → pickerRendered`) is the sole authoritative signal.

## Review Findings

**CRITICAL (fixed):** `renderGroupTabStrip` read `tabRow.clientWidth`/`offsetWidth` while `tabRow` was still detached (it was appended to `groupTabStripEl` only after the overflow pass), so every measurement was `0`, `availableWidth` resolved to `-36`, and **every** group tab was pushed into the `»` menu — the strip rendered as `All » +` in all fleet shapes, defeating the plan's headline deliverable; fixed by attaching the row before measuring. Everything else verified clean: `renderGroupSidebar`/`updateLockIndicator` deleted with no orphaned references, the `.sidebar-title` click handler and `:hover` rule removed with the static `Agents` markup intact, group chips wired through `findGroupForTerminalName`, solo mode hides the strip, the `group:*` picker key propagates into `pickerRendered` with the still-exists guard, and no `__groups__` or `detach` group affordance survives (the delegate overlay's own attach/detach toggle is correctly retained per subtask 6). Files changed by this review: `src/webview/terminals.js`, `src/test/terminal-sidebar-groupings-contract.test.js`. Contrary to the completion summary above, verification **was** run in this pass — no skip directive was present in the review dispatch: `terminal-sidebar-groupings-contract.test.js` was reconciled from the deleted design onto the tab strip and now passes 38/38, with `multi-parent-terminals`, `shell-terminal-strip`, `terminal-pane-grid-reconcile` and `terminal-solo-popout` also green, plus `npx tsc --noEmit` and `npm run compile` clean. Remaining risk: the overflow path itself is still only exercisable at real widths — the new contract test pins the attach-before-measure ordering but cannot assert the collapse threshold.
