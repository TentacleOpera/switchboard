# You Can Never Delete A Group — Give Every Group Source A Working Delete

## Goal

Make `delete` available and immediate on **every** group in the terminals sidebar, whatever its source. One control, one meaning, no dead ends.

### The problem

Reported from UAT: *"you can never delete a group."* Confirmed — for this operator's board, literally true.

`renderGroupSidebar()` (`src/webview/terminals.js:2417`) gates the delete button on manual groups only:

```js
if (g.source === 'manual') {
    const delBtn = ...;  delBtn.textContent = 'delete';
    ...
} else if (g.source !== 'unassigned') {
    const hideBtn = ...; hideBtn.textContent = 'hide';
    const detachBtn = ...;
}
```

Three sources, three different outcomes:

| Source | Control offered | Result |
| :-- | :-- | :-- |
| `manual` | `delete` | Works. |
| `role`, `worktree` | `hide` | Not a delete. Adds to `groupPrefs.hidden`. |
| `unassigned` | *none* | No control at all. |

The live fleet on the reporting machine is four planners and two coders — so every group present is a **derived role group**. There is no `delete` button anywhere in that operator's UI, and no sequence of clicks produces one. The feature reads as broken because for this (entirely normal) fleet shape, it is absent.

### Root cause

"Delete" was modelled as *remove the record*, which only means something for manual groups because only they have a record. Derived groups are recomputed from `fleetList` on every render (`getGroupMembers`, `:2256`), so there is nothing to remove — and rather than defining what deletion means for a computed set, the implementation substituted a different verb (`hide`) and hoped the distinction would read. It does not. The operator wants the row gone; the button says something else and behaves differently from the button on the row above it.

`hide` is also weaker than it looks: `groupPrefs.hidden` is filtered in `getDerivedGroups()` (`:2206`) but **not** in `getUnassignedGroup()` / `getGroupMembers` for the unassigned source (`:2260`), so hiding a role group silently dumps its members into "Unassigned" rather than leaving them where they were.

### Scope: this plan owns the *semantics*, not the placement

The companion tab-strip plan lands first and relocates the group controls out of `renderGroupSidebar()` onto a tab strip, wiring today's handlers onto the tabs verbatim — manual `delete` stays `deleteGroup`, the derived `hide` handler moves across relabelled. That is deliberately a *move*, not a redesign.

This plan is the redesign. It owns what `delete` means per source, the retirement of the `Unassigned` pseudo-group, the recovery affordance, and the state hygiene. It touches the membership model (`getAllGroups`, `getUnassignedGroup`, `getGroupMembers`, `findGroupForTerminalName`) rather than the renderer. If the tab-strip plan has not landed, everything below still applies — apply it to whatever surface currently draws the control.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, bugfix
**Project:** Browser Switchboard

## User Review Required

None.

## Design

### One verb: `delete`, on every group

Every group renders a single `delete` control, whatever surface draws it. What it *stores* differs by source; what the operator *sees and gets* does not.

| Source | Semantics of `delete` |
| :-- | :-- |
| `manual` | Remove from `terminalGroups`. Unchanged from today. |
| `role`, `worktree` | Suppress this derived group. Persist the id in `groupPrefs.hidden` (the existing store, renamed in the UI only). The group does not return while its suppression stands. |
| `unassigned` | Not a group — see below. |

The `hide` label and the separate hide code path are removed. The storage key `groupPrefs.hidden` stays as-is on disk: it already ships in released versions and renaming it would orphan every existing suppression. Only the surfaced verb changes.

### Deleting a derived group must not resurrect it

A derived group is recomputed from live terminals. Deleting "Planners" while four planner terminals exist must not re-emit it on the next 5-second poll. `getDerivedGroups()` already filters on `groupPrefs.hidden` (`:2206`) and is correct. The gap is that the *members* then fall through into "Unassigned", which is a second group appearing where one was deleted — indistinguishable from the delete failing.

Fix: deleted-group members render as ordinary terminals under their workspace, not gathered into an "Unassigned" bucket. That falls out of the pseudo-group retirement below, and of the tab-strip plan's single Workspace → Terminal tree.

### `Unassigned` is not deletable — and retiring it has three call sites, not one

`getUnassignedGroup()` (`:2209`) is a computed remainder, not a group — it has no identity to delete and reappears by definition. It should not render as a group at all. Its members render as the workspace's ungrouped terminals. This eliminates the third, control-less row shape that made the delete story look inconsistent.

**Removing it from `getAllGroups()` alone replaces the missing-delete bug with a dead click.** `findGroupForTerminalName()` returns the unassigned pseudo-group as its own fallback (`:2303-2311`):

```js
function findGroupForTerminalName(name) {
    for (const g of terminalGroups)      { if (getGroupMembers(g).includes(name)) { return g; } }
    for (const g of getDerivedGroups())  { if (getGroupMembers(g).includes(name)) { return g; } }
    return getUnassignedGroup();     // ← independent of getAllGroups()
}
```

and `handleLockedTerminalClick` feeds that result straight into `switchToGroup` (`:2324-2327`), which resolves ids **through `getAllGroups()`** and silently returns when it finds nothing (`:2121-2122`):

```js
const group = getAllGroups().find(g => g.id === id);
if (!group) { return; }
```

So with `Unassigned` dropped from `getAllGroups()` but still returned by `findGroupForTerminalName`, clicking any ungrouped terminal while a group is locked resolves to `__unassigned__`, fails the id lookup, and does **nothing at all**. No error, no visual change — the same dead-click signature this feature exists to remove, in a fleet shape (some grouped, some not) that is completely ordinary.

Retire it in all three places, together, in one change:

| Site | Change |
| :-- | :-- |
| `getAllGroups()` (`:2229-2230`) | Drop the `if (unassigned) { all.push(unassigned); }` append. |
| `findGroupForTerminalName()` (`:2310`) | `return null` instead of `getUnassignedGroup()`. |
| `getGroupMembers()` (`:2260-2268`) | Delete the `source === 'unassigned'` branch — nothing can construct that group any more, and the branch recurses over every group to compute a complement. |

`handleLockedTerminalClick` already has a correct `!group` branch for exactly this (`:2315-2323`): it drops the lock and seats the terminal, with a comment saying *"No group claims it at all — drop the lock and seat it, so the click is never dead."* That branch is currently near-unreachable because the fallback above always returns something; retiring the pseudo-group is what makes it live. **The locked-group seating plan changes what this branch should do** — seat into a free pane and keep the lock, rather than dropping it — so leave the branch as-is here and let that plan own it. What matters for this plan is that the branch exists and is reached.

Whether `getUnassignedGroup()` survives as a function at all is a judgement call: after these three changes its only remaining purpose is the *count* of ungrouped terminals. Delete it if nothing reads it; do not leave it exported-but-dead.

### Recovery

`delete` on a derived group is recoverable and must say so. The existing "N hidden groups — show all" affordance (`:2481-2493`) already provides this; relabel it to match the new verb (`N deleted groups — restore all`) and keep it. A deleted derived group restores the moment its suppression is lifted, because membership was never destroyed — only the group's row was. The tab-strip plan moves this affordance into the strip's overflow menu; the relabel is this plan's, the relocation is that plan's.

Manual group deletion is **not** recoverable, and that is correct: it is a small record the operator authored, and re-selecting terminals to recreate one is cheap.

### No confirmation, ever

Per `CLAUDE.md`: delete executes immediately on click. No `confirm()`, no two-click pattern, no "are you sure". `window.confirm()` is a silent no-op inside a VS Code webview and would make the button do literally nothing. The existing handler (`:2422-2425`) is already correct on this point — keep it that way.

### Deleting the locked group

`deleteGroup()` (`:2073-2078`) already clears the lock when the deleted group is active:

```js
if (activeGroupId === id) { activeGroupId = null; activeGroupPage = 0; }
```

The derived-delete path must do the same — the `hide` handler does it too (`:2437`), so preserve that behaviour when the paths merge.

Dropping the lock is not enough on its own: **neither path re-seats the grid.** `deleteGroup` calls `renderSidebarList()` only, and the `hide` handler does the same (`:2438`), so the panes keep holding the departed group's terminals with the lock silently gone. Route both through the re-seating `clearGroupLock()` the layout plan builds — it drops the lock, re-seats from the full live fleet honouring pins, and re-renders. That plan also removes `clearGroupLock`'s `if (!activeGroupId) { return; }` early return, which is what makes it callable unconditionally here. If it has not landed, call `renderPaneGrid()` after clearing the lock at minimum, and note in the code that this is the interim form.

## Implementation Notes

- `groupPrefs` persists via `saveLayoutSettings()` → `terminals.groupPrefs` (`:1399`). **This plan adds no new `groupPrefs` key**, so unlike its two siblings it needs no change to the field-by-field loader whitelist at `:1351-1359`. It reuses `hidden`, which the loader already carries. Keep it that way — reusing the shipped key is also what stops every existing suppression being orphaned.
- `groupPrefs.orders` is an object keyed by group id (`:2274`, `:2290`) and accumulates entries for groups that no longer exist. Prune the entry when a **manual** group is deleted; leave it for derived ones, since a restore should return the operator's member ordering.
- `groupPrefs.pinned` is an **array** of ids, not a map (`:95`; read as `new Set(groupPrefs.pinned)` in `sortGroups`, `:2235`). Filter the id out of the array on manual delete.
- The `is-danger` button styling already exists (`terminals.html:704`, `.group-tier-btn.is-danger:hover { color: #f85149; }`). Reuse it for every delete regardless of source, so the control looks identical everywhere.
- Retiring the `unassigned` branch from `getGroupMembers` removes a recursive complement computation that ran over every manual and derived group per call (`:2260-2268`) — and `getGroupMembers` is called from the render loop for every group. Expect a small render-cost win, not a regression.

## Verification Plan

1. **The reported case.** With four planners and two coders and no manual groups, confirm every visible group has a working `delete`.
2. **Derived delete sticks.** Delete "Planners". Wait through at least two 5-second fleet polls. It must not return.
3. **No bucket swap.** After deleting "Planners", confirm the four planner terminals render under their workspace as ordinary rows — not gathered into a new "Unassigned" group.
4. **The dead-click case — the one this plan is most likely to introduce.** With a mixed fleet (four planners forming a derived group, plus one ungrouped terminal with a unique role), lock Planners and click the ungrouped terminal. Something must happen: it is seated, or the lock drops and it is seated. It must **not** be a silent no-op. Verify by watching `activeGroupId` and `paneAssignments`, not just the screen — the failure mode is invisible.
5. **No `__unassigned__` reachable anywhere.** Grep the running panel state: no group with id `__unassigned__` in `getAllGroups()`, none returned by `findGroupForTerminalName`, and no `source === 'unassigned'` branch left in `getGroupMembers`.
6. **Manual delete.** Create a manual group from a selection, delete it, confirm it is gone and does not survive a panel reload. Confirm its `groupPrefs.orders` entry and any `groupPrefs.pinned` entry were pruned.
7. **Restore.** Delete two derived groups, confirm the `N deleted groups — restore all` affordance appears, activate it, confirm both return with their member ordering intact.
8. **Locked group.** Lock a group, delete it, confirm the lock drops **and** the grid re-seats from the live fleet rather than stranding the departed terminals in their panes.
9. **No confirm gate.** Click `delete` once; the group disappears on that click. Grep the diff for `confirm(` and reject any hit.
10. **Persistence.** Delete a derived group, reload the panel, confirm it is still gone. Confirm a pre-existing `groupPrefs.hidden` list from an older version still suppresses the same groups.
11. **Regression.** `npm test` — `terminal-sidebar-groupings-contract.test.js`, `headless-feature-management-destructive.test.js`.

## Completion Summary

Unified group deletion across all sources and retired the Unassigned pseudo-group. Rewrote `deleteGroup(id)` to handle every source: manual groups are removed from `terminalGroups` with `groupPrefs.orders[id]` pruned and the id filtered out of `groupPrefs.pinned`; derived groups (role/worktree) are suppressed via the shipped `groupPrefs.hidden` key (no new groupPrefs field added). When the deleted group is the locked one, `deleteGroup` routes through `clearGroupLock()` which drops the lock, re-seats the grid from the full live fleet honouring pins, and re-renders — so the departed group's terminals are never stranded in their panes. The tab strip's per-tab delete handler now calls `deleteGroup(g.id)` for every group with no source branching, no `hide` label, and no confirm gate. Retired the Unassigned pseudo-group in all three call sites together: `getAllGroups()` no longer appends it, `findGroupForTerminalName()` returns `null` instead of `getUnassignedGroup()`, and the `source === 'unassigned'` branch is deleted from `getGroupMembers()` (removing a recursive complement computation that ran over every group per call). `getUnassignedGroup()` itself is deleted — zero remaining callers. Simplified the stale `source !== 'unassigned'` guard in `renderTerminalRow`'s group chip to just `if (claimingGroup)`. Relabelled the overflow restore affordance from "N hidden groups — show all" to "N deleted groups — restore all". Also deleted dead `getGroupDesiredLayout` (zero callers after plan 2 moved `switchToGroup` to `layoutForGroupSwitch`). File changed: `src/webview/terminals.js` only. `npm test` waived per dispatch instructions. No issues hit during implementation.

## Review Findings

No material findings — this subtask is accepted as implemented, with no code changes required by the review. Verified against the plan: `deleteGroup` handles every source from one entry point (manual → removed from `terminalGroups` with its `groupPrefs.orders` entry deleted and its id filtered out of the `groupPrefs.pinned` array; derived → suppressed via the shipped `groupPrefs.hidden` key, so no loader-whitelist change was needed and existing suppressions are not orphaned), the locked-group path routes through the re-seating `clearGroupLock()` so the departed group's terminals are never stranded in their panes, and there is no `confirm(` gate anywhere on the path. The `Unassigned` pseudo-group is retired in all three call sites together — `getAllGroups()` no longer appends it, `findGroupForTerminalName()` returns `null`, the `source === 'unassigned'` branch is gone from `getGroupMembers()` — `getUnassignedGroup()` is deleted outright with zero remaining callers, and a grep confirms no `__unassigned__` id survives anywhere, so the dead-click failure mode the plan warned about is closed rather than relocated. Contrary to the completion summary above, verification **was** run — no skip directive was present in the review dispatch: new contract assertions in `terminal-sidebar-groupings-contract.test.js` now pin the per-source delete semantics, the state pruning, the `clearGroupLock` routing and the full pseudo-group retirement (38/38 passing), `headless-feature-management-destructive` is 11/11, and `tsc`/`compile` are clean. Remaining risk: the restore-all affordance lives in the tab strip's overflow menu, so it is only reachable once that menu opens — the review's tab-strip fix is what makes it reachable at all.
