# Terminals Sidebar: Logical Groups That Lock the View

## Goal

Make groups *logical arrangements* — "all planners", "worktree X", "this project" — that cost nothing to create and repair themselves, sit as a tier in the workspace hierarchy, and **lock** the pane view while active. Free composition remains exactly as it is today whenever no group is locked.

### The problem

Groups today are **saved views, not logical arrangements**. `saveCurrentAsGroup` (`src/webview/terminals.js:1317`, all line references in this plan verified against the working tree on 2026-08-08) freezes the current state:

```js
{ id, name, layout: currentLayout, assignments: paneAssignments.slice(0, getSlotCount(effectiveLayout)) }
```

Three consequences, and each one is a reason the feature goes unused:

1. **Creation is expensive.** A group can only be made by first hand-composing every pane, then saving. Getting "all planners" on screen means seating nine terminals one click at a time — so the arrangement you most want is the one that costs the most to capture.
2. **Membership is a frozen list of names.** The code says so directly (lines 62-66): "Names are terminal friendlyNames — the fleet has no stable id, so `renameTerminal` must fixup group assignments." A terminal that exits and is recreated under a different name silently drops out of every group referencing it, leaving a hole nothing explains.
3. **A saved view cannot answer "which group is this terminal in?"** — so clicking a terminal cannot navigate to its group. It can only do what it does now: seat that terminal into whatever grid happens to be showing.

### The second problem: the sidebar is a mode toggle

`groupsView` (line 69) is a boolean that flips the sidebar between the group list and the flat terminal list:

```js
let groupsView = true; // when groups exist + !solo, true → group sidebar, false → flat list
```

`renderGroupSidebar()` (line 1350) emits only group rows plus a "Show all terminals" row that flips the flag back (lines 1397-1406). Reaching a terminal means leaving the groups; returning means leaving the terminals. Groups are not a tier *in* the hierarchy — they are a replacement *for* it.

### Root cause

Groups were modelled as snapshots of the composer's output rather than as sets with meaning. Everything else follows: snapshots are costly to produce, brittle to maintain, and cannot be navigated to. Meanwhile the sidebar treated them as an alternative view rather than a level of the tree, because a snapshot has no natural place in a workspace hierarchy.

### What stays

Free composition is not being removed. `assignToFocusedPane` (line 1760) — including "Pins beat focus. This is the whole feature." (line 1787), displacement, and the undo snapshot — remains the behaviour whenever no group is locked. Groups add a mode; they do not replace the composer.

> **Superseded:** "Clicking a terminal row seats it — `assignToFocusedPane` exactly as today."
> **Reason:** The sidebar row click handler (line 1310) calls `locateTerminal(name)` (line 1752), not `assignToFocusedPane` directly. `locateTerminal` seats **and then hands the terminal the caret** via `focusPaneTerminal` — and `shell-terminal-strip.test.js` asserts exactly that pairing ("locateTerminal seats the terminal AND gives it the caret"). A change that preserved only `assignToFocusedPane` would silently drop the caret half and break that shipped contract test.
> **Replaced with:** The unlocked row click must keep calling `locateTerminal`, preserving both halves. Every reference to "the composer's seating path" in this plan means `locateTerminal` → `assignToFocusedPane` + `focusPaneTerminal`.

## Metadata

**Complexity:** 7
**Tags:** frontend, ui, ux, refactor

## User Review Required

None. Every open question in this plan is decided below (derived sources reduced to role + worktree; lock survives reload; pins are not cleared by a lock; page index is transient).

## Reconcile Before Building

This area is being actively reworked locally — `src/webview/terminals.js`, `terminals.html`, `shell.js`, `TaskViewerProvider.ts` and `KanbanProvider.ts` all carry uncommitted changes as of 2026-08-08, and the line numbers in the previously-written version of this plan had already drifted by 100-200 lines. Re-grep the symbols (`saveCurrentAsGroup`, `switchToGroup`, `renderGroupSidebar`, `renderSidebarList`, `applyLayoutFloor`) rather than trusting any line number here, and adopt whatever group identity scheme exists rather than minting a second one.

## Design

### Groups become rules, not snapshots

```
{ id, name, source: 'role' | 'worktree' | 'manual', value?, layout?, members?, order? }
```

- **Derived groups** (`role`, `worktree`) compute membership live from `fleetList`. Nothing to save, nothing to repair — a new planner terminal joins "Planners" the moment it exists, and a renamed or recreated one never falls out, because membership is recomputed rather than remembered. This alone removes the `friendlyName` brittleness that today's model cannot escape.
- **Manual groups** keep an explicit member list for genuinely ad-hoc sets.

Derived groups are what make creation free, which is the actual complaint. "All planners" should not be something you *build*; it should be something that is simply true once you have planners.

> **Superseded:** Derived sources are `role`, `worktree`, and `project`.
> **Reason:** There is no project attribute on a terminal. The fleet rows the sidebar renders from (`ptyListTerminals` → `fleetList`) carry `friendlyName`, `role`, `status`, `pid`, `startTime`, `worktreePath` and `parentRoot` — and nothing else (see the registry mirror at `TaskViewerProvider.ts:2033-2043`). `parentRoot` is the *workspace*, and the sidebar already renders workspaces as the structural hierarchy tier (`renderSidebarList`, parent groups at line 1489). A `project` derived group would therefore either be undefined or duplicate the workspace tier under a second name — the exact "the word 'group' means two things" confusion this plan sets out to remove.
> **Replaced with:** Derived sources are **`role` and `worktree` only**. The workspace/parent tier stays where it is, as structure, and is not re-expressed as a group.

### Tolerating the existing group store — a clean break, not a migration

> **Superseded:** "`terminals.groups` is **persisted user state that has shipped**… Per the workspace rule, shipped state must be migrated, never broken," followed by a two-direction migration requiring unknown-key preservation.
> **Reason:** Checked against git. `terminalGroups` first appears in `src/webview/terminals.js` at commit `1c7de0f6` (2026-08-06). The last released VSIX before that is `switchboard-1.7.12.vsix` (2026-07-12); `1.7.13` was only built on 2026-08-08. The group store has therefore **never existed in a released version**, and the repo rule is explicit that features which have only ever existed in unreleased dev work take clean breaks — no migrations, no compat shims. Treating it as shipped state buys nothing and costs a whole workstream.
> **Replaced with:** the reduced requirement below.

The only state that must survive is whatever the operator saved while testing the dev build locally. That is a one-line tolerance, not a migration programme:

1. **Reading existing rows.** The current shape guard rejects anything without a `layout` in `LAYOUT_MODES` *and* an `assignments` array:

   ```js
   terminalGroups = savedGroups.filter(g =>
       g && typeof g.id === 'string' && typeof g.name === 'string' &&
       LAYOUT_MODES.includes(g.layout) && Array.isArray(g.assignments)
   );
   ```

   A new-shape group (`source`, `members`, no `assignments`) fails that filter and is **silently dropped on load**. Widen the guard to accept either shape, then normalise a legacy row in place:

   ```
   { id, name, layout, assignments }
     → { id, name, source: 'manual', layout, members: assignments.filter(Boolean),
         order: assignments.filter(Boolean) }
   ```

   Seat order is the existing `assignments` order with holes removed — that is the arrangement the operator captured, and it becomes the group's member order for free.

2. **`terminals.groupsView` is simply no longer read or written.** Any stale value already in the `config` table is inert. No cleanup, no compat shim — this is the clean break the unreleased-state rule allows.

No unknown-key preservation, no two-way compatibility with an older client, and no defensive handling of shapes that were never released. If a test-build group fails the widened guard, it is dropped — the operator re-saves it in seconds.

### How groups get created — three paths, cheapest first

The existing "save current as group" flow requires composing every pane before you can capture anything, which is exactly the cost that made the feature go unused. It stays, but it must not remain the only way to get a manual group.

1. **Derived — zero gestures.** Role and worktree groups simply exist once the threshold is met. Nothing to create, name, or maintain.
2. **Multi-select — one gesture.** Select terminal rows in the sidebar (modifier-click / shift-range), then "Group selected." Name it inline, defaulting to something derived from the members. **No composing required** — the terminals never have to be seated first. This is the path that makes ad-hoc groups cheap, and it is the one missing today.
3. **Save current composition.** The existing `saveCurrentAsGroup` path, retained for when you have hand-arranged something worth keeping. Now one option among three rather than the only door.

The sidebar has no selection idiom today — rows have a single click handler and no selected state. Multi-select introduces one, and it must not collide with the seating click: a plain click still seats (or navigates, when locked), and only a modifier-click enters/extends a selection. While a selection is non-empty, the "Group selected" action appears; clearing the selection removes it.

### Editing a derived group: detach to manual

A derived group is a rule and cannot be partially edited — but "all planners except the one I'm debugging" is a real need. Offer **detach**: materialise the derived group's current membership into a manual group, which is then freely editable.

Detaching copies membership at that moment and stops tracking the rule, so the copy will not pick up new planners. Say so at the point of detaching — a user expecting a live group to also be editable is expecting a contradiction, and silently freezing it is the confusing outcome.

Adding or removing members on an existing manual group should be possible directly from the sidebar (from the multi-select, or a per-row "add to group"), not only by rebuilding it.

### Which derived groups appear

Show a derived group when it has **two or more members** (threshold configurable). One planner is not an arrangement. This keeps the sidebar from listing a group per role for a user with one of each, while a 3×3 fill of planners produces the "Planners" group automatically, with no save step at all.

Derived groups are visible by default — **do not require opt-in**, which would reintroduce the creation cost this design exists to remove. Give each derived row a hide control, and keep a hidden-list in the same persisted settings as the threshold so it survives reload; surface a way to unhide (a count of hidden groups, or a setting) so a hidden group is not lost. Pinning a group to the top of the list uses the same persisted store.

Hiding a derived group must not affect its membership or its ability to be locked from elsewhere — it is a sidebar display preference, nothing more.

**Persistence key.** Threshold, hidden ids, pinned ids and per-derived-group member order are one object under a single new setting (e.g. `terminals.groupPrefs`), written through the existing `saveSetting` helper alongside the others in `saveLayoutSettings`. One key, not four: `saveLayoutSettings` already issues eleven separate `saveSetting` fetches per call, and adding four more to a function invoked on every seat, pin, unassign and layout change is gratuitous network churn.

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

Both groups and terminals are visible at once. Sections collapse independently and persist (the existing `collapsedGroups` set and its `terminals.collapsedGroups` setting already carry per-section collapse state — extend its key namespace rather than adding a second store). "Show all terminals" disappears as a concept because terminals are never hidden.

Seating groups must also stop borrowing `worktree-group-header` (line 1353) — the structural worktree hierarchy and user-facing groups are different things and must not share a visual language. Consider naming the structural tier *workspace* / *worktree* outright, so the word "group" means one thing.

### Lock semantics

Clicking a group **locks** the view to it:

- All panes swap to that group's members. **This overrides pins** — pins protect against incidental reseating by a stray sidebar click, not against deliberate navigation. A locked group is deliberate.
- Clicking a member focuses its pane. It does **not** reseat, because the terminal is already there.
- Clicking a terminal belonging to a *different* group switches the lock to that group — it does not drag the terminal into the current view, which is today's behaviour and the specific thing being replaced.
- Clicking an **unassigned** terminal shows the unassigned set in the currently selected layout.

**Locking does not clear pins.** `pinnedPanes` is per-*slot*, not per-terminal — "Index-keyed, not name-keyed: that is what lets `renameTerminal` leave pins alone, and it matches the operator's mental model ('the left pane stays put'), which is about the seat, not the occupant" (lines 13-15). A lock reseats slots; the pin flags stay where they are and now protect the group member occupying that seat. Do **not** clear pins on lock: clearing them would destroy persisted state on a navigation gesture, and re-deriving them afterwards is undefined. The invariant `pinnedPanes[i] → paneAssignments[i]` must still hold after the swap, so any slot a group leaves empty has its pin cleared, exactly as `sanitizePaneAssignments` (lines 1075-1077) already does.

**The lock survives reload.** `activeGroupId` is already persisted and restored (lines 761-762, 803). Keep that: a lock is a deliberate statement about what you are working on, and losing it on every reload would make the feature feel like it forgot. This is the opposite call from Peek, which must *not* survive reload — and the difference is exactly the point: a lock is durable intent, a peek is a glance.

### Terminal clicks are contextual — this is what preserves the composer

The rules above describe behaviour **while a group is locked**. They must not apply when nothing is locked, or the composer is dead in practice:

| State | Click on a terminal row |
| :--- | :--- |
| **No group locked** | Seats it — `locateTerminal` exactly as today, pins beat focus, displacement, undo, caret |
| **Group locked** | Navigates — focuses a member, or switches the lock to that terminal's group |

Without this split the composer is removed by accident. Derived groups mean nearly every terminal *is* in a group — every terminal has a role, so any role with two terminals forms one, and "unassigned" is nearly empty. A blanket navigate-on-click therefore consumes the seating gesture for almost every row, leaving no way to compose and no gesture to replace it.

The split also matches intent rather than adding a mode to remember: unlocked means *I am arranging*, locked means *I am working inside this set*. And it reads exactly as described — "click a terminal in another group and it shows that group" presupposes you are already in a group, which is the locked state.

Composing therefore needs no new gesture. To compose while locked, drop the lock first (click the locked group row again, or "All terminals") and the sidebar behaves precisely as it does today.

#### The state must be legible — but do not add a mode switch

Contextual clicks introduce hidden state: the same gesture seats or navigates depending on the lock. If the user cannot tell which state they are in, they cannot predict what a click does — which is worse than the `groupsView` toggle this plan removes, because that at least announced itself.

Make the state readable, in one place:

- The locked group row is visibly active; when nothing is locked, no row is.
- The sidebar header carries a persistent, low-key indicator — the locked group's name, or "Composing" when free. Clicking it drops the lock.
- **"All terminals" is the switch**, expressed as the zeroth entry of the hierarchy rather than a separate control. Label it so its effect is stated, not inferred (e.g. "All terminals — free composition").

**Do not add a separate composer/groups toggle.** Lock state is already fully expressed by which group row is active, so a toggle would be a second control for one piece of state — and two controls for one fact drift. It also has no defined behaviour in the obvious case: flipping to "Groups" while nothing is locked has nothing to lock.

Worse, a toggle invites decoupling "which group is locked" from "what a click does", allowing a locked group in compose mode — at which point clicking a group member has no coherent meaning. Those two facts must stay welded together; that is what keeps the model predictable, and the promote-into-view behaviour already covers the case a decoupled mode would be reaching for.

**Do not reach for drag as the compose gesture.** Panes already accept drops, but that target carries a different payload: `.kanban-pane-row` rows are draggable so a *plan card* can be dropped onto a terminal to dispatch it (row construction at line 2932, drop handling reached from `createPaneElement`). Adding terminal-row drags means one drop target discriminating two payloads, and a mis-typed drop dispatches a plan when the user meant to seat a terminal. There is already a `buttonPressRowEl` drag-disarm hack (line 35, handler at 450-468) working around the ambiguity that exists *today* with one payload type; adding a second is moving the wrong way. If a drag path is wanted later it must branch explicitly on payload type — but the contextual click above removes the need for it.

### Leaving the lock — required, not optional

A locked mode with no visible exit is a trap. Provide both:

- An explicit **"All terminals"** entry at the top of the hierarchy that drops the lock and restores free composition.
- **Composing drops the lock automatically.** Any deliberate compose gesture while locked (drag to a pane, or whatever the composer's assign path is) exits the lock and returns to free seating, keeping the panes as they are. This preserves the composer with no new gesture to learn and no mode the user can get stuck in — the composer's presence *is* the escape.

When a manual group is locked and the user composes, offer to update that group rather than silently diverging. Derived groups are never dirtied — you simply leave them.

### Layout, the pane-size floor, and small screens

A group expresses a *desired* layout — the smallest whose slot count covers its membership (`LAYOUTS`, lines 690-700, up to `3x3` = 9). It does not get to override the floor.

The existing `switchToGroup` already routes its layout choice through `setLayoutMode` (line 1346), which calls `applyLayoutFloor` (line 1738) — so "the floor wins over the group's desire" is already how the code behaves, and `terminal-sidebar-groupings-contract.test.js` asserts it ("switchToGroup routes through setLayoutMode (honours pane-size floor)"). **Preserve that routing exactly.** Setting `currentLayout` or `effectiveLayout` directly from the lock path is the regression to avoid.

`applyLayoutFloor` reduces the **rendered pane count** when the window is too small, and must: per its own comment (lines 3207-3212), "leaving four pane elements in a two-column grid just reflows them into two implicit rows — i.e. 2x2 again — which is exactly the unreadable grid the floor exists to prevent." `3x3` needs 750×450; a small laptop lands on `2h` (2 slots) or `2v`. Only the first N assignments render.

**This is where a naive group implementation destroys something the composer does today.** On a small screen a user can only fit two terminals legibly, and composing is precisely how they choose *which* two — they seat the ones that matter in the low-numbered slots, because those are the slots that survive a floor drop. Lock a 9-member derived "Planners" group on that laptop and the two visible terminals are whichever the membership enumeration ordered first. The user's most important control is gone, and the group looks broken rather than floored.

Three requirements follow:

1. **Groups carry a member order, and it is user-controllable and persisted.** The first N members occupy the N surviving slots. For derived groups, membership is computed but *order* is a stored display preference keyed to the group (in `terminals.groupPrefs`) — that separation keeps derivation live while giving the user the say that matters. A member present in the order but absent from live membership is skipped, not rendered as a hole; a live member absent from the stored order sorts to the end using the existing `compareTerminals` total order (line 1417), so a new terminal never lands in front of a deliberately-ordered set.
2. **Reordering within a locked group is the small-screen composition act.** It must not require dropping the lock: needing to leave the group to choose what the group shows is the exact friction this feature is meant to remove.
3. **Paging is keyed to rendered slots, not to nine.** A 4-member group on a 2-slot screen needs paging just as much as a 14-member group on a full one. Page when `members > renderedSlots`, where `renderedSlots = getSlotCount(effectiveLayout)`.

**The page index is transient, not persisted.** It is a scroll position, not a preference, and a group that reopens on page 3 is a group that looks empty. Member *order* is persisted; where you happened to be in it is not. Reset the page index to 0 whenever the lock changes group or the floor changes the rendered slot count.

### Clicking an off-screen group member

This gives the third click case a natural answer. Extending the contextual table:

| State | Click on a terminal row |
| :--- | :--- |
| **No group locked** | Seats it — `locateTerminal` exactly as today |
| **Locked, member visible** | Focuses its pane |
| **Locked, member not currently rendered** | **Promotes it into a visible slot** and persists the new group order |

Clicking a member you cannot see should show it — anything else is a dead click. And promotion *is* composition, scoped to the group and requiring no new gesture, which is how the composer's small-screen role survives the lock.

Promotion swaps the clicked member into the last rendered slot (not the first), so the pane the user was already reading is the one least likely to be displaced.

### The fallback banner needs group-aware text

`applyLayoutFloor` toggles the banner whenever `effectiveLayout !== currentLayout` (line 3219). For a large group on a small screen that condition is permanently true, and a permanently-visible banner is one users stop reading.

In a locked group the useful message is not "your layout was reduced" but **"showing 2 of 9"**, with the paging control adjacent. State the shortfall and offer the remedy in the same place; do not silently truncate, which would make the group quietly lie about what it contains.

Note the banner is suppressed entirely in solo (`body.is-solo .layout-fallback-banner`, `terminals.html:1365`) — the group-aware text inherits that and needs no separate guard.

### Bugs to fix in passing

Found while reading, all in this feature:

- **`switchToGroup` is a silent no-op in solo mode** (`if (soloTerminalName) { return; }`, line 1340). Under lock semantics the resolution is clear: the group wins, solo exits.
- **`activeGroupId` never invalidates** — set on create/switch (lines 1326, 1344), cleared only on delete (line 1334). With locks and auto-exit-on-compose this stops being ambiguous, but the state must actually be cleared when the lock drops.
- **`switch` and `delete` are adjacent same-weight text buttons** on every group row (lines 1371-1391), and deletion is immediate. Move delete off the primary click surface. **No confirmation dialog** — `window.confirm()` is a silent no-op in VS Code webviews and would make delete do nothing at all. Separation and weight, not a gate.
- **No rename** for groups; blank names become `Group N` permanently (line 1321).
- **`btn-save-group` calls `replaceWith(input)` on itself** (line 555), removing the button from the DOM until a re-render.

## Complexity Audit

### Routine

- Rendering group rows and terminal rows in one tree instead of two mutually exclusive branches — `renderSidebarList` already builds a nested parent/worktree hierarchy; groups become another tier in the same builder.
- Group rename, delete-button separation, and the `btn-save-group` `replaceWith` fix are small, local edits.
- Deriving role and worktree membership from `fleetList` — the data is already in hand and `compareTerminals` already gives a total order.
- Reusing `setLayoutMode` for the lock's layout choice (the existing `switchToGroup` already does it).

### Complex / Risky

- **Rewriting `src/test/terminal-sidebar-groupings-contract.test.js`.** It is a static source-scanning test that asserts the exact things this plan removes: `let groupsView = true;`, the solo no-op in `switchToGroup`, the "Show all terminals" → `groupsView = false` toggle, the "Show groups" reverse toggle, `saveLayoutSettings` persisting `groupsView`, and the legacy-only shape guard in `loadLayoutSettings`. Every one of those assertions must be replaced with its successor, not deleted — the test is the contract, and dropping an assertion is dropping the guarantee.
- **The contextual-click split.** One gesture with two meanings, gated on lock state. Getting the gate wrong removes the composer for almost every terminal (see 8b in the verification plan).
- **Pin/lock interaction.** Pins are slot-keyed and persisted; a lock reseats slots. The invariant `pinnedPanes[i] → paneAssignments[i]` must survive the swap.
- **Member order as the small-screen composition control.** Derivation must stay live while order stays a stored preference; conflating the two re-freezes the group.
- Introducing a selection idiom into a sidebar whose rows currently have exactly one click meaning.

## Edge-Case & Dependency Audit

### Race Conditions

- `fetchTerminalList` runs on a poll timer (`fleetPollTimer`) and on `terminalsChanged` pushes. Derived membership is recomputed from `fleetList` on every render, so a terminal appearing or exiting mid-interaction changes group size under the user. A locked group whose membership shrinks below the threshold must **not** silently unlock — keep the lock and render what remains, because the alternative is the view snapping back to free composition without a gesture.
- `saveLayoutSettings` fires eleven independent `saveSetting` POSTs with no transaction. A reload landing between the `terminals.groups` write and the `terminals.groupPrefs` write yields groups with no prefs. Both readers must tolerate a missing counterpart (empty prefs = defaults; prefs referencing a deleted group id = ignored).
- The lock writes `paneAssignments`; `sanitizePaneAssignments` runs on every list refresh and nulls slots whose terminal is not in `liveNames`. A group locked onto a terminal that exits one tick later loses that slot — expected, and the pin-expiry loop (lines 1075-1077) already clears the orphaned pin.

### Security

- Group names are user-supplied and reach the DOM. The existing rows use `textContent` (lines 1361, 1366) — keep it. No `innerHTML` for any group-authored string.
- Group state round-trips through `getSetting`/`saveSetting` verbs, i.e. across the HTTP boundary in the standalone host. The load-time shape guard is the validation boundary and must remain (widened, not removed): a malformed persisted row must be dropped, never rendered or executed.

### Side Effects

- Deleting `groupsView` as a *read* changes first-paint behaviour for every existing user who had it `false`: they will now see the hierarchy instead of the flat list. That is the intent, and it is not a data loss.
- `renameTerminal`'s existing group-assignment fixup remains necessary for **manual** groups and unnecessary for derived ones. Do not delete it; scope it to manual members.
- The lock reseating all panes triggers a full `renderPaneGrid`, which for a shrinking slot count removes surplus pane elements and re-parents their terminal containers. That is the existing cost of any layout change and is acceptable for a deliberate navigation — it is precisely why **Peek must not** use this path (see that plan).

### Dependencies & Conflicts

- **Shares `src/webview/terminals.js` with both sibling subtasks.** Per the project PRD's orchestration rule (one agent stream per file), this plan and Terminal Peek must not be coded in parallel by different agents.
- Owns the sidebar row surface. Peek adds a control to the same row and must place it per this plan's action ordering (leftmost, away from `close`).
- Owns lock state. Peek reads it (peek must not drop the lock) but never writes it.

## Dependencies

- None on other features. Within this feature: **land before Terminal Peek** — this plan defines the locked-view state Peek must restore back into, and both edit `terminals.js`.

## Adversarial Synthesis

Key risks: silently deleting every user's saved groups via a too-narrow load guard; removing the composer by accident because derived groups make almost every terminal a group member; and breaking `terminal-sidebar-groupings-contract.test.js`, which statically asserts the exact symbols this plan deletes. Mitigations: a two-way shape migration that spreads unknown keys through, a lock-gated contextual click with a dedicated regression test for the unlocked-member-of-a-derived-group case, and an explicit rewrite (not deletion) of every assertion in the contract test. Secondary risk — the group's desired layout bypassing `applyLayoutFloor` — is neutralised by keeping the existing `switchToGroup → setLayoutMode` routing.

## Proposed Changes

### `src/webview/terminals.js`

- **Context:** Group state (lines 62-69), `saveCurrentAsGroup`/`deleteGroup`/`switchToGroup`/`renderGroupSidebar` (1317-1407), `renderSidebarList` (1450+), `loadLayoutSettings`/`saveLayoutSettings` (744-805), `setLayoutMode` (1727), `applyLayoutFloor` (3213).
- **Logic:** Replace the snapshot group model with the rule model; replace the `groupsView` branch in `renderSidebarList` with a groups tier rendered above the workspace tiers; gate the row click on lock state; add member order, hide/pin prefs, paging, and detach.
- **Implementation:** Widen the load guard and normalise legacy rows before assigning `terminalGroups`. Add `terminals.groupPrefs` to the save/load pair. Keep `switchToGroup`'s `setLayoutMode` call. Clear `activeGroupId` on every unlock path. Split `renderGroupSidebar` into a `renderGroupTier` that appends rather than returns early.
- **Edge cases:** Locked group shrinks below threshold (keep lock); solo active (group wins, solo exits); prefs referencing a deleted group id (ignore); order entry for a departed terminal (skip, do not render a hole).

### `src/webview/terminals.html`

- **Context:** `#btn-save-group` (line 1412), the sidebar list container, `.worktree-group-header` styling, `.layout-fallback-banner` (1213-1221, solo suppression at 1365).
- **Logic:** New visual language for the groups tier distinct from `worktree-group-header`; header lock indicator; selection state on terminal rows; paging control adjacent to the banner.
- **Edge cases:** Banner text differs inside a locked group; both variants must stay suppressed under `body.is-solo`.

### `src/test/terminal-sidebar-groupings-contract.test.js`

- **Context:** Static assertions over `terminals.js` source covering group state, persistence, the solo guard, and the view toggles.
- **Logic:** Rewrite each assertion against the new model rather than removing it — the group store shape guard becomes a two-shape guard assertion; the solo no-op becomes a solo-exits assertion; the `groupsView` toggle assertions become lock-indicator and "All terminals" assertions.
- **Edge cases:** The test reads source between markers; changing function boundaries changes what `block()` captures. Re-verify every marker string still resolves.

## Verification Plan

### Automated Tests

1. **Unit — derived membership is live.** Create a planner terminal; assert it joins the "Planners" group with no save step. Rename it; assert it stays. Kill and recreate under a new name; assert it rejoins — the case today's snapshot model fails.
2. **Unit — threshold.** One terminal of a role produces no derived group; two produce one.
2b. **Unit — multi-select creation.** Select three unseated terminals and group them; assert a manual group is created with exactly those members and that `paneAssignments` is untouched — creation must not require or cause seating.
2c. **Unit — detach.** Detaching a derived group produces a manual group with the same members; assert a subsequently created terminal of that role joins the derived group and **not** the detached copy.
2d. **Unit — edit membership.** Adding and removing members on a manual group persists without rebuilding the group or changing its id.
2e. **Unit — hide/unhide persists.** Hide a derived group, reload, assert it is still hidden and still discoverable via the unhide affordance; assert hiding does not change its membership or prevent it being locked programmatically.
2f. **Unit — existing dev-build groups still load.** Load a `terminals.groups` value in the current shape (`{id,name,layout,assignments}`) and assert it survives as a manual group with `members` equal to `assignments.filter(Boolean)` and `order` matching the existing seat order — so a group saved while testing the dev build is not silently dropped by the widened guard.
2h. **Unit — no derived `project` source.** Assert the derived sources are exactly `role` and `worktree`, and that nothing reads a project attribute off a fleet row.
3. **Unit — hierarchy, not toggle.** Assert groups and terminals render in one tree; assert `groupsView` (or any successor boolean that hides one entirely) is no longer read. Assert the persisted `terminals.groupsView` key is *not* deleted from the store.
4. **Unit — lock overrides pins.** Pin a pane, click a group, assert all panes swap to the group's members and the pin does not block it.
4b. **Unit — lock does not clear pins, and the pin invariant holds.** After locking, assert `pinnedPanes` flags are unchanged for slots the group filled, and cleared for any slot the group left empty (`pinnedPanes[i] → paneAssignments[i]`).
5. **Unit — click a member.** Clicking a terminal in the locked group focuses its pane and does not reseat or displace anything.
6. **Unit — cross-group click switches lock.** Clicking a terminal belonging to another group locks that group; assert the terminal is not dragged into the previous group's view.
7. **Unit — unassigned.** Clicking an unassigned terminal shows the unassigned set in the current layout.
8. **Unit — composer preserved.** With no lock active, assert the seating path is unchanged: `locateTerminal` still seats via `assignToFocusedPane` **and** focuses via `focusPaneTerminal`, pins beat focus, displacement and undo still work. Existing composer tests (`terminal-pane-pinning-contract.test.js`, `shell-terminal-strip.test.js`) must pass unmodified.
8b. **Unit — contextual click, the regression this plan nearly shipped.** A terminal that *is* a member of a derived group, clicked with **no lock active**, must seat — not navigate. Assert this for a terminal whose role has two or more instances, since that is the common case and the one a blanket navigate-on-click breaks.
8c. **Unit — drag target untouched.** Assert terminal sidebar rows are not made draggable, and that dropping a `.kanban-pane-row` plan card onto a pane still dispatches exactly as before.
8d. **Unit — lock state is legible.** Assert the header indicator names the locked group, reads "Composing" when nothing is locked, and that clicking it drops the lock. Assert exactly one control mutates lock state besides group rows themselves — no separate composer/groups toggle exists.
9. **Unit — compose drops the lock.** Composing while locked exits the lock, keeps the panes, and clears `activeGroupId`.
10. **Unit — explicit exit.** "All terminals" drops the lock and restores free composition.
10b. **Unit — lock survives reload.** Lock a group, reload; assert the same group is locked and its members are seated.
11. **Unit — solo interaction.** Clicking a group while solo'd exits solo and locks the group; assert it is never a silent no-op.
12. **Unit — layout fit.** A 3-member group picks a 3-slot layout; a 9-member group picks `3x3`; a 14-member group pages and reports "1–9 of 14" rather than truncating.
12b. **Unit — floor wins over group desire.** In a viewport below `3x3`'s 750×450 minimum, assert a 9-member group renders the floored pane count (not nine), and that the lock path still routes through `setLayoutMode` → `applyLayoutFloor` rather than writing `effectiveLayout` directly.
12c. **Unit — order controls what survives the floor.** With a 9-member group in a 2-slot viewport, reorder two members to the front; assert exactly those two render, and that the order persists across reload.
12d. **Unit — reorder does not drop the lock.** Reordering members while locked leaves the group locked and does not fall back to free composition.
12e. **Unit — derived order is a preference, not membership.** Reorder a derived group, then add a new terminal of that role; assert it joins the group (membership stayed derived) and the stored order is still honoured, with the newcomer sorted to the end.
12f. **Unit — promote off-screen member.** Clicking a locked group member that is not currently rendered brings it into a visible slot and persists the order; assert it is never a no-op, and that it displaces the last rendered slot rather than the first.
12g. **Unit — paging keyed to rendered slots.** A 4-member group in a 2-slot viewport offers paging; assert the trigger is `members > getSlotCount(effectiveLayout)`, not `members > 9`.
12h. **Unit — page index is transient.** Page to the second page, reload; assert the group opens on page 0. Assert the page index also resets when the lock moves to a different group and when the floor changes the rendered slot count.
12i. **Unit — banner text in a group.** With a group locked and the floor tripped, assert the banner reports the shortfall ("showing 2 of 9") rather than the generic layout-reduced message, and that a paging control is present alongside it. Assert both variants stay hidden under `body.is-solo`.
12j. **Unit — locked group shrinking below threshold.** A locked derived group whose membership drops to one stays locked and renders the remaining member; assert it does not silently revert to free composition.
13. **Unit — delete separation.** A row click never deletes; assert no `confirm(` / `window.confirm(` is introduced, matching the existing confirm-gate regression tests.
14. **Unit — save button survives.** The save-group control is still present and functional after saving (regression on line 555).
15. **Contract test rewritten, not weakened.** Assert `src/test/terminal-sidebar-groupings-contract.test.js` still contains an assertion for each of: group store declaration, load-time shape guard, save-time persistence, solo behaviour, and the sidebar's group/flat composition. Count of assertions must not decrease.
16. **Manual (VSIX).** With 9 planners, 4 coders, and 2 terminals in a worktree: confirm Planners/Coders/worktree groups appear with no setup, clicking between them swaps the whole view over a pin, clicking a coder while Planners is locked switches to Coders, and composing by hand drops the lock and behaves exactly as it does today. Then reload and confirm the lock and member order both came back.

## Recommendation

Complexity 7 — **Send to Lead Coder.**

## Review Findings

Reviewer pass fixed four defects in `src/webview/terminals.js` / `terminals.html`: `renderGroupSidebar` cleared any non-`__groups__` `pickerState` on every render (the tier no longer early-returns), killing every per-workspace `+` role picker, and never reported a mounted picker so the post-loop sweep dropped its own; the lock reseated slots without enforcing `pinnedPanes[i] → paneAssignments[i]`; clicking an unassigned terminal dropped the lock instead of locking the unassigned set; and paging (`activeGroupPage`) was declared but never implemented, so a locked group larger than the floored slot count silently truncated. Seating was split into `seatActiveGroupPage()` — page slice keyed to `getSlotCount(effectiveLayout)`, pin invariant enforced, page re-clamped when the floor moves — with prev/next controls in the shortfall banner, plus an unhide affordance for hidden derived groups and a one-shot guard on the inline name inputs (Enter-then-blur was saving two groups). The contract test regained the deleted role-picker suite and gained paging/pin/promotion assertions: 29 passing, up from the 22 it shipped with and above the 38-assertion pre-rework baseline. Validation: `tsc -p tsconfig.test.json` clean, `terminal-sidebar-groupings` 29/29, `terminal-pane-pinning` 15/15, `terminal-solo-popout` 11/11, `multi-parent-terminals` 29/29. Remaining risk: group rename is still unimplemented (listed under "Bugs to fix in passing"), and the threshold/pin prefs are persisted but have no UI.
