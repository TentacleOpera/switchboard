# Terminals Sidebar: Unify Groups and Grids, and Make Switching Rapid

## Goal

Rebuild the terminals sidebar so individual terminals, saved groups, and grids are all reachable at a glance and switchable in one click — and collapse "grid" into "group" so users hold one concept instead of two.

### The problem

The sidebar cannot show groups and terminals at the same time. `groupsView` (`src/webview/terminals.js:69`) is a boolean that flips the sidebar between "group list" and "flat terminal list":

```js
let groupsView = true; // when groups exist + !solo, true → group sidebar, false → flat list
```

`renderGroupSidebar()` renders **only** group rows plus a "Show all terminals" row that sets `groupsView = false` and re-renders. So reaching one terminal means leaving the group list entirely, and returning means leaving the terminals. Rapid switching between individual terminals, groups, and grids is not slow in this design — it is structurally impossible, because no view contains more than one of them.

### Root cause

Groups were added as a *replacement* view rather than a *section* of the existing one, and three unrelated organising ideas ended up competing for the same list element:

| Concept | Where it lives | What it means |
| :--- | :--- | :--- |
| **Seating group** | `terminalGroups`, `activeGroupId` (line 62-68) | A named snapshot of `(layout, assignments)` — which terminal sits in which pane |
| **Workspace / worktree group** | `parent-group`, `worktree-group` (lines 541-576, 1406-1461) | Structural hierarchy: which workspace or worktree a terminal belongs to |
| **Solo mode** | `soloTerminalName` | One pinned terminal, no grid at all |

Two of these are called "group" and they are not the same thing. Worse, seating-group rows are rendered with `className = 'worktree-group-header'` (line 1217) — borrowing the *worktree* visual language for an unrelated concept, which is a large part of why the feature reads as confused.

### The unification

A group is already `{ layout, assignments }` (`saveCurrentAsGroup`, line 1181). A grid is a layout. **So a grid is a group whose layout has many slots** — exactly as observed. Treating "grid" as a separate noun adds a third concept that the data model does not have. Making the role-fill action produce a *saved group* means the grid concept disappears into groups rather than competing with them, and a batch of nine planners becomes a one-click recall forever after.

### Correctness bugs found while reading

These are not cosmetic and should be fixed as part of this work:

1. **Dead button in solo mode.** `switchToGroup` opens with `if (soloTerminalName) { return; }` (line 1206). Clicking a group while solo'd does nothing, with no feedback — the same class of failure as a `confirm()` gate that silently no-ops.
2. **`activeGroupId` never invalidates.** It is set on create and switch, cleared only on delete. Manually reassign a pane after seating a group and the sidebar still shows that group as active while the seating has diverged. There is no dirty indicator and no way to re-save.
3. **Groups key on `friendlyName`.** Per the comment at line 64-66, "the fleet has no stable id, so `renameTerminal` must fixup group assignments." A terminal that exits and is recreated under a different name silently vanishes from every group referencing it, leaving a hole no UI explains.
4. **`switch` and `delete` sit adjacent** as small text buttons on every group row, and deletion is immediate (correctly — no confirm dialogs). Adjacent destructive and non-destructive actions of identical weight is precisely the misclick hazard the project's no-confirm rule assumes buttons are shaped to avoid.
5. **No rename.** `saveCurrentAsGroup` auto-names `Group N` when the name is blank, and nothing can rename it afterwards.
6. **`btn-save-group` destroys itself.** The handler calls `btnSaveGroup.replaceWith(input)` (line 547) — the button is gone from the DOM until something re-renders it.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, ux, refactor

## Reconcile Before Building

Check for unpushed local work touching the terminals sidebar or grouping before starting — the user has noted this area is actively being reworked. Adopt whatever group identity scheme exists rather than minting a second one.

## Design

### One sidebar, sections not modes

Delete `groupsView` as a view switch. The sidebar renders a single scrollable column with persistent, independently collapsible sections:

1. **Groups** — every saved group, including grids. Active group marked. One click seats it.
2. **Terminals** — the flat list, retaining the existing workspace/worktree hierarchy and its per-workspace `+` spawn buttons.

Both are visible at once. Collapsed state persists per section. "Show all terminals" disappears as a concept because terminals are never hidden.

Solo mode becomes a state indicated *within* this sidebar (the solo'd terminal marked in the Terminals section), not a mode that changes what the sidebar can display.

### Rapid switching

- One click on a group row seats it. No separate `switch` button — the row **is** the control.
- One click on a terminal row focuses its pane if seated, or solos it if not. Whatever the existing single-click behaviour is, keep it; the requirement is that it needs no mode change first.
- Keyboard: cycle groups and focus panes without the mouse. This is the difference between "switching works" and "switching is rapid," and it is where the current design costs the most — every switch today is at minimum a mode toggle plus a click.

### Visual separation of the two "group" ideas

Seating groups must stop borrowing `worktree-group-header`. Give them their own class and their own visual treatment, distinct from the workspace/worktree hierarchy. Consider retiring the word "group" for one of the two — the structural one is a *workspace* or *worktree*, and saying so removes the collision at the vocabulary level rather than papering over it with styling.

### Group rows

Each row shows: name, layout badge (e.g. `3×3`), live terminal count, and a dirty marker when the current seating has diverged from the saved snapshot. Move `delete` out of the row's primary surface — into an overflow/hover affordance — so it is not adjacent to the row-click that seats the group. **No confirmation dialog**: `window.confirm()` is a silent no-op in VS Code webviews and would make delete do literally nothing. Separation and weight, not a gate.

Add **rename** and **re-save** (update the snapshot to current seating), the latter being the natural resolution of the dirty state.

### Grids are groups

The role-fill action (`role-grid-fill-terminals.md`) creates a saved group named for what it built — "Planners 3×3" — rather than transiently seating panes. Consequences:

- The batch is recallable in one click after the user wanders off to other work, which is the actual daily need once a batch is running.
- No third noun in the UI. The layout picker still exists for ad-hoc seating; groups are the saved form.
- A group that was role-filled can record the role it was built from, so "top up this group to full" is available later without re-deriving intent.

### Identity

Assignments must survive rename and recreation. Prefer a stable terminal identifier over `friendlyName`; if the fleet genuinely has no stable id (per the line 64-66 comment), then either introduce one or make the failure legible — a group row showing "2 of 9 terminals missing" is recoverable, whereas today's silent hole is not. **Do not leave silent holes**; that is the current behaviour and it is the least defensible part of the feature.

### Dirty state

Any manual pane reassignment while a group is seated marks that group dirty. The row shows it; the user can re-save or switch away. `activeGroupId` alone is not sufficient state — it must be paired with a comparison against current `paneAssignments`.

## Verification Plan

1. **Unit — no modal toggle.** Assert groups and terminals are both present in one render; assert `groupsView` (or any successor boolean that hides one section entirely) is gone.
2. **Unit — one-click seat.** Clicking a group row seats it: `paneAssignments` and layout both update, in one interaction.
3. **Unit — solo does not dead-end.** Clicking a group while solo'd either exits solo and seats the group, or reports why it cannot. Assert it is never a silent no-op.
4. **Unit — dirty state.** Seat a group, reassign one pane, assert the row is marked dirty; re-save clears it; switching away and back does not falsely mark it.
5. **Unit — rename.** Renaming a group persists and does not alter its assignments or id.
6. **Unit — delete separation.** Assert delete is not in the row's primary click surface, and that a row click never deletes. Assert no `confirm(` / `window.confirm(` is introduced, matching the existing confirm-gate regression tests.
7. **Unit — identity survives rename.** Rename a terminal that belongs to a group; assert the group still resolves it.
8. **Unit — missing members are legible.** Delete a terminal in a saved group; assert the group row reports the shortfall rather than silently seating a hole.
9. **Unit — grid is a group.** Assert the role-fill action produces a persisted group with the right layout and assignments, and that it appears in the Groups section.
10. **Unit — section collapse persists.** Collapse each section, reload, assert state is restored.
11. **Unit — save button survives.** Assert the save-group control is still present and functional after saving (regression on the `replaceWith` self-destruction at line 547).
12. **Manual (VSIX).** With 9 terminals, 2 saved groups, and one worktree hierarchy: switch between both groups and three individual terminals in under a handful of clicks with no mode changes, confirm the dirty marker appears on manual reassignment, and confirm delete cannot be hit while aiming for switch.

## Dependencies

- **Role Grid Fill** (`role-grid-fill-terminals.md`) — that plan's action should emit a saved group. The two can land in either order; if role-fill lands first, its output becomes a group here.
