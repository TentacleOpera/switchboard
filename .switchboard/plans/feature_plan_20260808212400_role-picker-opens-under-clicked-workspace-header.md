# New-Terminal Role Picker Opens at the Top of the Terminals Sidebar Instead of Under the Workspace Header That Was Clicked

## Goal

Make the new-terminal role picker appear directly beneath the workspace (or worktree) header whose `+` was clicked, and remove the `+ New` button that currently sits next to the **Agents** sidebar title — the spawn control belongs with the place it spawns into, not at the top of the list.

### Problem

The Terminals sidebar has three `+` controls and one picker. The per-parent `+` in each workspace header (`src/webview/terminals.js:1587-1595`) and the per-worktree `+` in each worktree header (`:1656-1665`) both carry a target — `{ parentRoot }` or `{ worktreePath }`. But every one of them, plus the global `+ New` in the sidebar header, calls the same `onNewTerminalClicked(targetSpec)`, which unhides a **single static element** declared once at the very top of the sidebar:

```html
<div class="sidebar-header">
    <span class="sidebar-title">Agents</span>
    <button id="btn-new-terminal" class="btn-new-terminal">+ New</button>
</div>
<div id="role-picker" class="role-picker" hidden>
```
— `src/webview/terminals.html:1390-1401`

```js
    async function onNewTerminalClicked(targetSpec) {
        const picker = document.getElementById('role-picker');
```
— `src/webview/terminals.js:3598-3599`

So clicking `+` on a workspace three groups down the list pops a role menu into view at the top of the sidebar, visually attached to the "Agents" header and to nothing else. The menu carries no indication of which workspace it will spawn into — the only thing that knows is the `targetSpec` closed over in the handler. If the list is scrolled, the menu can open entirely off-screen and the click reads as a no-op.

### Root cause

The picker is a **singleton at a fixed DOM position**, while its meaning is **per-group**. The target was threaded through the call but the presentation was not; the picker was built when there was exactly one spawn button (the header one it still sits beside), and the per-group `+` buttons were added later by reusing the existing function without moving the surface it shows.

The global `+ New` compounds it: it is the picker's only visually plausible owner, so the menu reads as belonging to it, which is why a click on a workspace `+` looks like the wrong button fired.

### Why the fix is not "move the element on click"

`renderSidebarList` begins with `listEl.innerHTML = ''` (`src/webview/terminals.js:1451`) and runs on every fleet poll (5 s, `startFleetPoll` at `:3118-3128`), every `terminalsChanged` push, every group collapse toggle, and every badge change. A picker imperatively inserted into a group would be destroyed by the next poll — within five seconds, mid-choice. The picker must therefore be **state-driven**: an open-picker descriptor in module state, re-rendered as part of the group it belongs to.

## Reconcile Before Building

This plan shares `src/webview/terminals.js` and `terminals.html` with two subtasks of the feature *Terminals Pane: Groups, Peek, and Bulk Terminal Creation* (`9e7c314d`). The project PRD allows **one agent stream per file**, so none of these may be coded in parallel.

**`role-grid-fill-terminals.md` — direct conflict, but a favourable one.** It builds on exactly what this plan restructures: it cites `#role-picker` (`terminals.html:1398-1401`) and `onNewTerminalClicked` (`terminals.js:3598`) as existing assets, and instructs *"Reuse that builder rather than writing a second role list"* for its Fill-grid role selector. Today there is no builder to reuse — the role list is inlined in `onNewTerminalClicked`, which is why Role Grid Fill has to describe reuse rather than just call something.

**Land this plan first.** `buildRolePicker(targetSpec)` *is* the extracted builder Role Grid Fill asks for, so landing in this order turns its "reuse the builder" instruction into a real function call and deletes the duplication risk. If Role Grid Fill lands first, it will have copied or re-derived the role list and this plan must reconcile both copies — strictly more work, and a live opportunity for the two role lists to drift.

Two follow-on notes for whoever codes Role Grid Fill afterwards:

- Its Fill-grid action needs a home now that the sidebar header holds only the title. The `.sidebar-ops` block (`terminals.html:1408-1420`, beside `OPEN AGENT TERMINALS`) is the natural place — it is a fleet-wide action, not a per-workspace one, so it does **not** belong in the per-group inline picker.
- Its role list must come from `buildRolePicker`'s filtering and sorting, not from a second copy of the `SYSTEM_ROLES` / `roleOrderMap` / `BUILT_IN_AGENT_LABELS` logic.

**`terminals-sidebar-groups-and-grids-ia.md` — same file, overlapping surface.** It recasts the sidebar into a hierarchy and rewrites `src/test/terminal-sidebar-groupings-contract.test.js` (the feature notes it "removes every symbol it asserts"). This plan renders the inline picker into the parent/worktree group containers and adds a spawn row to `renderGroupSidebar` — both of which that plan reshapes. Sequence them; do not merge the two sets of edits by hand. If Groups lands first, re-derive the insertion points from whatever container structure it leaves rather than the `parentDiv` / `wtDiv` names used below.

**`terminal-peek-temporary-fullscreen.md`** shares the sidebar *row* action cluster (it takes the leftmost slot, before `clear`). This plan does not touch row actions — only group headers and the picker — so there is no direct conflict, but it is a third writer to the same file.

Line references below were verified against the working tree on 2026-08-08, which carries uncommitted changes to `terminals.js` and `terminals.html`. Re-grep the symbols rather than trusting a line number.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

**Routine (majority):**
- Moving DOM construction out of `onNewTerminalClicked` into a `buildRolePicker(targetSpec)` helper — the same nodes, same classes, same listeners, built in a different place.
- Deleting the header button and its `init()` wiring.
- Copy edit to the empty-state string.

**Complex / risky (three items):**
1. **Re-render survival.** The picker now lives inside a container that is wiped every few seconds. Getting this wrong produces a menu that vanishes while the user reads it — worse than the bug being fixed. Resolved by making `pickerState` module state and rendering from it, never by inserting on click.
2. **Async roles in a synchronous renderer.** `onNewTerminalClicked` currently `await`s `fetchPtyVisibleRoles()` before showing anything; `renderSidebarList` is synchronous. The fetch result must be cached so a re-render can rebuild the picker without a second round trip and without a flash of an empty menu.
3. **Removing the global `+ New` removes the only spawn control in groups view.** `renderSidebarList` early-returns into `renderGroupSidebar` when saved groups exist (`:1474-1477`), and `renderGroupSidebar` (`:1350-1406`) renders only group rows — no `+` anywhere. Deleting the header button without replacing it there would strand a groups-view user with no way to open a terminal. Handled explicitly below.

## Edge-Case & Dependency Audit

- **Collapsed group.** `.parent-group.collapsed .parent-group-items` and `.worktree-group.collapsed .worktree-items` set `display: none` (`terminals.html:588-590`, `:519-521`). The picker is inserted as a **sibling** of the items container, between the header and the items — so it stays visible when the group is collapsed. Clicking `+` on a collapsed group must not also toggle the collapse: the existing `e.stopPropagation()` in both `+` handlers already prevents that and must be kept.
- **Target group disappears while the picker is open** (workspace mapping removed, worktree pruned). Track whether the picker was rendered this pass; if `pickerState` is set and nothing matched, clear it — otherwise the next `+` click on any group toggles a picker the user cannot see.
- **Two `+` clicks in a row.** Existing behaviour is toggle-closed (`if (!picker.hidden) { picker.hidden = true; return; }`). Preserve it, keyed per group: clicking the same group's `+` closes; clicking a *different* group's `+` moves the picker there rather than closing it.
- **Groups view.** `renderGroupSidebar` gets a `+ New terminal` row appended below the group rows, opening the picker inline with `targetSpec === undefined` — exactly what today's header button does, just relocated into the list. Capability preserved, top-of-sidebar oddity gone.
- **Solo mode.** `body.is-solo .terminals-sidebar { display: none }` (`terminals.html:1363`) — the whole sidebar is hidden, so no path here runs. `renderSidebarList` also skips group mode when `soloTerminalName` is set.
- **Empty fleet.** `renderSidebarList` deliberately does **not** early-return on an empty fleet (`:1465-1472` and the comment above it) precisely so the per-workspace `+` stays reachable with zero terminals. That invariant is now load-bearing — with the header button gone it is the *only* spawn path. Do not reintroduce an early return.
- **Empty-state copy.** `#empty-state` reads `No terminal selected. Click "+ New" to spawn a terminal.` (`terminals.html:1451-1453`) and the CSS comment at `:1374` says "solo mode never offers + New". Both reference a button that will not exist. Update the copy; leave the CSS rule (it is still correct behaviour, just re-worded).
- **`(no terminals — + to open)` notice** (`terminals.js:1618-1621`) already points at the per-group `+`. Still accurate — it becomes the primary instruction rather than a secondary one.
- **Nothing else may keep a handle on `#role-picker`.** After this change the element does not exist until a group renders one, so any `document.getElementById('role-picker')` anywhere in the tree is a latent null deref. Grep before finishing — and note that `role-grid-fill-terminals.md` currently names that element as an asset it builds on (see *Reconcile Before Building*).
- **Contract tests over this source.** `src/test/multi-parent-terminals-contract.test.js:251` pins `onNewTerminalClicked(parentGroup.fullPath ? { parentRoot: parentGroup.fullPath }` as a **prefix** regex, so appending a second argument keeps it green — do not reorder the arguments. `src/test/terminal-sidebar-groupings-contract.test.js` reads `renderSidebarList` and `renderGroupSidebar` blocks by marker; check its `block()` markers still resolve after the edits. `src/test/terminal-sidebar-role-ordering-contract.test.js` reads the role sort inside `onNewTerminalClicked` — that sort moves into `buildRolePicker`, so its marker must be updated in lockstep.
- **Persisted state.** None touched. `pickerState` is transient module state; nothing reaches `saveLayoutSettings`, a settings key, or the DB — no migration per CLAUDE.md.
- **No confirm gates.** The picker's Cancel button stays a plain dismiss; nothing here adds a confirmation step.

## Proposed Changes

### 1. `src/webview/terminals.html` — delete the header button and the static picker

```html
    <div class="terminals-sidebar">
        <div class="sidebar-header">
            <span class="sidebar-title">Agents</span>
        </div>
        <!-- The role picker is NOT declared here any more. It is built per group by
             buildRolePicker() and rendered directly under the workspace or worktree
             header whose `+` was clicked, so the menu is visually attached to the
             place it will spawn into. A single static picker at the top of the
             sidebar was shown for every `+` in the list, including groups scrolled
             out of view. The .role-picker* CSS below is unchanged and still styles it. -->
        <div class="sidebar-ops">
```

Keep every `.role-picker`, `.role-picker-title`, `.role-picker-options`, `.role-option`, `.role-option.is-no-role` and `.role-picker-cancel` rule (`:185-244`) — the markup is identical, only its position changes. Add one rule so an inline picker reads as nested under its header rather than as a peer of the group:

```css
        /* Inline picker: nested under the group header that opened it. The static
           top-of-sidebar picker had a bottom border acting as a section divider;
           inside a group that divider is wrong, so it becomes a left rail instead. */
        .role-picker.is-inline {
            border-bottom: none;
            border-left: 2px solid var(--accent-teal, #4ec9b0);
            margin: 2px 0 4px 6px;
            border-radius: 0 3px 3px 0;
        }
```

Update the empty-state copy (`:1451-1453`):

```html
        <div id="empty-state" class="empty-state">
            No terminal selected. Use the + beside a workspace in the sidebar to spawn one.
        </div>
```

### 2. `src/webview/terminals.js` — state-driven inline picker

Module state, next to the other sidebar flags near `groupsView` (`:69-71`):

```js
    /**
     * Which group header the role picker is currently open under.
     *   { key: string, targetSpec: object|undefined }   — open
     *   null                                            — closed
     *
     * State, not DOM: renderSidebarList() does `listEl.innerHTML = ''` on every
     * fleet poll (5s), every terminalsChanged push and every collapse toggle, so a
     * picker inserted imperatively on click would be destroyed mid-choice. The
     * renderer rebuilds it from this.
     */
    let pickerState = null;
    /** Cached { visibleAgents, hasCommand } so a re-render rebuilds the picker
     *  without a round trip and without flashing an empty menu. */
    let rolePickerData = null;
```

Replace `onNewTerminalClicked` (`:3598-3652`) with a toggle that only sets state:

```js
    async function onNewTerminalClicked(targetSpec, key) {
        const groupKey = key || '__default__';
        if (pickerState && pickerState.key === groupKey) {
            pickerState = null;
            renderSidebarList();
            return;
        }
        // Fetch BEFORE opening, so the picker never renders empty and then
        // repopulates. Cached for subsequent opens and for every re-render.
        rolePickerData = await fetchPtyVisibleRoles();
        pickerState = { key: groupKey, targetSpec };
        renderSidebarList();
    }
```

Add `buildRolePicker`, holding the role filtering/sorting/labelling verbatim from the old function body (`:3606-3651`) — only the surrounding element changes:

```js
    /**
     * Build the inline role picker for one group. Returns a detached element the
     * renderer inserts between a group header and its items container, so it stays
     * visible when the group is collapsed and is unmistakably attached to the
     * workspace it will spawn into.
     */
    function buildRolePicker(targetSpec) {
        const picker = document.createElement('div');
        picker.className = 'role-picker is-inline';

        const title = document.createElement('div');
        title.className = 'role-picker-title';
        title.textContent = 'New terminal — pick a role';
        picker.appendChild(title);

        const optionsEl = document.createElement('div');
        optionsEl.className = 'role-picker-options';

        const data = rolePickerData || { visibleAgents: {}, hasCommand: {} };
        const visible = data.visibleAgents;
        const hasCommand = data.hasCommand;
        const SYSTEM_ROLES = new Set(['orchestrator', 'mcp_monitor']);
        const roles = Object.keys(visible)
            .filter(k => visible[k] !== false && !SYSTEM_ROLES.has(k))
            .sort((a, b) => {
                const aOrder = roleOrderMap[a];
                const bOrder = roleOrderMap[b];
                if (aOrder !== undefined && bOrder !== undefined) { return aOrder - bOrder; }
                if (aOrder !== undefined) { return -1; }
                if (bOrder !== undefined) { return 1; }
                return (a || '￿').localeCompare(b || '￿');
            });

        for (const role of roles) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'role-option';
            const meta = BUILT_IN_AGENT_LABELS.find(r => r.key === role);
            const label = meta ? meta.label : role;
            btn.textContent = label;
            btn.title = hasCommand[role]
                ? `Open ${label} terminal`
                : `${label} — no agent CLI configured (plain shell)`;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                pickerState = null;
                createTerminal(role, targetSpec, hasCommand[role] === true);
            });
            optionsEl.appendChild(btn);
        }

        const noRoleBtn = document.createElement('button');
        noRoleBtn.type = 'button';
        noRoleBtn.className = 'role-option is-no-role';
        noRoleBtn.textContent = 'No role';
        noRoleBtn.title = 'Plain shell in the workspace directory — no agent CLI started';
        noRoleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            pickerState = null;
            createTerminal(NO_ROLE, targetSpec, false);
        });
        optionsEl.appendChild(noRoleBtn);
        picker.appendChild(optionsEl);

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'role-picker-cancel';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', (e) => {
            e.stopPropagation();
            pickerState = null;
            renderSidebarList();
        });
        picker.appendChild(cancel);

        return picker;
    }
```

Wire the parent group (`:1587-1607`) — pass the key, and insert the picker between header and items:

```js
            groupNewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                onNewTerminalClicked(parentGroup.fullPath ? { parentRoot: parentGroup.fullPath } : undefined, parentKey);
            });

            headerEl.appendChild(titleArea);
            headerEl.appendChild(groupNewBtn);
            /* …existing collapse listener… */
            parentDiv.appendChild(headerEl);

            // Between header and items, NOT inside .parent-group-items — that
            // container is display:none when the group is collapsed, and a picker
            // the user opened must not vanish because the group happens to be shut.
            if (pickerState && pickerState.key === parentKey) {
                parentDiv.appendChild(buildRolePicker(pickerState.targetSpec));
                pickerRendered = true;
            }
```

Same shape for the worktree group (`:1656-1680`), keyed on `wtKey`, inserted into `wtDiv` after `wtHeaderEl`.

Declare `let pickerRendered = false;` at the top of `renderSidebarList` and, at the end of the parents loop, drop a picker whose group no longer exists:

```js
        // The group that owned the open picker is gone (mapping removed, worktree
        // pruned). Clearing here keeps the next `+` click from toggling a picker
        // nobody can see.
        if (pickerState && !pickerRendered) { pickerState = null; }
```

`renderGroupSidebar` (`:1350-1406`) — replace the capability the header button provided, after the `Show all terminals` row:

```js
        const newRow = document.createElement('div');
        newRow.className = 'worktree-group-header';
        newRow.textContent = '+ New terminal';
        newRow.addEventListener('click', () => onNewTerminalClicked(undefined, '__groups__'));
        listEl.appendChild(newRow);
        if (pickerState && pickerState.key === '__groups__') {
            listEl.appendChild(buildRolePicker(pickerState.targetSpec));
        }
```

`init()` — remove the two dead wirings (`:470-472` and `:493-499`):

```js
        // #btn-new-terminal and the static #role-picker-cancel are gone: the picker
        // is built per group by buildRolePicker(), and its Cancel carries its own
        // listener. Nothing global to bind.
```

### 3. Tests

- `src/test/terminal-sidebar-role-ordering-contract.test.js` — repoint its `block()` marker from `async function onNewTerminalClicked(` to `function buildRolePicker(`; the sort it asserts is unchanged.
- `src/test/terminal-sidebar-groupings-contract.test.js` — add: the picker renders from `pickerState` inside `renderSidebarList`, never via `document.getElementById('role-picker')`; the picker is appended to the group container and not to `.parent-group-items`; groups view offers a `+ New terminal` row.
- `src/test/multi-parent-terminals-contract.test.js` — unchanged (prefix regex still matches); run it to confirm.

## Verification Plan

1. **Automated**
   - `node src/test/terminal-sidebar-groupings-contract.test.js`
   - `node src/test/terminal-sidebar-role-ordering-contract.test.js`
   - `node src/test/multi-parent-terminals-contract.test.js`
2. **Manual — the reported bug**
   - Open the Terminals panel with two or more workspace mappings configured. Scroll so the second workspace header is near the bottom of the sidebar.
   - Click that workspace's `+`. **Expect:** the role menu appears immediately beneath *that* header, not at the top of the sidebar; nothing appears next to "Agents".
   - Pick a role. **Expect:** the terminal spawns in that workspace's directory (check the row's worktree label / `pwd`), the menu closes.
3. **Manual — re-render survival**
   - Open the picker and leave it untouched for 15 seconds (three fleet polls). **Expect:** it is still open and still under the same header.
   - With the picker open, spawn a terminal from another window so `terminalsChanged` fires. **Expect:** the list updates, the picker stays put.
4. **Manual — toggles and edges**
   - Click the same `+` twice. **Expect:** open then closed.
   - Open on workspace A, then click `+` on workspace B. **Expect:** the picker moves to B (does not merely close).
   - Collapse a group, then click its `+`. **Expect:** the group stays collapsed and the picker shows under the header.
   - Click `+` on a worktree sub-header. **Expect:** the picker appears under the worktree header and the spawned terminal lands in that worktree.
5. **Manual — no dead ends**
   - Zero terminals running: workspace headers and their `+` are still listed and usable.
   - Save a pane group, let the sidebar enter groups view: **Expect** a `+ New terminal` row at the bottom that opens the picker inline and spawns as before.
   - Confirm the empty-state text no longer names a button that does not exist.
