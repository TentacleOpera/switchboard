# Terminal Sidebar Groupings — Saved Pane-Assignment Sets, One-Click Switch

## Goal

Let the operator define named **groups of terminals** in the standalone browser Switchboard Terminals page, where each group is a saved `(layout, paneAssignments)` snapshot. The groups replace the individual terminal rows in the sidebar; clicking a group seats every terminal in that group into its saved pane in one action. Example: three groups of two terminals each (`2h` layout) — the sidebar shows three group rows instead of six terminal rows, and selecting a group shows both of its terminals side-by-side.

### Problem analysis

The Terminals cockpit sidebar today (`src/webview/terminals.js:797` `renderSidebarList`) renders the fleet as a flat list of individual terminal rows, grouped only by **parent workspace** and **worktree** (`parent-group` / `worktree-group` at `terminals.html:487-527`). Those groupings are *structural* — derived from where each terminal's pty was spawned (`item.parentRoot` / `item.worktreePath`) — and they are not switchable. Selecting a worktree group header collapses/expands it; it does not seat its terminals into panes.

The only durable seating state is `paneAssignments` (`terminals.js:12`), a single flat `[name|null]` array persisted via `terminals.paneAssignments` (`terminals.js:512/534`). There is exactly one such array, so the operator can only ever have **one** arrangement live at a time. To watch a different set of agents they must manually re-seat each pane, one click per pane — and the previous arrangement is lost the moment they do.

The planned pinning feature (`feature_plan_20260803151813_pin-terminals-to-panes.md`) addresses a related but distinct gap: it protects a *single slot* from being overwritten by sidebar clicks. It does not introduce the concept of a *named, switchable set* of seats. A group is "save the whole arrangement, name it, swap to another named arrangement in one click" — pinning is "protect one seat within the current arrangement". They compose (a group can contain pinned panes) but neither subsumes the other.

### Root cause

There is no persisted collection of seating snapshots. `paneAssignments` is a singleton, and `saveLayoutSettings()` (`terminals.js:532`) overwrites the one key `terminals.paneAssignments` on every mutation. The sidebar's render path (`renderSidebarList`) has no concept of a user-defined group — its only grouping primitives are the structural parent/worktree buckets, which are read-only and not seating-related. Switching "which agents I'm watching" therefore requires N manual re-seats and destroys the prior arrangement, because the system has nowhere to store a second one.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, ux, feature
- **Project:** Browser Switchboard

## Complexity Audit

### Routine

- Adding a `terminalGroups` array of `{ id, name, layout, assignments }` beside `paneAssignments`, persisted through the existing `saveSetting`/`loadSetting` pair (`terminals.js:499`/`482`). The `saveSetting` verb schema (`src/services/verbSchemas.ts`) only requires a `string` key — no backend change. **Verified.**
- A "Save current arrangement as group" control in the sidebar ops block (`terminals.html:837`), styled with the existing `.secondary-btn` treatment.
- Rendering group rows in `renderSidebarList` (`terminals.js:797`) using the existing `.worktree-group-header` / `.worktree-name` / `.worktree-count` styling (`terminals.html:426-485`) so a group row reads as a peer of the worktree rows.
- A `switchToGroup(id)` function that loads the group's `layout` into `currentLayout`/`effectiveLayout` and its `assignments` into `paneAssignments`, then re-renders.

### Complex / Risky

- **Sidebar mode switch.** The issue specifies that groups *replace* the individual terminal names in the sidebar. This is a render-mode change to `renderSidebarList`, not an additive row. Two modes are needed: the existing flat/structural list (default, when no groups exist or the user toggles back) and a groups mode (when groups are defined). The toggle must be persisted so the operator's choice survives reload, and the flat list must remain reachable so a terminal not in any group can still be seated individually.
- **Stale assignments after terminal death/rename.** A group's `assignments` are terminal-name strings captured at save time. `sanitizePaneAssignments` (`terminals.js:643`) already nulls slots whose terminal died — but it operates on the *live* `paneAssignments`, not on saved group snapshots. A group can hold a name that no longer exists; switching to it must not crash and must surface the dead slot the same way the live grid does (`(no longer listed)` / `(exited)` at `terminals.js:1203-1206`). Rename is harder: `renameTerminal` (`terminals.js:1626`) rewrites the live `paneAssignments` by index but has no knowledge of saved groups, so a renamed terminal would vanish from its groups. The group store needs a rename fixup mirroring the live-array fixup, OR groups should be re-resolved by a stable id — but the fleet has no stable id (only `friendlyName`), so name-keying is the only option and rename fixup is required.
- **Layout-floor interaction.** A group saved as `2x3` switched into a window too narrow for `2x3` must still floor down via `resolveFlooredLayout` (`terminals.js:1299`) — but the saved assignments are 6 long while the floored layout renders fewer panes. `sanitizePaneAssignments` already pads/truncates `paneAssignments` to `getMaxSlotCount()` and the render loop only iterates `getSlotCount(effectiveLayout)`, so the tail is preserved-but-inert. Switching must route through the same `setLayoutMode` + `applyLayoutFloor` path (`terminals.js:1013`/`1322`) rather than assigning directly, so the floor is honoured.
- **Solo mode.** `?solo=` forces `currentLayout='1'` and a single assignment (`terminals.js:301-303`), and `saveSetting` no-ops when `soloTerminalName` is set (`terminals.js:500`). Group UI must be suppressed in solo (the sidebar is hidden via `body.is-solo` at `terminals.html:793` anyway), and group switching must no-op — solo is a single pinned terminal by URL contract.
- **Group vs. pin coherence.** If the pinning feature ships, a group's saved `assignments` carry no pin state (pins are per-slot, live-only in that plan). Switching to a group should not silently clear or invent pins. Cleanest contract: switching a group resets `paneAssignments` and `currentLayout` only; `pinnedPanes` is left untouched and re-sanitised by the existing empty-slot rule. Document this so the two features do not fight.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| No groups defined | Sidebar renders exactly as today (flat/structural list). Group UI hidden or inert. |
| One group defined, operator clicks it | Layout switches to the group's saved layout; panes seat the group's terminals in their saved slots; focus moves to pane 0. |
| Group saved with an empty slot (e.g. `2h` with only pane 0 filled) | Switching seats pane 0 and leaves pane 1 empty — same as the live arrangement was at save time. |
| A terminal in a saved group has since exited | Switching seats the survivors; the dead terminal's slot renders `(exited)` / `(no longer listed)` per the existing `renderPaneGrid` logic. No crash. |
| A terminal in a saved group was renamed | Group's assignment is updated by the rename fixup so the renamed terminal still seats. (If fixup is skipped, the slot renders `(no longer listed)` — degraded but not broken.) |
| A terminal in a saved group was closed and a new one spawned with the same name | The new terminal seats in that slot. Acceptable — names are the only key. |
| Operator saves a group, then changes the live arrangement, then clicks the group again | Live arrangement is replaced by the group's snapshot. The previous live arrangement is NOT auto-saved — saving is explicit. (Optional: an "unsaved changes" dot on the active group when live diverges; out of scope for v1.) |
| Operator deletes the active group | Live `paneAssignments`/`currentLayout` are left as-is (the terminals keep running); the sidebar reverts to the flat list (or the next group if any remain). |
| Group's saved layout is `3x3` but window is narrow | `setLayoutMode` + `applyLayoutFloor` floors down; tail assignments persist inert. Banner shows as today. |
| `terminalGroups` persisted value is corrupt (non-array / bad element shape) | `Array.isArray` + per-element shape guard in `loadLayoutSettings`, mirroring the existing `savedPanes` guard (`terminals.js:520`). Bad entries dropped, not fatal. |
| Solo pop-out (`?solo=`) | Group UI suppressed (sidebar hidden by `body.is-solo`); `switchToGroup` no-ops; no `terminalGroups` write issued (`saveSetting` already no-ops in solo). |
| Pinning feature ships later | Group switch touches only `paneAssignments` + `currentLayout`; `pinnedPanes` left alone and re-sanitised by the existing empty-slot rule. No conflict. |

**Dependencies:** none beyond the existing `getSetting`/`saveSetting` verbs. No DB migration, no extension-host change, no new HTTP route. Webview JS/HTML are copied verbatim into `dist/webview/` by webpack, so `npm run compile` plus a panel reload is the build path. No dependency on the pinning plan — the two compose cleanly.

## Proposed Changes

### 1. `src/webview/terminals.js` — group state + persistence

Declare the store beside `paneAssignments` (near line 12):

```js
// Named, switchable seating snapshots. Each group is a (layout, assignments)
// captured at save time. assignments is a [name|null] array length-aligned with
// the group's layout slot count. Names are terminal friendlyNames — the fleet
// has no stable id, so renameTerminal must fixup group assignments the same way
// it fixes the live paneAssignments.
let terminalGroups = []; // [{ id, name, layout, assignments }]
let activeGroupId = null; // which group is currently seated, or null for "none/unsaved"
```

Load/save in `loadLayoutSettings` (line 510) and `saveLayoutSettings` (line 532):

```js
// in loadLayoutSettings
const savedGroups = await loadSetting('terminals.groups', []);
if (Array.isArray(savedGroups)) {
    terminalGroups = savedGroups.filter(g =>
        g && typeof g.id === 'string' && typeof g.name === 'string' &&
        LAYOUT_MODES.includes(g.layout) && Array.isArray(g.assignments)
    );
}
const savedActive = await loadSetting('terminals.activeGroupId', null);
activeGroupId = (typeof savedActive === 'string' || savedActive === null) ? savedActive : null;
```

```js
// in saveLayoutSettings
saveSetting('terminals.groups', terminalGroups);
saveSetting('terminals.activeGroupId', activeGroupId);
```

### 2. `src/webview/terminals.js` — save / delete / switch

```js
function saveCurrentAsGroup(name) {
    const id = 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const group = {
        id,
        name,
        layout: currentLayout,
        // Snapshot the RENDERED-length slice; the tail beyond effectiveLayout is
        // not visible and saving it would resurrect invisible state on switch.
        assignments: paneAssignments.slice(0, getSlotCount(effectiveLayout))
    };
    terminalGroups.push(group);
    activeGroupId = id;
    saveLayoutSettings();
    renderSidebarList();
}

function deleteGroup(id) {
    terminalGroups = terminalGroups.filter(g => g.id !== id);
    if (activeGroupId === id) { activeGroupId = null; }
    saveLayoutSettings();
    renderSidebarList();
}

function switchToGroup(id) {
    if (soloTerminalName) { return; }
    const group = terminalGroups.find(g => g.id === id);
    if (!group) { return; }
    // Route through setLayoutMode so the pane-size floor is honoured and the
    // layout picker UI updates. setLayoutMode calls sanitizePaneAssignments +
    // renderPaneGrid + applyLayoutFloor.
    paneAssignments = group.assignments.slice();
    activeGroupId = id;
    setLayoutMode(group.layout); // re-renders + saves
    saveLayoutSettings(); // persist activeGroupId
}
```

### 3. `src/webview/terminals.js` — rename fixup for group assignments

In `renameTerminal` (line 1626), beside the existing live-array fixup at line 1640-1641, add the same fixup over every group's `assignments`:

```js
for (const g of terminalGroups) {
    for (let i = 0; i < g.assignments.length; i++) {
        if (g.assignments[i] === oldName) { g.assignments[i] = next; }
    }
}
saveLayoutSettings();
```

### 4. `src/webview/terminals.js` — sidebar render mode

At the top of `renderSidebarList` (line 797), branch on whether groups exist:

```js
function renderSidebarList() {
    listEl.innerHTML = '';
    if (fleetList.length === 0) {
        if (!soloTerminalName) {
            emptyStateEl.style.display = 'flex';
            paneGridEl.style.display = 'none';
        }
        return;
    }
    emptyStateEl.style.display = 'none';
    paneGridEl.style.display = 'grid';

    if (terminalGroups.length > 0 && !soloTerminalName) {
        renderGroupSidebar();
        return; // groups replace the individual terminal rows, per the request
    }
    // ...existing parent/worktree structural render unchanged...
}
```

`renderGroupSidebar` renders one row per group (`.worktree-group-header` styling) showing the group name, a count badge (`N terminals`), an active highlight when `activeGroupId === g.id`, and inline `switch` / `delete` controls. A trailing "＋ New group" row captures the current arrangement (prompts for a name via an inline input, never `window.prompt` — see CLAUDE.md). A small "show all terminals" toggle at the bottom of the list flips back to the flat structural render for one-off seating of terminals not in any group (persisted as `terminals.groupsView = false`).

### 5. `src/webview/terminals.html` — save-group control

Add a button to the `.sidebar-ops` block (line 837), styled as a `.secondary-btn w-full`:

```html
<button type="button" id="btn-save-group" class="secondary-btn w-full"
        title="Save the current pane arrangement as a named group">SAVE AS GROUP</button>
```

No new CSS classes — reuse `.secondary-btn`, `.worktree-group-header`, `.worktree-name`, `.worktree-count`, `.btn-group-new` (the existing `+` button style at `terminals.html:470`). Per CLAUDE.md: no confirm dialog on delete — the delete control removes the group immediately.

### 6. Contract test — `src/test/terminal-sidebar-groupings-contract.test.js`

A headless contract test (mirroring `terminal-solo-popout-contract.test.js` and the pinning plan's test) asserting:
- `switchToGroup` sets `currentLayout`, `effectiveLayout`, and `paneAssignments` from the group snapshot.
- Switching to a group whose layout floors down leaves the tail assignments inert (rendered slot count < snapshot length).
- `renameTerminal` updates a group's `assignments` when the renamed terminal was in it.
- `saveSetting` is not called when `soloTerminalName` is set.
- A corrupt `terminals.groups` persisted value (non-array, missing fields) is dropped without throwing.

Register in `package.json` and `.github/workflows/integration-tests.yml` alongside the sibling terminal-webview contract tests.

## Verification Plan

### Automated

```bash
cd /Users/patrickvuleta/Documents/GitHub/switchboard
npm run lint
npm run test:contract:terminal-sidebar-groupings
npm run test:contract:terminal-solo-popout     # regression: solo still suppresses persistence
npm run test:contract:shell-terminal-strip     # regression: sidebar strip + badge paths
npm run compile                                 # webpack copies src/webview/* → dist/webview/*
```

### Manual — the headline case (must pass)

1. Reload the Switchboard cockpit; open the Terminals panel in the standalone browser; select `2h`.
2. Seat agent **A** in pane 0 and agent **B** in pane 1.
3. Click **SAVE AS GROUP**, enter "Frontend" → the sidebar now shows one row: `Frontend · 2 terminals`, highlighted as active.
4. Re-seat panes: put **C** in pane 0 and **D** in pane 1. Click **SAVE AS GROUP**, enter "Backend" → sidebar shows two group rows, `Backend` active.
5. Click the **Frontend** group row → panes switch back to A and B in one click; layout picker shows `2h`; `Frontend` row is now active.
6. Click the **Backend** group row → panes switch to C and D.

### Manual — edge cases

7. Save a group with an empty pane (`2h`, only pane 0 filled) → switching to it seats one terminal and leaves pane 1 empty.
8. Close agent A from the sidebar while the `Frontend` group is active → pane 0 empties; switch away to `Backend` and back to `Frontend` → pane 0 shows `(no longer listed)` and does not crash.
9. Rename agent A → switch to the `Frontend` group → the renamed terminal is still seated in pane 0 (rename fixup held).
10. Delete the active group → sidebar reverts to the flat terminal list (or the remaining group); live panes keep running untouched.
11. Save a group as `3x3`, then narrow the window below the `3x3` floor → switching to the group floors down via the banner; tail assignments persist inert; widening re-seats them.
12. Pop a terminal out with `?solo=` → no group sidebar, no SAVE AS GROUP button, no `terminals.groups` write.
13. Reload the browser panel with groups defined → groups and the active group survive (`terminals.groups` / `terminals.activeGroupId` persisted).
14. Click "show all terminals" at the bottom of the group sidebar → flat structural list returns for one-off seating; switching back to a group re-enters group mode.

---

**Recommendation: Send to Coder** (Complexity 6).
