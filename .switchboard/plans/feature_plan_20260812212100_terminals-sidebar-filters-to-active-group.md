# Terminals sidebar ignores the active group tab — filter the agent tree to the locked group

## Goal

When an operator picks a group in the top-bar group tab strip of the Terminals panel, the sidebar must show only that group's terminals. Today it keeps listing the entire fleet, so the top bar and the sidebar disagree about what "I am working in this group" means.

### Problem analysis

`#group-tab-strip` (`src/webview/terminals.html:1896`) is the panel's top-bar group selector — the operator calls these "teams". Clicking a tab calls `switchToGroup(id)` (`src/webview/terminals.js:2338`), which sets `activeGroupId`, resolves a layout, seats the group's members into the pane grid via `seatActiveGroupPage()`, and then calls `renderSidebarList()`.

`renderSidebarList()` (`src/webview/terminals.js:2951`) is where the disagreement lives. It buckets **the whole of `fleetList`** into workspace → worktree tiers:

```js
for (const item of fleetList) {
    let targetGroup = parentGroups.find(p => p.fullPath && p.fullPath === item.parentRoot);
    ...
}
```

There is no read of `activeGroupId` anywhere in that bucketing pass. The only acknowledgement of group membership in the sidebar is a per-row chip (`renderTerminalRow`, `src/webview/terminals.js:2010-2013`) that names whichever group claims the row.

### Root cause

The group lock was implemented as a **pane-grid concept only**. `switchToGroup` rewrites `paneAssignments` and the layout, but the sidebar render path was never given the filter. The sidebar therefore stays a global fleet tree under a lock, and the operator has to read a small violet chip on every row to work out which of the listed terminals are even in the group they just selected. The `.item-group-chip` was added as a substitute for the filtering that was never built — it makes membership *legible* per row instead of making the list *correct*.

### Decisions

- **The filter is strict.** Under a lock the sidebar lists exactly `getGroupMembers(activeGroup)`. The escape hatch already exists and is one click away: the leading **All** tab in the same strip drops the lock and restores the full tree.
- **Exited terminals disappear under a lock.** `getGroupMembers()` filters on `status !== 'exited'`, so a lock hides dead rows and their `clear` buttons. That is acceptable: `clear` is a housekeeping action and the All tab restores every dead row. Do not build a second membership resolver just to keep exited rows visible.
- **Workspace and worktree headers always render, even when the filter empties them.** Every header carries the `+` that spawns *into that workspace/worktree*; hiding empty headers would make spawning impossible under a lock. This is the same reasoning that removed the zero-fleet early return (see the comment at `src/webview/terminals.js:2955-2969`).
- **The group chip is suppressed under a lock.** When every visible row belongs to the locked group the chip carries zero information and just eats the 220px sidebar's horizontal budget.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine**

- Computing a `Set` of member names from the already-existing `getGroupMembers()` helper.
- Filtering `fleetList` before the bucketing loop.
- Suffixing the sidebar title with the group name.
- Suppressing the chip behind an `activeGroupId` check.

**Complex / Risky**

- **The empty-notice text is load-bearing.** `totalItems === 0` currently renders `(no terminals — + to open)`. Under a lock that sentence is a lie — the workspace may hold ten terminals, none of them in this group. The notice must branch on whether a lock is active.
- **`renderSidebarList()` also renders the group tab strip** (`src/webview/terminals.js:3035-3037`) and the role picker garbage-collect at the tail. The filter must be inserted *after* the strip render and must not change either code path — the tab counts come from `getGroupMembers()` against the full fleet and must stay global.
- **`renderSidebarList()` runs on every fleet poll.** The member `Set` must be computed once per render, not per row: `findGroupForTerminalName()` walks every group and calls `getGroupMembers()` per group, so a per-row resolution would be O(rows × groups × fleet) on a 5s timer.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| No lock (`activeGroupId === null`) | Unchanged — full fleet tree, chips shown, notice reads `(no terminals — + to open)`. |
| Locked group with zero live members | Every workspace header renders with the locked empty notice. The strip's `+` and each header's `+` still spawn. |
| Locked group whose members all live in one workspace | Other workspaces render header + locked empty notice, not omitted. |
| Solo mode (`soloTerminalName` set) | The strip is not rendered (`renderGroupTabStrip` early-returns) and the sidebar is hidden by `body.is-solo` CSS. Filter is inert; do not add a second guard. |
| Delegate children (`parentInstanceId` set) | Already excluded from `getGroupMembers()`. Under a lock they vanish from the sidebar with everything else non-member — acceptable, they are not independently seatable. |
| Selection header (`selectedTerminalNames`) | Renders above the filter and is untouched. A selection made before a lock can reference hidden rows; `saveSelectionAsGroup` reads names, not DOM, so it still works. |
| Group deleted while locked | `deleteGroup` routes through `clearGroupLock()`, which nulls `activeGroupId` and re-renders — filter switches off automatically. |
| Terminal exits while locked | Next poll drops it from `getGroupMembers()`; the row disappears from the sidebar. Expected. |
| `activeGroupId` set to a group id that no longer resolves | `getAllGroups().find()` returns `undefined`; the filter must fall through to *unfiltered* rather than rendering an empty sidebar. |

**Dependencies:** none outside `src/webview/terminals.html` and `src/webview/terminals.js`. No verb calls, no persisted-settings change, no backend change.

## Proposed Changes

### `src/webview/terminals.js`

**1. Resolve the active group once, right after the tab strip render (~line 3037).**

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

**2. Filter the bucketing input (~line 3062).**

```js
        const sidebarItems = lockedMemberNames
            ? fleetList.filter(t => lockedMemberNames.has(t.friendlyName))
            : fleetList;

        for (const item of sidebarItems) {
            let targetGroup = parentGroups.find(p => p.fullPath && p.fullPath === item.parentRoot);
            ...
        }
```

Note: the `if (fleetList.length === 0)` empty-state/pane-grid toggle near the top of the function stays keyed on `fleetList`, **not** `sidebarItems` — the pane grid's empty state is about the fleet, not about the sidebar filter.

**3. Branch the empty notice (~line 3181).**

```js
            if (totalItems === 0) {
                const emptyNotice = document.createElement('div');
                emptyNotice.className = 'empty-parent-notice';
                emptyNotice.textContent = lockedGroup
                    ? `(no ${lockedGroup.name} terminals here — + to open)`
                    : '(no terminals — + to open)';
                itemsContainer.appendChild(emptyNotice);
            }
```

**4. Name the filter in the sidebar header.** The header is static markup today; stamp it from the render so the filter is never silent.

```js
        // Sidebar title carries the lock, so a filtered tree is never mistaken
        // for an empty fleet.
        if (sidebarTitleEl) {
            sidebarTitleEl.textContent = lockedGroup ? `Agents — ${lockedGroup.name}` : 'Agents';
            sidebarTitleEl.title = lockedGroup
                ? `Showing only ${lockedGroup.name}. Click All in the group bar to show every terminal.`
                : '';
        }
```

with the element cached beside the other DOM handles (~line 189):

```js
    const sidebarTitleEl = document.querySelector('.sidebar-title');
```

**5. Suppress the redundant chip under a lock** (`renderTerminalRow`, ~line 2010):

```js
        // Under a group lock every visible row is a member, so the chip carries
        // no information — and the sidebar is 220px wide.
        const claimingGroup = activeGroupId ? null : findGroupForTerminalName(item.friendlyName);
```

### `src/webview/terminals.html`

Give the title room for the group suffix (`.sidebar-title`, ~line 117) — the header is a `flex` row and a long group name must ellipsise rather than push:

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

1. **Build + install:** `npm run compile`, package and install the VSIX, open the Terminals panel in a browser window.
2. **Baseline:** with the **All** tab active, confirm the sidebar lists every workspace and every terminal exactly as before, chips included, and the header reads `Agents`.
3. **Filter on:** spawn 5+ terminals across at least two roles so a derived group materialises. Click a group tab. Confirm:
   - the sidebar lists only that group's terminals;
   - the header reads `Agents — <group name>`;
   - the group chip is gone from the visible rows;
   - workspaces holding no member render their header, `+`, and the locked empty notice.
4. **Escape:** click **All**. The full tree, the chips, and the plain `Agents` title all return.
5. **Spawn under a lock:** with a group locked, click the `+` on a workspace header whose rows are all filtered out. Confirm the role picker mounts under that header and the spawn lands in the right workspace.
6. **Stale id:** lock a group, then delete it from its tab's `×`. Confirm `clearGroupLock()` fires and the sidebar returns to the unfiltered tree — not an empty list.
7. **Poll stability:** leave a lock active for 30s (≥6 fleet polls). Confirm no flicker between filtered and unfiltered renders, and that an open role picker survives the polls.
8. **Solo mode:** enter solo on one terminal. Confirm the sidebar and strip are hidden and no console error fires from the title stamp.
9. **Regression:** select two terminals via the selection affordance, save them as a manual group, and confirm the new tab appears and locks correctly with the sidebar filtered to those two.
