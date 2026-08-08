# Terminals Sidebar: Logical Groups That Lock the View

## Goal

Make groups *logical arrangements* — "all planners", "worktree X", "this project" — that cost nothing to create and repair themselves, sit as a tier in the workspace hierarchy, and **lock** the pane view while active. Free composition remains exactly as it is today whenever no group is locked.

### The problem

Groups today are **saved views, not logical arrangements**. `saveCurrentAsGroup` (`src/webview/terminals.js:1181`) freezes the current state:

```js
{ id, name, layout: currentLayout, assignments: paneAssignments.slice(0, getSlotCount(effectiveLayout)) }
```

Three consequences, and each one is a reason the feature goes unused:

1. **Creation is expensive.** A group can only be made by first hand-composing every pane, then saving. Getting "all planners" on screen means seating nine terminals one click at a time — so the arrangement you most want is the one that costs the most to capture.
2. **Membership is a frozen list of names.** The code says so directly (line 64-66): "Names are terminal friendlyNames — the fleet has no stable id, so `renameTerminal` must fixup group assignments." A terminal that exits and is recreated under a different name silently drops out of every group referencing it, leaving a hole nothing explains.
3. **A saved view cannot answer "which group is this terminal in?"** — so clicking a terminal cannot navigate to its group. It can only do what it does now: seat that terminal into whatever grid happens to be showing.

### The second problem: the sidebar is a mode toggle

`groupsView` (line 69) is a boolean that flips the sidebar between the group list and the flat terminal list:

```js
let groupsView = true; // when groups exist + !solo, true → group sidebar, false → flat list
```

`renderGroupSidebar()` emits only group rows plus a "Show all terminals" row that flips the flag back. Reaching a terminal means leaving the groups; returning means leaving the terminals. Groups are not a tier *in* the hierarchy — they are a replacement *for* it.

### Root cause

Groups were modelled as snapshots of the composer's output rather than as sets with meaning. Everything else follows: snapshots are costly to produce, brittle to maintain, and cannot be navigated to. Meanwhile the sidebar treated them as an alternative view rather than a level of the tree, because a snapshot has no natural place in a workspace hierarchy.

### What stays

Free composition is not being removed. `assignToFocusedPane` — including "Pins beat focus. This is the whole feature." (line 1651), displacement, and the undo snapshot — remains the behaviour whenever no group is locked. Groups add a mode; they do not replace the composer.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, ux, refactor

## Reconcile Before Building

This area is being actively reworked locally. Check for unpushed work touching the terminals sidebar, grouping, or pane assignment before starting, and adopt whatever group identity scheme exists rather than minting a second one.

## Design

### Groups become rules, not snapshots

```
{ id, name, source: 'role' | 'worktree' | 'project' | 'manual', value?, layout?, members? }
```

- **Derived groups** (`role`, `worktree`, `project`) compute membership live. Nothing to save, nothing to repair — a new planner terminal joins "Planners" the moment it exists, and a renamed or recreated one never falls out, because membership is recomputed rather than remembered. This alone removes the `friendlyName` brittleness that today's model cannot escape.
- **Manual groups** keep an explicit member list for genuinely ad-hoc sets.

Derived groups are what make creation free, which is the actual complaint. "All planners" should not be something you *build*; it should be something that is simply true once you have planners.

### How groups get created — three paths, cheapest first

The existing "save current as group" flow requires composing every pane before you can capture anything, which is exactly the cost that made the feature go unused. It stays, but it must not remain the only way to get a manual group.

1. **Derived — zero gestures.** Role, worktree, and project groups simply exist once the threshold is met. Nothing to create, name, or maintain.
2. **Multi-select — one gesture.** Select terminal rows in the sidebar (modifier-click / shift-range, matching whatever selection idiom the sidebar already uses), then "Group selected." Name it inline, defaulting to something derived from the members. **No composing required** — the terminals never have to be seated first. This is the path that makes ad-hoc groups cheap, and it is the one missing today.
3. **Save current composition.** The existing `saveCurrentAsGroup` path, retained for when you have hand-arranged something worth keeping. Now one option among three rather than the only door.

### Editing a derived group: detach to manual

A derived group is a rule and cannot be partially edited — but "all planners except the one I'm debugging" is a real need. Offer **detach**: materialise the derived group's current membership into a manual group, which is then freely editable.

Detaching copies membership at that moment and stops tracking the rule, so the copy will not pick up new planners. Say so at the point of detaching — a user expecting a live group to also be editable is expecting a contradiction, and silently freezing it is the confusing outcome.

Adding or removing members on an existing manual group should be possible directly from the sidebar (from the multi-select, or a per-row "add to group"), not only by rebuilding it.

### Which derived groups appear

Show a derived group when it has **two or more members** (threshold configurable). One planner is not an arrangement. This keeps the sidebar from listing a group per role for a user with one of each, while a 3×3 fill of planners produces the "Planners" group automatically, with no save step at all.

Derived groups are visible by default — **do not require opt-in**, which would reintroduce the creation cost this design exists to remove. Give each derived row a hide control, and keep a hidden-list in the same persisted settings as the threshold so it survives reload; surface a way to unhide (a count of hidden groups, or a setting) so a hidden group is not lost. Pinning a group to the top of the list uses the same persisted store.

Hiding a derived group must not affect its membership or its ability to be locked from elsewhere — it is a sidebar display preference, nothing more.

### Placement in the hierarchy

Delete `groupsView` as a view switch. Groups become a tier inside the existing workspace hierarchy, above the terminals they contain:

```
Switchboard (workspace)
  ▸ Planners (9)              ← derived group
  ▸ Coders (4)                ← derived group
  ▸ Review batch (3)          ← manual group
  ▸ Unassigned (2)
      terminal rows…
```

Both groups and terminals are visible at once. Sections collapse independently and persist. "Show all terminals" disappears as a concept because terminals are never hidden.

Seating groups must also stop borrowing `worktree-group-header` (line 1217) — the structural worktree hierarchy and user-facing groups are different things and must not share a visual language. Consider naming the structural tier *workspace* / *worktree* outright, so the word "group" means one thing.

### Lock semantics

Clicking a group **locks** the view to it:

- All panes swap to that group's members. **This overrides pins** — pins protect against incidental reseating by a stray sidebar click, not against deliberate navigation. A locked group is deliberate.
- Clicking a member focuses its pane. It does **not** reseat, because the terminal is already there.
- Clicking a terminal belonging to a *different* group switches the lock to that group — it does not drag the terminal into the current view, which is today's behaviour and the specific thing being replaced.
- Clicking an **unassigned** terminal shows the unassigned set in the currently selected layout.

### Terminal clicks are contextual — this is what preserves the composer

The rules above describe behaviour **while a group is locked**. They must not apply when nothing is locked, or the composer is dead in practice:

| State | Click on a terminal row |
| :--- | :--- |
| **No group locked** | Seats it — `assignToFocusedPane` exactly as today, pins beat focus, displacement, undo |
| **Group locked** | Navigates — focuses a member, or switches the lock to that terminal's group |

Without this split the composer is removed by accident. Derived groups mean nearly every terminal *is* in a group — every terminal has a role, so any role with two terminals forms one, and "unassigned" is nearly empty. A blanket navigate-on-click therefore consumes the seating gesture for almost every row, leaving no way to compose and no gesture to replace it.

The split also matches intent rather than adding a mode to remember: unlocked means *I am arranging*, locked means *I am working inside this set*. And it reads exactly as described — "click a terminal in another group and it shows that group" presupposes you are already in a group, which is the locked state.

Composing therefore needs no new gesture. To compose while locked, drop the lock first (click the locked group row again, or "All terminals") and the sidebar behaves precisely as it does today.

**Do not reach for drag as the compose gesture.** Panes already accept drops, but that target carries a different payload: `.kanban-pane-row` rows are draggable so a *plan card* can be dropped onto a terminal to dispatch it (`terminals.js:2757-2770`, drop handler at 2028). Adding terminal-row drags means one drop target discriminating two payloads, and a mis-typed drop dispatches a plan when the user meant to seat a terminal. If a drag path is wanted later it must branch explicitly on payload type — but the contextual click above removes the need for it.

### Leaving the lock — required, not optional

A locked mode with no visible exit is a trap. Provide both:

- An explicit **"All terminals"** entry at the top of the hierarchy that drops the lock and restores free composition.
- **Composing drops the lock automatically.** Any deliberate compose gesture while locked (drag to a pane, or whatever the composer's assign path is) exits the lock and returns to free seating, keeping the panes as they are. This preserves the composer with no new gesture to learn and no mode the user can get stuck in — the composer's presence *is* the escape.

When a manual group is locked and the user composes, offer to update that group rather than silently diverging. Derived groups are never dirtied — you simply leave them.

### Layout, the pane-size floor, and small screens

A group expresses a *desired* layout — the smallest whose slot count covers its membership (`LAYOUTS`, lines 679-688, up to `3x3` = 9). It does not get to override the floor.

`applyLayoutFloor` reduces the **rendered pane count** when the window is too small, and must: per its own comment, "leaving four pane elements in a two-column grid just reflows them into two implicit rows — i.e. 2x2 again — which is exactly the unreadable grid the floor exists to prevent." `3x3` needs 750×450; a small laptop lands on `2h` (2 slots) or `2v`. Only the first N assignments render.

**This is where a naive group implementation destroys something the composer does today.** On a small screen a user can only fit two terminals legibly, and composing is precisely how they choose *which* two — they seat the ones that matter in the low-numbered slots, because those are the slots that survive a floor drop. Lock a 9-member derived "Planners" group on that laptop and the two visible terminals are whichever the membership enumeration ordered first. The user's most important control is gone, and the group looks broken rather than floored.

Three requirements follow:

1. **Groups carry a member order, and it is user-controllable and persisted.** The first N members occupy the N surviving slots. For derived groups, membership is computed but *order* is a stored display preference keyed to the group — that separation keeps derivation live while giving the user the say that matters.
2. **Reordering within a locked group is the small-screen composition act.** It must not require dropping the lock: needing to leave the group to choose what the group shows is the exact friction this feature is meant to remove.
3. **Paging is keyed to rendered slots, not to nine.** A 4-member group on a 2-slot screen needs paging just as much as a 14-member group on a full one. Page when `members > renderedSlots`.

### Clicking an off-screen group member

This gives the third click case a natural answer. Extending the contextual table:

| State | Click on a terminal row |
| :--- | :--- |
| **No group locked** | Seats it — `assignToFocusedPane` exactly as today |
| **Locked, member visible** | Focuses its pane |
| **Locked, member not currently rendered** | **Promotes it into a visible slot** and persists the new group order |

Clicking a member you cannot see should show it — anything else is a dead click. And promotion *is* composition, scoped to the group and requiring no new gesture, which is how the composer's small-screen role survives the lock.

### The fallback banner needs group-aware text

`applyLayoutFloor` toggles the banner whenever `effectiveLayout !== currentLayout`. For a large group on a small screen that condition is permanently true, and a permanently-visible banner is one users stop reading.

In a locked group the useful message is not "your layout was reduced" but **"showing 2 of 9"**, with the paging control adjacent. State the shortfall and offer the remedy in the same place; do not silently truncate, which would make the group quietly lie about what it contains.

### Bugs to fix in passing

Found while reading, all in this feature:

- **`switchToGroup` is a silent no-op in solo mode** (`if (soloTerminalName) { return; }`, line 1206). Under lock semantics the resolution is clear: the group wins, solo exits.
- **`activeGroupId` never invalidates** — set on create/switch, cleared only on delete. With locks and auto-exit-on-compose this stops being ambiguous, but the state must actually be cleared when the lock drops.
- **`switch` and `delete` are adjacent same-weight text buttons** on every group row (lines 1236-1250), and deletion is immediate. Move delete off the primary click surface. **No confirmation dialog** — `window.confirm()` is a silent no-op in VS Code webviews and would make delete do nothing at all. Separation and weight, not a gate.
- **No rename** for groups; blank names become `Group N` permanently.
- **`btn-save-group` calls `replaceWith(input)` on itself** (line 547), removing the button from the DOM until a re-render.

## Verification Plan

1. **Unit — derived membership is live.** Create a planner terminal; assert it joins the "Planners" group with no save step. Rename it; assert it stays. Kill and recreate under a new name; assert it rejoins — the case today's snapshot model fails.
2. **Unit — threshold.** One terminal of a role produces no derived group; two produce one.
2b. **Unit — multi-select creation.** Select three unseated terminals and group them; assert a manual group is created with exactly those members and that `paneAssignments` is untouched — creation must not require or cause seating.
2c. **Unit — detach.** Detaching a derived group produces a manual group with the same members; assert a subsequently created terminal of that role joins the derived group and **not** the detached copy.
2d. **Unit — edit membership.** Adding and removing members on a manual group persists without rebuilding the group or changing its id.
2e. **Unit — hide/unhide persists.** Hide a derived group, reload, assert it is still hidden and still discoverable via the unhide affordance; assert hiding does not change its membership or prevent it being locked programmatically.
3. **Unit — hierarchy, not toggle.** Assert groups and terminals render in one tree; assert `groupsView` (or any successor boolean that hides one entirely) is gone.
4. **Unit — lock overrides pins.** Pin a pane, click a group, assert all panes swap to the group's members and the pin does not block it.
5. **Unit — click a member.** Clicking a terminal in the locked group focuses its pane and does not reseat or displace anything.
6. **Unit — cross-group click switches lock.** Clicking a terminal belonging to another group locks that group; assert the terminal is not dragged into the previous group's view.
7. **Unit — unassigned.** Clicking an unassigned terminal shows the unassigned set in the current layout.
8. **Unit — composer preserved.** With no lock active, assert `assignToFocusedPane` behaviour is byte-for-byte unchanged: pins beat focus, displacement, and undo all still work. Existing composer tests must pass unmodified.
8b. **Unit — contextual click, the regression this plan nearly shipped.** A terminal that *is* a member of a derived group, clicked with **no lock active**, must seat — not navigate. Assert this for a terminal whose role has two or more instances, since that is the common case and the one a blanket navigate-on-click breaks.
8c. **Unit — drag target untouched.** Assert terminal sidebar rows are not made draggable, and that dropping a `.kanban-pane-row` plan card onto a pane still dispatches exactly as before.
9. **Unit — compose drops the lock.** Composing while locked exits the lock, keeps the panes, and clears the active-group state.
10. **Unit — explicit exit.** "All terminals" drops the lock and restores free composition.
11. **Unit — solo interaction.** Clicking a group while solo'd exits solo and locks the group; assert it is never a silent no-op.
12. **Unit — layout fit.** A 3-member group picks a 3-slot layout; a 9-member group picks `3x3`; a 14-member group pages and reports "1–9 of 14" rather than truncating.
12b. **Unit — floor wins over group desire.** In a viewport below `3x3`'s 750×450 minimum, assert a 9-member group renders the floored pane count (not nine), and that the group's desired layout does not suppress or bypass `applyLayoutFloor`.
12c. **Unit — order controls what survives the floor.** With a 9-member group in a 2-slot viewport, reorder two members to the front; assert exactly those two render, and that the order persists across reload.
12d. **Unit — reorder does not drop the lock.** Reordering members while locked leaves the group locked and does not fall back to free composition.
12e. **Unit — derived order is a preference, not membership.** Reorder a derived group, then add a new terminal of that role; assert it joins the group (membership stayed derived) and the stored order is still honoured.
12f. **Unit — promote off-screen member.** Clicking a locked group member that is not currently rendered brings it into a visible slot and persists the order; assert it is never a no-op.
12g. **Unit — paging keyed to rendered slots.** A 4-member group in a 2-slot viewport offers paging; assert the trigger is `members > renderedSlots`, not `members > 9`.
12h. **Unit — banner text in a group.** With a group locked and the floor tripped, assert the banner reports the shortfall ("showing 2 of 9") rather than the generic layout-reduced message, and that a paging control is present alongside it.
13. **Unit — delete separation.** A row click never deletes; assert no `confirm(` / `window.confirm(` is introduced, matching the existing confirm-gate regression tests.
14. **Unit — save button survives.** The save-group control is still present and functional after saving (regression on line 547).
15. **Manual (VSIX).** With 9 planners, 4 coders, and 2 terminals in a worktree: confirm Planners/Coders/worktree groups appear with no setup, clicking between them swaps the whole view over a pin, clicking a coder while Planners is locked switches to Coders, and composing by hand drops the lock and behaves exactly as it does today.

## Dependencies

- **Role Grid Fill** (`role-grid-fill-terminals.md`) — with derived groups, a role-filled grid produces its group automatically; that plan no longer needs to persist one explicitly.
