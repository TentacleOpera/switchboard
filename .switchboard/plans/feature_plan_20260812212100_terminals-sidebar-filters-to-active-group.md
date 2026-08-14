# Terminals sidebar ignores the active group tab — filter the agent tree to the locked group

## Goal

When an operator picks a group in the top-bar group tab strip of the Terminals panel, the sidebar must show only that group's terminals. Today it keeps listing the entire fleet, so the top bar and the sidebar disagree about what "I am working in this group" means.

### Problem analysis

`#group-tab-strip` (`src/webview/terminals.html:1998`) is the panel's top-bar group selector — the operator calls these "teams". Clicking a tab calls `switchToGroup(id)` (`src/webview/terminals.js:2398`), which sets `activeGroupId`, resolves a layout, seats the group's members into the pane grid via `seatActiveGroupPage()`, and then calls `renderSidebarList()`.

`renderSidebarList()` (`src/webview/terminals.js:3032`) is where the disagreement lives. It buckets **the whole of `fleetList`** into workspace → worktree tiers (`src/webview/terminals.js:3150`):

```js
for (const item of fleetList) {
    let targetGroup = parentGroups.find(p => p.fullPath && p.fullPath === item.parentRoot);
    ...
}
```

There is no read of `activeGroupId` anywhere in that bucketing pass. The only acknowledgement of group membership in the sidebar is a per-row chip (`renderTerminalRow`, `src/webview/terminals.js:2083-2088`) that names whichever group claims the row.

### Root cause

The group lock was implemented as a **pane-grid concept only**. `switchToGroup` rewrites `paneAssignments` and the layout, but the sidebar render path was never given the filter. The sidebar therefore stays a global fleet tree under a lock, and the operator has to read a small violet chip on every row to work out which of the listed terminals are even in the group they just selected. The `.item-group-chip` was added as a substitute for the filtering that was never built — it makes membership *legible* per row instead of making the list *correct*.

### Decisions

- **The filter is strict.** Under a lock the sidebar lists exactly `getGroupMembers(activeGroup)`. The escape hatch already exists and is one click away: the leading **All** tab in the same strip drops the lock and restores the full tree.
- **Exited terminals disappear under a lock.** `getGroupMembers()` filters against a `live` set built from `status !== 'exited'` (`src/webview/terminals.js:2536`), so a lock hides dead rows and their `clear` buttons. That is acceptable: `clear` is a housekeeping action and the All tab restores every dead row. Do not build a second membership resolver just to keep exited rows visible.
- **Workspace and worktree headers always render, even when the filter empties them.** Every header carries the `+` that spawns *into that workspace/worktree*; hiding empty headers would make spawning impossible under a lock. This is the same reasoning that removed the zero-fleet early return (see the comment at `src/webview/terminals.js:3036-3046`).
- **The group chip is suppressed under a lock.** When every visible row belongs to the locked group the chip carries zero information and just eats the 220px sidebar's horizontal budget.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## Feature context — this is subtask 2 of 5

Feature: **Terminals Panel Sidebar & Group Selection UX**. Lands **after** the badge-removal plan (which shrinks the header block this plan renders around) and **before** the workspace-dropdown plan (which adds a second, orthogonal filter to the same function).

**Reconciled contracts with the siblings:**

1. **Two filters on one render, composed as an intersection.** This plan filters *rows* by group membership; the workspace-dropdown plan filters *buckets* by `parentRoot`. Both can be active. The reconciled ordering inside `renderSidebarList()` is: **group filter first (on `fleetList`, before bucketing) → bucket → workspace filter (on the bucket list)**. Never the reverse — bucketing a workspace-filtered fleet would make the group filter's own empty-notice branch unreachable.
2. **`hasUnmapped` must be computed from the UNFILTERED fleet.** The dropdown plan derives its `Unmapped` option from whether the unmapped bucket is non-empty. Because this plan filters `fleetList` *before* bucketing, a group lock whose members are all mapped would empty the unmapped bucket, drop the `Unmapped` option, and — via the dropdown plan's stale-selection fallback — **persist `sidebarWorkspace = ''`**, silently destroying the operator's saved selection on a gesture that has nothing to do with workspaces. The reconciled end-state: the dropdown plan probes the unfiltered fleet for its option list. This plan must therefore expose the unfiltered array under its own name (`fleetList`) and bucket from `sidebarItems`, keeping the two readable apart. Stated here because this plan is the one that introduces the divergence.
3. **This plan owns the group chip line** (`src/webview/terminals.js:2083`). The "ungrouped terminals get their own grid" sibling introduces a `source: 'unassigned'` pseudo-group that `findGroupForTerminalName()` starts returning instead of `null` — which would make **every ungrouped row grow an `Unassigned` chip** in unlocked mode, re-spending exactly the 220px budget the badge-removal plan just freed. The single reconciled end-state for that line is written in Proposed Changes §5 and is repeated verbatim in the sibling plan. Implement it once, in whichever of the two lands second; do not write two different guards.

## Complexity Audit (Routine vs Complex/Risky)

**Routine**

- Computing a `Set` of member names from the already-existing `getGroupMembers()` helper.
- Filtering `fleetList` before the bucketing loop.
- Suffixing the sidebar title with the group name.
- Suppressing the chip behind an `activeGroupId` check.

**Complex / Risky**

- **The empty-notice text is load-bearing.** `totalItems === 0` (`src/webview/terminals.js:3268`) currently renders `(no terminals — + to open)`. Under a lock that sentence is a lie — the workspace may hold ten terminals, none of them in this group. The notice must branch on whether a lock is active.
- **`renderSidebarList()` also renders the group tab strip** (`src/webview/terminals.js:3115-3120`) and the role-picker garbage-collect at the tail (`src/webview/terminals.js:3367`). The filter must be inserted *after* the strip render and must not change either code path — the tab counts come from `getGroupMembers()` against the full fleet (`src/webview/terminals.js:2806`) and must stay global, or the strip stops being a way to *see* what else exists.
- **`renderSidebarList()` runs on every fleet poll.** The member `Set` must be computed once per render, not per row: `findGroupForTerminalName()` walks every group and calls `getGroupMembers()` per group, so a per-row resolution would be O(rows × groups × fleet) on a 5s timer.
- **The `+` still spawns into a workspace whose rows are all filtered out.** `onNewTerminalClicked(...)` is bound per header with `parentGroup.fullPath`, not from the rendered rows (`src/webview/terminals.js:3236-3239`), so the spawn target is unaffected by the filter. The new terminal will then be invisible under the lock until it is added to the group — expected, and the reason the title stamp in §4 is not optional.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| No lock (`activeGroupId === null`) | Unchanged — full fleet tree, chips shown, notice reads `(no terminals — + to open)`. |
| Locked group with zero live members | Every workspace header renders with the locked empty notice. The strip's `+` and each header's `+` still spawn. |
| Locked group whose members all live in one workspace | Other workspaces render header + locked empty notice, not omitted. |
| Solo mode (`soloTerminalName` set) | The strip is not rendered (`renderGroupTabStrip` early-returns at `src/webview/terminals.js:2771`) and the sidebar is hidden by `body.is-solo` CSS (`src/webview/terminals.html:1903`). Filter is inert; do not add a second guard. |
| Delegate children (`parentInstanceId` set) | **Source-dependent, and not uniformly excluded.** `getGroupMembers()`'s `role`/`worktree` branches inline `!t.parentInstanceId`, but the `manual` branch deliberately does **not** — the parentage clause was removed because a team registers head + children explicitly and filtering it resolved every team to its head alone (see the comment at `src/webview/terminals.js:2526-2534`). So under a **manual** team lock the children are members and **must** appear in the filtered sidebar; under a derived lock they do not. Do not "fix" this by re-adding a parentage filter here. |
| Selection header (`selectedTerminalNames`) | Renders above the filter (`src/webview/terminals.js:3056`) and is untouched. A selection made before a lock can reference hidden rows; `saveSelectionAsGroup` reads names, not DOM (`src/webview/terminals.js:2371`), so it still works. |
| Group deleted while locked | `deleteGroup` routes through `clearGroupLock()` (`src/webview/terminals.js:2296`), which nulls `activeGroupId` and re-renders — filter switches off automatically. |
| Terminal exits while locked | Next poll drops it from `getGroupMembers()`; the row disappears from the sidebar. Expected. |
| `activeGroupId` set to a group id that no longer resolves | `getAllGroups().find()` returns `undefined`; the filter must fall through to *unfiltered* rather than rendering an empty sidebar. |
| Locked group **and** a specific workspace selected (dropdown sibling shipped) | Intersection. The workspace's terminals that are also group members render; if none are, the *group* notice text wins (it is the more specific explanation, and the dropdown itself already names the workspace). |
| Lock taken while the `Unassigned` pseudo-group is active (ungrouped-grid sibling shipped) | `getAllGroups()` resolves `__unassigned__`, `getGroupMembers()` returns the computed complement, and the filter works unchanged. No extra branch. |

**Dependencies:** none outside `src/webview/terminals.html` and `src/webview/terminals.js`. No verb calls, no persisted-settings change, no backend change. Within the feature, lands after the badge-removal plan and before the workspace-dropdown plan.

## Proposed Changes

### `src/webview/terminals.js`

**1. Resolve the active group once, right after the tab strip render (`~3120`).**

```js
        // Render the group tab strip (above the pane grid, outside listEl).
        if (!soloTerminalName) {
            if (renderGroupTabStrip()) { pickerRendered = true; }
        }

        // Group filter. The top-bar strip is the panel's group selector; when a
        // group is locked the sidebar must agree with it. Resolved ONCE per
        // render: findGroupForTerminalName walks every group and calls
        // getGroupMembers per group, so a per-row resolution would be
        // O(rows x groups x fleet) on the 5s fleet poll.
        //
        // AFTER the strip render, never before: the strip's per-tab counts come
        // from getGroupMembers() against the full fleet and must stay global —
        // the strip is how the operator sees what the filter is hiding.
        //
        // An activeGroupId that no longer resolves (group deleted between the
        // save and this render) falls through to UNFILTERED, not to an empty
        // sidebar: a stale id must never blank the operator's only spawn tree.
        const lockedGroup = activeGroupId
            ? getAllGroups().find(g => g.id === activeGroupId)
            : null;
        const lockedMemberNames = lockedGroup
            ? new Set(getGroupMembers(lockedGroup))
            : null;
```

**2. Filter the bucketing input (`~3150`).**

```js
        // fleetList stays the unfiltered fleet and is still read by the pane-grid
        // empty-state toggle above AND by the workspace picker's Unmapped probe
        // (workspace-dropdown sibling). Only the bucketing pass consumes the
        // filtered array — keep the two names distinct.
        const sidebarItems = lockedMemberNames
            ? fleetList.filter(t => lockedMemberNames.has(t.friendlyName))
            : fleetList;

        for (const item of sidebarItems) {
            let targetGroup = parentGroups.find(p => p.fullPath && p.fullPath === item.parentRoot);
            ...
        }
```

Note: the `if (fleetList.length === 0)` empty-state/pane-grid toggle near the top of the function (`src/webview/terminals.js:3047`) stays keyed on `fleetList`, **not** `sidebarItems` — the pane grid's empty state is about the fleet, not about the sidebar filter. Filtering it would blank the pane grid every time a lock's members happened to be zero.

**3. Branch the empty notice (`~3268`).**

```js
            if (totalItems === 0) {
                const emptyNotice = document.createElement('div');
                emptyNotice.className = 'empty-parent-notice';
                // Under a lock the workspace may hold ten terminals, none of them
                // members. "(no terminals)" would be a lie about the workspace.
                emptyNotice.textContent = lockedGroup
                    ? `(no ${lockedGroup.name} terminals here — + to open)`
                    : '(no terminals — + to open)';
                itemsContainer.appendChild(emptyNotice);
            }
```

`totalItems` is accumulated from `parentGroup.direct` + `worktreesMap` (`src/webview/terminals.js:3199`), which are populated from `sidebarItems` after §2 — so it filters for free and needs no edit here. (The badge-removal sibling reduces that accumulation to `totalItems` alone; both changes are compatible and touch different lines.)

**4. Name the filter in the sidebar header.** The header is static markup today (`src/webview/terminals.html:1932-1934`); stamp it from the render so the filter is never silent.

```js
        // Sidebar title carries the lock, so a filtered tree is never mistaken
        // for an empty fleet — the one thing a silent filter always causes.
        if (sidebarTitleEl) {
            sidebarTitleEl.textContent = lockedGroup ? `Agents — ${lockedGroup.name}` : 'Agents';
            sidebarTitleEl.title = lockedGroup
                ? `Showing only ${lockedGroup.name}. Click All in the group bar to show every terminal.`
                : '';
        }
```

with the element cached beside the other DOM handles (`~189`):

```js
    const sidebarTitleEl = document.querySelector('.sidebar-title');
```

**5. Suppress the redundant chip under a lock** (`renderTerminalRow`, `~2083`).

This is the **reconciled end-state for this line across two subtasks** — the ungrouped-grid sibling makes `findGroupForTerminalName()` return an `Unassigned` pseudo-group instead of `null`, which would otherwise chip every ungrouped row. Write this once:

```js
        // Two suppressions, one line:
        //  - Under a group lock every visible row is a member, so the chip
        //    carries no information — and the sidebar is 220px wide.
        //  - The Unassigned pseudo-group is the computed remainder, not a
        //    membership. Chipping it would label most of the fleet with a word
        //    that means "no group", spending the width the count badge just
        //    gave back.
        const resolvedGroup = activeGroupId ? null : findGroupForTerminalName(item.friendlyName);
        const claimingGroup = (resolvedGroup && resolvedGroup.source !== 'unassigned')
            ? resolvedGroup
            : null;
        if (claimingGroup) {
            ...unchanged chip construction...
        }
```

The `source !== 'unassigned'` clause is inert until the sibling lands and harmless before it, so this line is order-independent.

### `src/webview/terminals.html`

Give the title room for the group suffix (`.sidebar-title`, `~117`) — the header is a `flex` row with `justify-content: space-between` (`~110`) and a long group name must ellipsise rather than push:

```css
        .sidebar-title {
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            color: var(--text-secondary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
```

## Verification Plan

> Testing is done against an **installed VSIX**, not the repo's `dist/`. No compilation or automated-test step is part of this plan.

1. **Install + open:** install the current VSIX and open the Terminals panel in a browser window.
2. **Baseline:** with the **All** tab active, confirm the sidebar lists every workspace and every terminal exactly as before, chips included, and the header reads `Agents`.
3. **Filter on:** spawn 5+ terminals across at least two roles so a derived group materialises. Click a group tab. Confirm:
   - the sidebar lists only that group's terminals;
   - the header reads `Agents — <group name>`;
   - the group chip is gone from the visible rows;
   - workspaces holding no member render their header, `+`, and the locked empty notice naming the group.
4. **Strip counts stay global:** while locked, confirm every *other* tab in the strip still shows its own non-zero member count — the filter must not have leaked into the strip.
5. **Escape:** click **All**. The full tree, the chips, and the plain `Agents` title all return.
6. **Spawn under a lock:** with a group locked, click the `+` on a workspace header whose rows are all filtered out. Confirm the role picker mounts under that header and the spawn lands in the right workspace (verify by clicking **All** and reading the new row's position in the tree).
7. **Stale id:** lock a group, then delete it from its tab's `×`. Confirm `clearGroupLock()` fires and the sidebar returns to the unfiltered tree — not an empty list.
8. **Poll stability:** leave a lock active for 30s (≥6 fleet polls). Confirm no flicker between filtered and unfiltered renders, and that an open role picker survives the polls.
9. **Manual team with children:** create a manual group from a head terminal that has delegate children. Lock it. Confirm the children **are** listed (the manual branch of `getGroupMembers` includes them by design) — a filtered sidebar that hides a team's own children would be the regression this row of the audit exists to prevent.
10. **Solo mode:** enter solo on one terminal. Confirm the sidebar and strip are hidden and no console error fires from the title stamp.
11. **Regression:** select two terminals via the selection affordance, save them as a manual group, and confirm the new tab appears and locks correctly with the sidebar filtered to those two.
12. **Pane grid untouched:** lock a group whose live member count is zero (exit every member). Confirm the pane grid still shows panes/empty-state driven by the whole fleet, not blanked by the sidebar filter.
