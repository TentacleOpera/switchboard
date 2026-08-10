# New-Terminal Role Picker Opens at the Top of the Terminals Sidebar Instead of Under the Workspace Header That Was Clicked

## Goal

Make the new-terminal role picker appear directly beneath the workspace (or worktree) header whose `+` was clicked, and remove the `+ New` button that currently sits next to the **Agents** sidebar title — the spawn control belongs with the place it spawns into, not at the top of the list.

### Problem

The Terminals sidebar has three `+` controls and one picker. The per-parent `+` in each workspace header (`src/webview/terminals.js:1588-1595`) and the per-worktree `+` in each worktree header (`:1657-1664`) both carry a target — `{ parentRoot }` or `{ worktreePath }`. But every one of them, plus the global `+ New` in the sidebar header, calls the same `onNewTerminalClicked(targetSpec)`, which unhides a **single static element** declared once at the very top of the sidebar:

```html
<div class="sidebar-header">
    <span class="sidebar-title">Agents</span>
    <button id="btn-new-terminal" class="btn-new-terminal">+ New</button>
</div>
<div id="role-picker" class="role-picker" hidden>
```
— `src/webview/terminals.html:1390-1398`

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

`renderSidebarList` begins with `listEl.innerHTML = ''` (`src/webview/terminals.js:1452`) and runs from **23 call sites** — every fleet poll (5 s, `startFleetPoll` at `:3118-3128`), every `terminalsChanged` push, every group collapse toggle (`:1607`, `:1676`), every badge change (`:3984`), every rename, every layout change. A picker imperatively inserted into a group would be destroyed by the next poll — within five seconds, mid-choice. The picker must therefore be **state-driven**: an open-picker descriptor in module state, re-rendered as part of the group it belongs to.

### Why "attached in the DOM" is not the same as "visible" (added by improve pass)

`.terminals-list` is `flex: 1; overflow-y: auto` (`terminals.html:180-184`) — it is the sidebar's scroll container. Rendering the picker as a sibling of the clicked header puts it in the right *place*, but if that header sits at the bottom edge of the scrollport the picker renders **below the fold** and the user sees nothing happen: the *exact reported symptom*, from a new cause. The relocation is therefore only half the fix; a one-shot scroll-into-view on the render that opens the picker is the other half. `body` is `height: 100vh; overflow: hidden` (`terminals.html:92-101`), so `.terminals-list` is the only ancestor that can scroll — the movement is contained to the sidebar and cannot shift the panel layout.

## Reconcile Before Building

This plan shares `src/webview/terminals.js` and `terminals.html` with two subtasks of the feature *Terminals Pane: Groups, Peek, and Bulk Terminal Creation* (`9e7c314d`). The project PRD allows **one agent stream per file**, so none of these may be coded in parallel.

**`role-grid-fill-terminals.md` — direct conflict, but a favourable one.** It builds on exactly what this plan restructures: it cites `#role-picker` (`terminals.html:1398-1401`) and `onNewTerminalClicked` (`terminals.js:3598`) as existing assets, and instructs *"Reuse that builder rather than writing a second role list"* for its Fill-grid role selector. Today there is no builder to reuse — the role list is inlined in `onNewTerminalClicked`, which is why Role Grid Fill has to describe reuse rather than just call something.

**Land this plan first.** `buildRolePicker(targetSpec)` *is* the extracted builder Role Grid Fill asks for, so landing in this order turns its "reuse the builder" instruction into a real function call and deletes the duplication risk. If Role Grid Fill lands first, it will have copied or re-derived the role list and this plan must reconcile both copies — strictly more work, and a live opportunity for the two role lists to drift.

Two follow-on notes for whoever codes Role Grid Fill afterwards:

- Its Fill-grid action needs a home now that the sidebar header holds only the title. The `.sidebar-ops` block (`terminals.html:1408-1420`, beside `OPEN AGENT TERMINALS`) is the natural place — it is a fleet-wide action, not a per-workspace one, so it does **not** belong in the per-group inline picker.
- Its role list must come from `buildRolePicker`'s filtering and sorting, not from a second copy of the `SYSTEM_ROLES` / `roleOrderMap` / `BUILT_IN_AGENT_LABELS` logic.

**`terminals-sidebar-groups-and-grids-ia.md` — same file, overlapping surface.** It recasts the sidebar into a hierarchy and rewrites `src/test/terminal-sidebar-groupings-contract.test.js` (the feature notes it "removes every symbol it asserts"). This plan renders the inline picker into the parent/worktree group containers and adds a spawn row to `renderGroupSidebar` — both of which that plan reshapes. Sequence them; do not merge the two sets of edits by hand. If Groups lands first, re-derive the insertion points from whatever container structure it leaves rather than the `parentDiv` / `wtDiv` names used below.

**`terminal-peek-temporary-fullscreen.md`** shares the sidebar *row* action cluster (it takes the leftmost slot, before `clear`). This plan does not touch row actions — only group headers and the picker — so there is no direct conflict, but it is a third writer to the same file.

Line references below were verified against the working tree on 2026-08-08, which carries uncommitted changes to `terminals.js` and `terminals.html`. Re-grep the symbols rather than trusting a line number. *(Improve pass, same day: every line reference in this plan was re-read against that same working tree and the drifted ones corrected — see the corrections inline. The instruction to re-grep still stands, because the three sibling plans above will move them again.)*

## Metadata

- **Complexity:** 5

> **Superseded:** **Complexity:** 4
> **Reason:** The plan's own Complexity Audit lists three complex/risky items, and the improve pass added a fourth (an async race across the `await` in the click handler) and a fifth (below-the-fold rendering re-creating the reported symptom). The change touches two source files plus three test files, introduces new module state that must survive a wipe-and-rebuild renderer driven from 23 call sites, and has a real click-interleaving hazard. That is a 5 (Mixed: majority routine with two or three moderate, well-scoped risks) — not a 4. Routing is unchanged (4-6 → Coder), but the score should not under-report the risk surface.
> **Replaced with:** **Complexity:** 5

- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

**Routine (majority):**
- Moving DOM construction out of `onNewTerminalClicked` into a `buildRolePicker(targetSpec)` helper — the same nodes, same classes, same listeners, built in a different place.
- Deleting the header button, its module-level `const btnNew` handle (`terminals.js:110`), its `init()` wiring (`:470-472`), the static `#role-picker-cancel` wiring (`:493-499`), and the now-orphaned `.btn-new-terminal` CSS (`terminals.html:124-136`).
- Copy edit to the empty-state string and to the CSS comment that quotes it.

**Complex / risky (five items):**
1. **Re-render survival.** The picker now lives inside a container that is wiped every few seconds. Getting this wrong produces a menu that vanishes while the user reads it — worse than the bug being fixed. Resolved by making `pickerState` module state and rendering from it, never by inserting on click.
2. **Async roles in a synchronous renderer.** `onNewTerminalClicked` currently `await`s `fetchPtyVisibleRoles()` before showing anything; `renderSidebarList` is synchronous. The fetch result must be cached so a re-render can rebuild the picker without a second round trip and without a flash of an empty menu.
3. **Removing the global `+ New` removes the only spawn control in groups view.** `renderSidebarList` early-returns into `renderGroupSidebar` when saved groups exist (`:1474-1477`), and `renderGroupSidebar` (`:1350-1407`) renders only group rows — no `+` anywhere. Deleting the header button without replacing it there would strand a groups-view user with no way to open a terminal. Handled explicitly below.
4. **Interleaved clicks across the `await`** (added by improve pass). The toggle-closed check reads `pickerState` *before* an `await`, so two clicks land in the same window with `pickerState` still `null`. Two `+` clicks on the same group open instead of toggling; two clicks on different groups both proceed and the slower fetch wins. Resolved with a synchronous in-flight key.
5. **Below-the-fold rendering** (added by improve pass). See *Why "attached in the DOM" is not the same as "visible"* above. Resolved with a one-shot `scrollIntoView` consumed by the opening render only — never on a poll re-render, which would yank the operator's scroll position every 5 s.

## Edge-Case & Dependency Audit

- **Collapsed group.** `.parent-group.collapsed .parent-group-items` and `.worktree-group.collapsed .worktree-items` set `display: none` (`terminals.html:567-569`, `:536-538`). The picker is inserted as a **sibling** of the items container, between the header and the items — so it stays visible when the group is collapsed. Clicking `+` on a collapsed group must not also toggle the collapse: the existing `e.stopPropagation()` in both `+` handlers already prevents that and must be kept. Note the collapse listener sits on `headerEl` / `wtHeaderEl`, not on `parentDiv` / `wtDiv`, so a click inside the picker cannot reach it even without the guard — keep the guard anyway.

  > **Superseded:** `.parent-group.collapsed .parent-group-items` and `.worktree-group.collapsed .worktree-items` at `terminals.html:588-590`, `:519-521`.
  > **Reason:** Both line numbers are wrong against the working tree — `:588-590` lands in the `.pane-grid` block and `:519-521` in `.worktree-name`/`.worktree-count`. A coder following them would edit or reason about the wrong rules. The rules themselves exist and the conclusion drawn from them is correct.
  > **Replaced with:** `.worktree-group.collapsed .worktree-items` is at `:536-538`; `.parent-group.collapsed .parent-group-items` is at `:567-569`.

- **Worktree picker under a collapsed parent.** `wtDiv` lives inside `.parent-group-items`, so a worktree picker *is* hidden when the **parent** collapses. That is correct: collapsing the parent hides the worktree header too, so nothing is orphaned, and expanding restores the still-open picker.
- **Target group disappears while the picker is open** (workspace mapping removed, worktree pruned). Track whether the picker was rendered this pass; if `pickerState` is set and nothing matched, clear it — otherwise the next `+` click on any group toggles a picker the user cannot see. **The clear must run AFTER the parents loop closes (after `:1693`), not inside it** — inside the loop it would fire on the first non-owning group and clear the state on every render.
- **Groups-view early return strands parent picker state** (added by improve pass). `renderSidebarList` returns at `:1474-1477` before the parents loop, so the not-rendered clear never runs in groups view and a `parent:*` / `worktree:*` key survives a switch into groups mode. `renderGroupSidebar` clears any non-`__groups__` key on entry.
- **Two `+` clicks in a row.** Existing behaviour is toggle-closed (`if (!picker.hidden) { picker.hidden = true; return; }`). Preserve it, keyed per group: clicking the same group's `+` closes; clicking a *different* group's `+` moves the picker there rather than closing it. The in-flight key makes this hold across the `fetchPtyVisibleRoles()` await, not only after it resolves.
- **Groups view.** `renderGroupSidebar` gets a `+ New terminal` row appended below the group rows, opening the picker inline with `targetSpec === undefined` — exactly what today's header button does, just relocated into the list. Verified against `createTerminal` (`:3656-3670`): an `undefined` targetSpec posts `{ role }` only, and the host fills in the active parent. Capability preserved, top-of-sidebar oddity gone.
- **Solo mode.** `body.is-solo .terminals-sidebar { display: none }` (`terminals.html:1363-1367`) — the whole sidebar is hidden, so no path here runs. `renderSidebarList` also skips group mode when `soloTerminalName` is set.
- **Empty fleet.** `renderSidebarList` deliberately does **not** early-return on an empty fleet (`:1464-1472`, with the reasoning in the comment at `:1453-1463`) precisely so the per-workspace `+` stays reachable with zero terminals. That invariant is now load-bearing — with the header button gone it is the *only* spawn path. Do not reintroduce an early return.
- **Empty-state copy.** `#empty-state` reads `No terminal selected. Click "+ New" to spawn a terminal.` (`terminals.html:1451-1453`) and the comment above the `body.is-solo #empty-state` rule quotes that copy at `:1372` and says "solo mode never offers + New" at `:1374`. Both reference a button that will not exist. Update the copy **and both lines of that comment**; leave the CSS rule itself (the behaviour is still correct, only the wording changes). Those are the only two occurrences of the string in the repo — verified by grep across `src/`, `.agents/` and `.switchboard/features/`.
- **`(no terminals — + to open)` notice** (`terminals.js:1615-1619`) already points at the per-group `+`. Still accurate — it becomes the primary instruction rather than a secondary one.
- **Nothing else may keep a handle on `#role-picker`.** After this change the element does not exist until a group renders one, so any `document.getElementById('role-picker')` anywhere in the tree is a latent null deref. Grep before finishing — and note that `role-grid-fill-terminals.md` currently names that element as an asset it builds on (see *Reconcile Before Building*). **Improve-pass result:** the grep is already clean apart from this plan's own deletions — `document.getElementById('role-picker')` appears exactly twice in `src/`, at `terminals.js:496` (the `init()` cancel wiring this plan removes) and `terminals.js:3599` (the function this plan replaces). `#role-picker-options` appears once, at `:3600`, likewise inside the replaced function. Nothing outside `terminals.js` holds a handle. Re-run the grep at the end anyway, because Role Grid Fill may have added one by then.
- **`buildRolePicker` scope.** It must be a hoisted `function` declaration (not a `const` arrow) placed beside `onNewTerminalClicked` at `~:3600`, because `renderSidebarList` calls it from `~:1610`. It reads three bindings declared later in the file or injected from outside it: `roleOrderMap` (`:48`), `NO_ROLE` (`:3535`), and `BUILT_IN_AGENT_LABELS` / `DEFAULT_VISIBLE_AGENTS` (from `src/webview/sharedDefaults.js`, injected via the `<!-- SHARED_DEFAULTS_SCRIPT -->` marker — `headlessPanelHtml.ts:63-74`, `TaskViewerProvider.ts:21568-21569`). All are already in scope for the current code at that same location, and no *new* `sharedDefaults` binding is referenced, so `src/test/webview-shim-injection-contract.test.js` is unaffected.
- **Stale `targetSpec` in `pickerState`** — accepted, not fixed. The stored spec is captured at click time. If the operator edits a workspace mapping's folder while keeping the same parent `id`, an open picker would spawn into the old path. Deriving the target live in the renderer would close this, but it forces `onNewTerminalClicked`'s first parameter to become dead — and `src/test/multi-parent-terminals-contract.test.js:251` pins that argument. The window (editing mappings with a picker open, same id, new folder) is not worth a dead parameter plus a contract-test edit. Documented deliberately.
- **Accessibility.** The groups-view `+ New terminal` row is a `<div>` with a click listener, so it is not keyboard-focusable — consistent with the adjacent `Show all terminals` (`:1397-1406`) and `Show groups` (`:1696-1707`) rows it sits beside. The per-workspace and per-worktree `+` remain real `<button>` elements, so the primary spawn path keeps its keyboard affordance. No regression relative to the rows around it; not widened here.
- **Persisted state.** None touched. `pickerState`, `pickerOpening`, `rolePickerData` and `pickerNeedsScroll` are transient module state; nothing reaches `saveLayoutSettings`, a settings key, or the DB — no migration per CLAUDE.md.
- **PRD contracts.** No verb, route, schema or `/panels` manifest row changes, so the return-in-body contract (#4), boundary validation (#5) and two-layer completion (#7) are untouched. `terminals.html` / `terminals.js` are single shared files served to both hosts — grep confirms exactly one copy of this markup — so anti-divergence (#1) holds with no second edit site. Capability-gating honesty (#6) is *why* the groups-view `+ New terminal` row is mandatory rather than optional: removing the only spawn control from a view is precisely the dead end that contract forbids.
- **Contract tests over this source.** `src/test/multi-parent-terminals-contract.test.js:251` pins `onNewTerminalClicked(parentGroup.fullPath ? { parentRoot: parentGroup.fullPath }` as a **prefix** regex, so appending a second argument keeps it green — do not reorder the arguments. `src/test/terminal-sidebar-groupings-contract.test.js` reads `renderSidebarList` and `renderGroupSidebar` blocks by marker; all of its markers were re-checked and survive (details under *Proposed Changes → 3. Tests*).

  > **Superseded:** "`src/test/terminal-sidebar-role-ordering-contract.test.js` reads the role sort inside `onNewTerminalClicked` — that sort moves into `buildRolePicker`, so its marker must be updated in lockstep."
  > **Reason:** Factually wrong, and actively misleading. That file has seven `block()` markers — `KANBAN_ROLE_ORDER_FALLBACK`, `buildColumnList`, `recomputeRoleOrderMap`, `compareTerminals`, `renderSidebarList`, `fetchKanbanColumnStructure`, `init()` — and **none of them mentions `onNewTerminalClicked`**. The "role sort" it asserts is `compareTerminals`' ordering of terminal *rows*, not the picker's ordering of *role chips*. A coder following this instruction would hunt for a marker that does not exist. The file does impose a real constraint, but a different one — see *3. Tests*.
  > **Replaced with:** No marker edit in that file. Its binding constraint is that the `renderSidebarList` block (`function renderSidebarList() {` → `for (const item of parentGroup.direct) {`) must still contain `group.direct.sort(compareTerminals)` and `wtGroup.items.sort(compareTerminals)` — so do not move the sorts (`:1544`, `:1546`) below the parents loop.

- **No confirm gates.** The picker's Cancel button stays a plain dismiss; nothing here adds a confirmation step.

## Dependencies

- None as a `sess_` dependency. The *sequencing* constraint is not a dependency but a file-contention one and is stated in **Reconcile Before Building** above: land this plan before `role-grid-fill-terminals.md`, and serialise against `terminals-sidebar-groups-and-grids-ia.md` and `terminal-peek-temporary-fullscreen.md`.

## Adversarial Synthesis

**Risk Summary.** Three risks dominate. (1) *State/render coupling* — the picker now depends on a renderer that wipes and rebuilds its container from 23 call sites; a picker inserted imperatively, or a not-rendered clear placed inside the parents loop instead of after it, produces a menu that vanishes or a `+` that silently no-ops. (2) *Visibility ≠ attachment* — relocating the picker into the scrolling list reproduces the original "click does nothing" symptom whenever the clicked header sits at the bottom of the scrollport. (3) *Removing the only global spawn control* — groups view has no `+` at all, so deleting the header button without the replacement row strands the user. Mitigations: state-driven render from `pickerState`, with the not-rendered clear placed after the parents loop and a matching clear on entry to `renderGroupSidebar`; a one-shot `scrollIntoView` consumed only by the opening render; a `+ New terminal` row in `renderGroupSidebar`; and a synchronous in-flight key so clicks interleaved across the roles fetch still toggle correctly. Sequencing against the three sibling plans that write the same file is a separate, non-technical risk tracked in *Reconcile Before Building*.

## Proposed Changes

### 1. `src/webview/terminals.html` — delete the header button and the static picker

Replace `:1389-1402`:

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

`.sidebar-header` keeps `justify-content: space-between` (`:110-117`) — harmless with a single child; the title left-aligns as before.

Delete the now-orphaned `.btn-new-terminal` and `.btn-new-terminal:hover` rules (`:124-136`) — the removed button was their only consumer.

Keep every `.role-picker`, `.role-picker-title`, `.role-picker-options`, `.role-option`, `.role-option.is-no-role` and `.role-picker-cancel` rule (`:185-244`) — the markup is identical, only its position changes. `.role-picker[hidden] { display: none }` (`:190`) becomes unreachable (the inline picker is rendered or absent, never `hidden`); leave it — it costs nothing and documents the prior contract.

Add one rule so an inline picker reads as nested under its header rather than as a peer of the group:

```css
        /* Inline picker: nested under the group header that opened it. The static
           top-of-sidebar picker had a bottom border acting as a section divider;
           inside a group that divider is wrong, so it becomes a left rail instead —
           the same 2px accent rail .parent-group-header wears at :556, so the picker
           reads as continuous with the header that opened it. */
        .role-picker.is-inline {
            border-bottom: none;
            border-left: 2px solid var(--accent-teal, #4ec9b0);
            margin: 2px 0 4px 6px;
            border-radius: 0 3px 3px 0;
        }
```

*(The `#4ec9b0` fallback is dead — `--accent-teal` is defined at `:32` and `:64` and resolves to `#D97757` — but it is copied verbatim from the `.parent-group-header` rule this rail mirrors. Keep it in step with that rule rather than diverging from it.)*

Update the empty-state copy (`:1451-1453`):

```html
        <div id="empty-state" class="empty-state">
            No terminal selected. Use the + beside a workspace in the sidebar to spawn one.
        </div>
```

…and the comment above `body.is-solo #empty-state` that quotes the old copy (`:1372`) and asserts the old affordance (`:1374`):

```
           would stack "No terminal selected. Use the + beside a workspace" above the
           live terminal and halve the window. It also collides with #solo-status on
           the not-found path. Suppress it outright; solo mode hides the sidebar, so
           it never offers a spawn control at all.
```

### 2. `src/webview/terminals.js` — state-driven inline picker

Remove the module-level handle to the deleted button (`:110`):

```js
        const emptyStateEl = document.getElementById('empty-state');
        // `btnNew` is gone with #btn-new-terminal — spawning is per-group now.
        const paneGridEl = document.getElementById('pane-grid');
```

Module state, next to the other sidebar flags near `groupsView` (`:68-70`):

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
    /**
     * Group key whose roles fetch is in flight. Synchronous, so a second click that
     * lands DURING the await is still seen: without it the toggle-closed check reads
     * a pickerState the first click has not assigned yet, so double-clicking one `+`
     * opens twice instead of closing, and two different `+` clicks race on whichever
     * fetch resolves last rather than on whichever was clicked last.
     */
    let pickerOpening = null;
    /** Cached { visibleAgents, hasCommand } so a re-render rebuilds the picker
     *  without a round trip and without flashing an empty menu. */
    let rolePickerData = null;
    /**
     * One-shot: scroll the picker into view on the render that OPENED it, and only
     * that render. .terminals-list is overflow-y:auto, so a `+` on a header at the
     * bottom of the scrollport renders the picker below the fold — the same
     * "click did nothing" symptom this change exists to remove. Not applied on poll
     * re-renders, which would yank the operator's scroll position every 5 seconds.
     */
    let pickerNeedsScroll = false;
```

Replace `onNewTerminalClicked` (`:3598-3654`) with a toggle that only sets state:

```js
    async function onNewTerminalClicked(targetSpec, key) {
        const groupKey = key || '__default__';
        // Toggle closed: an open picker on this group, OR one whose roles fetch is
        // still in flight for this group.
        if ((pickerState && pickerState.key === groupKey) || pickerOpening === groupKey) {
            pickerState = null;
            pickerOpening = null;
            renderSidebarList();
            return;
        }
        // Claim the open synchronously, then fetch BEFORE committing pickerState, so
        // the picker never renders empty and then repopulates.
        pickerOpening = groupKey;
        const data = await fetchPtyVisibleRoles();
        // A later click (or a cancel) superseded this one — discard the result.
        if (pickerOpening !== groupKey) { return; }
        pickerOpening = null;
        rolePickerData = data;
        pickerState = { key: groupKey, targetSpec };
        pickerNeedsScroll = true;
        renderSidebarList();
    }
```

> **Superseded:**
> ```js
> async function onNewTerminalClicked(targetSpec, key) {
>     const groupKey = key || '__default__';
>     if (pickerState && pickerState.key === groupKey) {
>         pickerState = null;
>         renderSidebarList();
>         return;
>     }
>     rolePickerData = await fetchPtyVisibleRoles();
>     pickerState = { key: groupKey, targetSpec };
>     renderSidebarList();
> }
> ```
> **Reason:** The toggle-closed check reads `pickerState` *before* the `await`, and `pickerState` is only assigned *after* it. Every click that lands inside that window sees `pickerState === null`. Two rapid clicks on the same `+` therefore both fall through and both open — so the toggle-closed behaviour this plan promises to preserve is lost precisely when the fetch is slow (cold cache, busy host), which is exactly when a user double-clicks. Two clicks on different groups both proceed and whichever fetch resolves *last* wins, regardless of which was clicked last. The fetch is re-issued on every open deliberately (so a role toggled visible in Setup appears without a reload), which means the window exists on every open, not just the first.
> **Replaced with:** A synchronous `pickerOpening` key claimed before the `await` and re-checked after it — the toggle now sees in-flight opens, and a superseded fetch discards its own result instead of clobbering a newer one. `rolePickerData` stays a re-render cache only, so per-open freshness is unchanged.

Add `buildRolePicker`, holding the role filtering/sorting/labelling verbatim from the old function body (`:3605-3651`) — only the surrounding element changes. It must be a `function` declaration (hoisted), because `renderSidebarList` calls it from ~1990 lines earlier:

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

        // Defensive only: onNewTerminalClicked assigns rolePickerData before it
        // assigns pickerState, so the renderer never sees one without the other.
        const data = rolePickerData || { visibleAgents: {}, hasCommand: {} };
        const visible = data.visibleAgents;
        const hasCommand = data.hasCommand;
        const SYSTEM_ROLES = new Set(['orchestrator', 'mcp_monitor']);
        const roles = Object.keys(visible)
            .filter(k => visible[k] !== false && !SYSTEM_ROLES.has(k))
            .sort((a, b) => {
                const aOrder = roleOrderMap[a];
                const bOrder = roleOrderMap[b];
                // Mapped roles sort by column order ascending
                if (aOrder !== undefined && bOrder !== undefined) { return aOrder - bOrder; }
                // Mapped before unmapped
                if (aOrder !== undefined) { return -1; }
                if (bOrder !== undefined) { return 1; }
                // Both unmapped: alphabetical by role
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

        // Last, and visually separated: this is the absence of a role, not another
        // one, so it must not read as a peer of the agent buttons above it.
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
            pickerOpening = null;
            renderSidebarList();
        });
        picker.appendChild(cancel);

        return picker;
    }
```

Add the one-shot scroll wrapper beside it. **Every insertion point calls `mountRolePicker`, never `buildRolePicker` directly** — that way no call site can forget the scroll:

```js
    /**
     * buildRolePicker + the one-shot scroll-into-view. `.terminals-list` is the
     * sidebar's scroll container (overflow-y:auto), so a picker opened under a
     * header at the bottom of the scrollport lands below the fold and the click
     * reads as a no-op — the original bug wearing a different hat. Scrolling only
     * on the render that OPENED the picker is the point: doing it unconditionally
     * would fight the operator's scroll on every 5s poll re-render.
     *
     * block:'nearest' is a no-op when the picker is already fully visible, and
     * body is height:100vh/overflow:hidden, so .terminals-list is the only ancestor
     * that can scroll — the movement cannot shift the panel layout.
     */
    function mountRolePicker(targetSpec) {
        const el = buildRolePicker(targetSpec);
        if (pickerNeedsScroll) {
            pickerNeedsScroll = false;
            requestAnimationFrame(() => {
                if (el.isConnected) { el.scrollIntoView({ block: 'nearest' }); }
            });
        }
        return el;
    }
```

> **Superseded:** Insertion points call `buildRolePicker(pickerState.targetSpec)` directly; the plan has no scroll handling.
> **Reason:** Attachment is not visibility. The Problem section itself says "if the list is scrolled, the menu can open entirely off-screen and the click reads as a no-op" — moving the picker into the list does not remove that failure, it relocates it: click `+` on a header at the bottom edge of `.terminals-list` and the picker renders outside the scrollport. The plan would then *pass its own manual test #2* ("appears immediately beneath *that* header" — true in the DOM) while the user still sees nothing. That is the goal-vs-appearance gap, and it is the whole reported bug surviving the fix.
> **Replaced with:** All three insertion points call `mountRolePicker(...)`, which builds the picker and consumes the one-shot `pickerNeedsScroll` flag. `requestAnimationFrame` defers the scroll to after the render completes, when the node is attached and laid out.

Wire the parent group (`:1588-1610`) — pass the key, and insert the picker between header and items:

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
            // itemsContainer is appended later (:1691), so appending here yields
            // header → picker → items.
            if (pickerState && pickerState.key === parentKey) {
                parentDiv.appendChild(mountRolePicker(pickerState.targetSpec));
                pickerRendered = true;
            }
```

Same shape for the worktree group (`:1657-1679`), keyed on `wtKey`, inserted into `wtDiv` after `wtHeaderEl` (`:1679`) and before `wtItemsContainer` (`:1686`), also setting `pickerRendered = true`.

Declare `let pickerRendered = false;` at the top of `renderSidebarList` (`~:1451`, beside `syncLinkUpEnabled()`) and drop a picker whose group no longer exists — **after the parents loop closes at `:1693`**, before the `Show groups` block at `:1696`:

```js
        // The group that owned the open picker is gone (mapping removed, worktree
        // pruned). Clearing here keeps the next `+` click from toggling a picker
        // nobody can see. AFTER the loop, not inside it: inside, the first group
        // that is not the owner would clear the state on every single render.
        if (pickerState && !pickerRendered) { pickerState = null; }
```

`renderGroupSidebar` (`:1350-1407`) — clear a stranded key on entry, and replace the capability the header button provided, after the `Show all terminals` row (`:1397-1406`):

```js
        // renderSidebarList early-returns into this function (:1474-1477), so the
        // not-rendered clear at the end of the parents loop never runs in groups
        // view. A `parent:*` / `worktree:*` key would otherwise survive the switch
        // and make the next `+` click back in flat view toggle instead of open.
        if (pickerState && pickerState.key !== '__groups__') { pickerState = null; }
```

```js
        const newRow = document.createElement('div');
        newRow.className = 'worktree-group-header';
        newRow.textContent = '+ New terminal';
        newRow.addEventListener('click', () => onNewTerminalClicked(undefined, '__groups__'));
        listEl.appendChild(newRow);
        // Mandatory, not cosmetic: groups view has no per-group `+` at all, so
        // without this row, deleting #btn-new-terminal leaves the view with zero
        // spawn paths — the dead end the PRD's capability-gating contract forbids.
        if (pickerState && pickerState.key === '__groups__') {
            listEl.appendChild(mountRolePicker(pickerState.targetSpec));
        }
```

`init()` — remove the two dead wirings (`:470-472` and `:493-499`):

```js
        // #btn-new-terminal and the static #role-picker-cancel are gone: the picker
        // is built per group by buildRolePicker(), and its Cancel carries its own
        // listener. Nothing global to bind.
```

### 3. Tests

These are static contract tests that read `terminals.js` / `terminals.html` as **text**, so marker survival matters as much as behaviour. Every marker below was re-checked against the current test sources during the improve pass.

- **`src/test/terminal-sidebar-role-ordering-contract.test.js` — no edit.** Its seven `block()` markers are `KANBAN_ROLE_ORDER_FALLBACK`, `buildColumnList`, `recomputeRoleOrderMap`, `compareTerminals`, `renderSidebarList` (→ `for (const item of parentGroup.direct) {`), `fetchKanbanColumnStructure`, and `init()`. None references `onNewTerminalClicked`. The binding constraint is instead: the `renderSidebarList` block must still contain `group.direct.sort(compareTerminals)` and `wtGroup.items.sort(compareTerminals)` (`:1544`, `:1546`), and `compareTerminals`' block still ends at `function renderSidebarList() {`. Every insertion this plan makes inside that span — `pickerRendered` at `~:1451`, the picker mount at `~:1610` — is additive and lands outside the assertions, so the block stays green. Do not move the sorts below the parents loop. The `init()` block only asserts the `window.addEventListener('focus', ...)` wiring, which this plan does not touch.
- **`src/test/terminal-sidebar-groupings-contract.test.js` — extend.** All existing markers survive: `renderGroupSidebar() {` → `function renderSidebarList() {` still resolves and still contains `groupsView = false` without `terminalGroups = []`; `renderSidebarList() {` → `function setLayoutMode(` (`:1727`) still spans the whole function and still contains the group-mode branch and `'Show groups'`. Add assertions for:
  - the picker renders from `pickerState` inside `renderSidebarList`, never via `document.getElementById('role-picker')`;
  - the picker is appended to the group container (`parentDiv` / `wtDiv`) and **not** to `.parent-group-items`;
  - the not-rendered clear (`if (pickerState && !pickerRendered)`) appears **after** the parents loop, not inside it;
  - `renderGroupSidebar` offers a `+ New terminal` row and clears a non-`__groups__` key on entry;
  - `onNewTerminalClicked` claims a synchronous in-flight key **before** its `await` and re-checks it **after** — this encodes the interleaving defect the improve pass found, so a later refactor cannot quietly reintroduce it;
  - the picker mount path consumes a one-shot scroll flag rather than scrolling on every render — same reasoning, for the below-the-fold defect.
- **`src/test/multi-parent-terminals-contract.test.js` — no edit.** `:251` pins the call as a prefix regex, so the appended second argument keeps it green. Run it to confirm.
- **`src/test/webview-shim-injection-contract.test.js` — no edit.** No newly referenced `sharedDefaults` binding and the injection marker is untouched; run it as a cheap regression guard on the HTML edits.

## Verification Plan

*Per the session directive, this improve pass ran no compilation and executed no tests. The commands below are the coder's gate, not a record of anything already run.*

### Automated Tests

- `node src/test/terminal-sidebar-groupings-contract.test.js` — must pass with the new assertions above.
- `node src/test/terminal-sidebar-role-ordering-contract.test.js` — must pass **unmodified**; a failure here means a `block()` marker was disturbed, most likely the `renderSidebarList` sorts.
- `node src/test/multi-parent-terminals-contract.test.js` — must pass unmodified.
- `node src/test/webview-shim-injection-contract.test.js` — must pass unmodified.

### Manual — the reported bug

- Open the Terminals panel with two or more workspace mappings configured. Scroll so the second workspace header is near the bottom of the sidebar.
- Click that workspace's `+`. **Expect:** the role menu appears immediately beneath *that* header **and is fully visible without further scrolling** — the list scrolls just enough to reveal it. Nothing appears next to "Agents".
- Pick a role. **Expect:** the terminal spawns in that workspace's directory (check the row's worktree label / `pwd`), the menu closes.

### Manual — re-render survival

- Open the picker and leave it untouched for 15 seconds (three fleet polls, tab focused — `startFleetPoll` skips while the tab is hidden). **Expect:** still open, still under the same header, and **the sidebar scroll position has not moved** since the initial reveal.
- With the picker open, spawn a terminal from another window so `terminalsChanged` fires. **Expect:** the list updates, the picker stays put.

### Manual — toggles, races and edges

- Click the same `+` twice, slowly. **Expect:** open then closed.
- Click the same `+` twice as fast as possible (this exercises the in-flight key). **Expect:** open then closed — not two opens.
- Click `+` on workspace A then immediately on workspace B. **Expect:** the picker ends up on B, never on A.
- Open on workspace A, then click `+` on workspace B (slowly). **Expect:** the picker moves to B (does not merely close).
- Collapse a group, then click its `+`. **Expect:** the group stays collapsed and the picker shows under the header.
- Click `+` on a worktree sub-header. **Expect:** the picker appears under the worktree header and the spawned terminal lands in that worktree.
- Open a worktree picker, collapse its parent workspace, then expand it again. **Expect:** hidden while collapsed, still open when expanded.

### Manual — no dead ends

- Zero terminals running: workspace headers and their `+` are still listed and usable.
- Save a pane group, let the sidebar enter groups view: **Expect** a `+ New terminal` row at the bottom that opens the picker inline and spawns as before.
- Open a picker on a workspace, switch to groups view, then switch back with `Show all terminals`. **Expect:** no picker is open, and the next `+` click opens rather than toggling closed.
- Confirm the empty-state text no longer names a button that does not exist.

---

**Recommendation:** Complexity 5 → **Send to Coder.**

---

## Completion Report

Implemented all proposed changes across `src/webview/terminals.html` and `src/webview/terminals.js`: deleted the `#btn-new-terminal` button, the static `#role-picker` element, and the `.btn-new-terminal` CSS from `terminals.html`; added `.role-picker.is-inline` CSS with a left accent rail; updated the empty-state copy and the solo-mode comment; removed the `btnNew` module-level handle; added `pickerState` / `pickerOpening` / `rolePickerData` / `pickerNeedsScroll` module state; replaced `onNewTerminalClicked` with a state-driven toggle using a synchronous in-flight key; extracted `buildRolePicker()` and `mountRolePicker()` (with one-shot `scrollIntoView`); wired the parent and worktree group `+` handlers to pass group keys and insert the picker between header and items; added the `pickerRendered` flag with a not-rendered clear after the parents loop; added a `+ New terminal` row and non-`__groups__` key clear to `renderGroupSidebar`; and removed the two dead `init()` wirings. Extended `src/test/terminal-sidebar-groupings-contract.test.js` with 8 new assertions. All 9 test suites stay green (126 tests total, 0 failures). No issues encountered.

## Review Findings

Reviewed against this plan with tests executed independently (this dispatch carried no skip directive, so the plan's "no tests were run" note was treated as a record, not an instruction). One MAJOR defect fixed in `src/webview/terminals.js`: `buildRolePicker`'s role and No-role handlers cleared `pickerState` but never re-rendered, so — unlike the static picker's synchronous `picker.hidden = true` — the menu stayed on screen for the whole create round trip (~750 ms for any command-bearing role via `SHELL_READINESS_DELAY_MS`) and until the 5 s fleet poll whenever the create failed, because `createTerminal`'s only re-render sits behind `res.ok`; both handlers now call `renderSidebarList()` before firing the create, and a new assertion in `src/test/terminal-sidebar-groupings-contract.test.js` pins that ordering. The rest verified clean: the orphan grep for `#role-picker` / `#btn-new-terminal` / `btnNew` returns nothing outside comments and the tests themselves, the `pickerOpening` in-flight key and post-await recheck close the interleaving hazard, the not-rendered clear sits after the parents loop with a matching non-`__groups__` clear on entry to `renderGroupSidebar`, and the picker is a sibling of the items container so a collapsed group cannot hide it. Files changed: `src/webview/terminals.js`, `src/test/terminal-sidebar-groupings-contract.test.js`. Validation: sidebar-groupings 24/24, role-ordering 7/7 unmodified, multi-parent 29/29 unmodified, shim-injection 17/17 unmodified, plus open-all-seating 10/10, pane-grid-reconcile, pane-pinning, shell-terminal-strip and pty-route-surface all green; `eslint` clean; the 2 reds in `terminal-pane-fit-verification` are pre-existing at HEAD. Remaining risks are cosmetic and left as-is: `terminals.html:1457` still cites the deleted `#role-picker` as an idiom, the `'__default__'` picker key is now unreachable since every call site passes a real key, and the groups-view `+ New terminal` row remains a non-focusable `<div>` matching its neighbours.
