# Team Cockpit: A `?team=<id>` Scoped Terminals View

## Goal
Open a dedicated Terminals view for one team: the sidebar lists only that team's terminals, only that team's terminals are seated in the grid, and the header carries the team's icon and name. Reached by clicking the team's icon in the shell rail. The general-purpose panel stays exactly as it is; this is a second, focused mode of the same page.

### The problem, and the root cause
`terminals.html` is a whole-fleet cockpit and its sidebar is organised by **place**, not by team. `renderSidebarList` (`src/webview/terminals.js:3287`) buckets every terminal into a workspace → worktree → terminal tree, and teams appear nowhere in it. A team's only representation is a tab in the group strip above the pane grid (`renderGroupTabStrip`, `terminals.js:3000`) — and that strip is a *seating* control: switching tabs re-seats panes. It is not a place to manage a team.

The result is that working with one team means reading a tree organised around something else, hunting its members out of a mixed list, and doing every team-wide action one terminal at a time. On a busy fleet the team the operator is thinking about is scattered across three collapsed groups.

### The precedent to follow
The page already supports a scoped mode. `?solo=<name>` (parsed at `terminals.js:158`) renders exactly one terminal: `init()` sets `is-solo` on the body, forces layout `1`, pins `paneAssignments`, and marks the initial assignment done (`terminals.js:724`–`731`). CSS at `terminals.html:1921` hides the sidebar, toolbar, banner and group strip wholesale. `shell.js:731` opens it via `window.open('/terminals?solo=…', 'sb-term-<slug>')`.

`?team=<groupId>` is the same shape one level up: a filter over the fleet rather than a single pinned terminal. Follow the solo pattern's structure; do **not** follow it into hiding the sidebar, because the sidebar is the point here.

### The constraint that shapes the design
Solo mode makes `saveSetting` a no-op (`terminals.js:1491`) — deliberately. The panel's layout state lives in **flat, shared** config keys: `terminals.paneAssignments`, `terminals.layoutMode`, `terminals.collapsedGroups`, `terminals.pinnedPanes`, `terminals.paneModes` (read together in `loadLayoutSettings`, `terminals.js:1512`). A second window writing those keys would overwrite the main cockpit's layout with the team view's — a scoped window silently rearranging the operator's main grid. Team mode therefore must either suppress writes like solo does, or namespace them. This plan namespaces, because a team cockpit the operator arranges and returns to is worth far more than one that resets every open.

## Metadata
- **Complexity:** 7
- **Tags:** frontend, ui, ux, feature
- **Project:** browser-switchboard
- **Feature:** 72bda17f-bb0c-4ad9-b9b9-55c19fc9cba7

## User Review Required
No user review required — the `scopedFleet()` filter-at-render-boundary design and the namespaced persistence strategy are fully specified.

## Complexity Audit

### Routine
- Parsing `?team=<groupId>` from URL params (mirrors the existing `?solo=<name>` parse at `terminals.js:158`).
- Hiding the group strip in team mode (extending the existing solo early-return at `terminals.js:3001`).
- Rendering a team header (icon, name, member count) in place of the layout toolbar.

### Complex / Risky
- The `scopedFleet()` accessor — must filter at the render boundary only, never at fetch time. Several code paths need the whole fleet even in a scoped window (standing-orders resolver, stale-slot drop loop, dispatch-in-flight cleanup). A truncated `fleetList` would make those quietly wrong.
- The namespaced persistence (`terminals.team.<groupId>.<key>`) — creates a storage leak. Namespaced layout keys are never cleaned up when a team's group record is deleted. Hook cleanup into the group-record deletion path (`terminals.js:3060`).
- The `+` picker re-home from `group:*` to `team:<id>` — the GC at `renderSidebarList` must handle `team:<id>` keys, not just `group:*`. Verify the GC is key-agnostic before relying on "the fix is the same."

## Edge-Case & Dependency Audit
- **Race Conditions:** Two windows open on the same team both write the same namespaced keys — last-write-wins. On a non-focused window's next poll-driven re-render, its layout flips to the other window's setting without the operator touching it. Acceptable (the main panel has the same property across pop-outs today) but document the symptom.
- **Security:** No new attack surface. The `teamScopeId` is parsed from the URL and used to filter render paths. It is never interpolated into a filesystem path or DB query — it is only matched against `terminals.groups` records in memory.
- **Side Effects:** Namespaced layout keys accumulate in the DB config blob. Without cleanup on group deletion, orphaned keys persist indefinitely. Hook deletion into the tab-strip `×` handler at `terminals.js:3060`.
- **Dependencies & Conflicts:** Depends on team identity foundation (`definitionId` / `head` / `teamKind` / `isSpawnedTeamGroup`) and team icon picker (header icon). The shell strip's `popoutTeam` message is the click entry point, but this plan can be built and tested by navigating to the URL directly. `applyStandingOrdersClient` (`terminals.js:8822`) must receive the unfiltered fleet, not `scopedFleet()` — this is the concrete bug that "filter at the render boundary" prevents.

## Adversarial Synthesis
Key risks: (1) namespaced layout keys create a storage leak — orphaned keys accumulate when team group records are deleted without cleanup; (2) the picker GC may not handle `team:<id>` keys, leaving a live picker invisible to garbage collection; (3) two windows on the same team race on namespaced keys, causing a non-focused window's layout to flip on the next poll. Mitigations: hook namespaced-key cleanup into the group-record deletion path; verify the GC is key-agnostic; document the two-window race symptom.

## Proposed Changes

### `src/webview/terminals.js`
- **Context:** The page supports `?solo=<name>` scoped mode (parse at line 158, `init()` at lines 724–731, CSS at `terminals.html:1921`). Team mode is the same shape one level up — a filter over the fleet rather than a single pinned terminal.
- **Logic:** Parse `?team=<groupId>` beside the solo parse. Add `scopedFleet()` accessor returning `fleetList` filtered to the team's `members` when `teamScopeId` is set, and `fleetList` unchanged otherwise. Route `renderSidebarList`, seating passes, `renderGroupTabStrip`, and the empty-state decision through it. Add namespaced persistence: when `teamScopeId` is set, read/write `terminals.team.<groupId>.<key>` for the layout family only. Hide the group strip (extend the solo early-return at line 3001). Re-home the `+` picker to `team:<id>`.
- **Edge Cases:** Do not filter `fleetList` itself at fetch time. `applyStandingOrdersClient` (line 8822) must receive the unfiltered fleet. Hook namespaced-key cleanup into the group-record deletion path at line 3060. Verify the picker GC handles `team:<id>` keys. `switchToGroup` at line 2566 must guard against a team-scoped window silently becoming unscoped.

### `src/webview/terminals.html`
- **Context:** CSS at line 1921 hides the sidebar, toolbar, banner and group strip for solo mode. Team mode needs the sidebar visible.
- **Logic:** Add `is-team-scoped` body class styles. Show the sidebar (unlike solo). Hide the group strip. Add a team header area where the layout toolbar sits in the full panel.
- **Edge Cases:** The team header must accommodate the team-verb controls the action-bar plan adds. Keep the layout picker — choosing a grid for a four-member team is the first thing an operator will want.

## Dependencies
- **Team identity foundation** — `definitionId` / `head` / `teamKind`, and `isSpawnedTeamGroup`.
- **Team icon picker** — for the header identity and the rail button.
- **Shell strip team icons** — supplies the `popoutTeam` message and the click entry point. This plan can be built and tested by navigating to the URL directly, so it does not hard-block on the strip work landing first.

## Approach

### 1. Parse and establish the mode
Beside the `solo` parse at `terminals.js:158`:
```js
if (urlParams.has('team')) { teamScopeId = urlParams.get('team'); }
```
`teamScopeId` and `soloTerminalName` are mutually exclusive — if both are present, solo wins (it is the narrower scope) and the team param is ignored.

In `init()`, when `teamScopeId` is set: add `is-team-scoped` to the body, set `document.title` to the team name, and resolve the team record from `terminals.groups` by `groupId`. Everything else follows from the filter below rather than from pinned assignments, because a team has many members and the operator still chooses a layout among them.

### 2. One filter, applied at the source
Introduce a single accessor — `scopedFleet()` — returning `fleetList` filtered to the team's `members` when `teamScopeId` is set, and `fleetList` unchanged otherwise. Route the render paths through it: `renderSidebarList` (`terminals.js:3287`), the seating passes, `renderGroupTabStrip`, and the empty-state decision.

Do **not** filter `fleetList` itself at fetch time. Several code paths legitimately need the whole fleet even in a scoped window — the standing-orders client resolver checks liveness across the fleet (`applyStandingOrdersClient`, `terminals.js:8822`), the stale-slot drop loop at `terminals.js:1990` reconciles against every live name, and the dispatch-in-flight cleanup at `terminals.js:2004` does the same. A truncated `fleetList` would make those quietly wrong: orders resolving against a partial fleet, and pins/slots for non-member terminals never expiring. Filter at the render boundary, keep the model whole.

### 3. Sidebar in team mode
Keep the workspace → worktree hierarchy *inside* the team when the team spans locations — it is real information and the tree code already handles it. But:
- Render a team header at the top: icon, name, `N active / M exited`, and the head marked as head (this is what `head` on the group record is for).
- Order members by the group's `order` array, not by `compareTerminals` (`terminals.js:3253`). The operator authored that order; a scoped view is exactly where it should be honoured.
- Suppress the selection/grouping affordances (`group` / `clear` at `terminals.js:3317`) — saving a sub-selection of one team as another manual group from inside a team window is a confusing action with no clear use.
- Keep the per-row controls: rename, clear, close, peek. Those are per-terminal and still wanted.
- Keep the per-group `+` spawn button, scoped to the team's workspace, so an operator can add a terminal without leaving.

### 4. Group strip in team mode
Hide it. Its whole purpose is switching *between* groups, and this window is locked to one. `renderGroupTabStrip` already early-returns for solo (`terminals.js:3001`) — extend that guard to team mode.

This removes the `group:*` picker mount point, which the `+` button relies on for its pickerState key (`terminals.js:3075`). Re-home the picker to the team header's `+` with a `team:<id>` key so the picker still survives a fleet poll — the wipe hazard described at `terminals.js:3287` (`listEl.innerHTML = ''` on every poll) applies identically here, and the fix is the same: mount outside `listEl`, and report `pickerRendered` so the garbage-collect at the bottom of `renderSidebarList` does not null a live picker.

### 5. Namespaced persistence
Add a key-prefixing step inside `loadSetting`/`saveSetting`: when `teamScopeId` is set, read and write `terminals.team.<groupId>.<key>` instead of `terminals.<key>`, for the layout family only (`layoutMode`, `paneAssignments`, `pinnedPanes`, `paneModes`, `collapsedGroups`).

Explicitly **not** namespaced, and explicitly still shared: `terminals.groups`, `terminals.agentGroups`, `terminals.standingOrders`, `terminals.groupPrefs`. Those are fleet-wide truth, not per-window layout. A team window that forked the group roster would drift from the main cockpit, and the team-scoped standing orders it edits must be the same ones the fleet applies.

Leave `saveSetting`'s solo early-return exactly as it is. Solo stays write-suppressed; only team mode namespaces.

### 6. Header identity
Give the team window a compact header (where the layout toolbar sits in the full panel): team icon, team name, member count, and room for the team-verb controls the companion plan adds. Keep the layout picker — choosing a grid for a four-member team is the first thing an operator will want, and the team's stored layout (`layoutForTeamSize`, `teamWiring.ts:110`) is only a starting guess.

### 7. Lifecycle
- **Team's terminals all exit.** Show an empty state naming the team, with a restart affordance, rather than the generic "no terminals" panel state.
- **Group deleted while the window is open** (the tab-strip `×` in the main cockpit deletes group records, `terminals.js:3060`). The window must not go blank and silent: show a clear "this team is no longer registered" state, keep the terminals reachable, and offer a link back to the full cockpit.
- **`switchToGroup` clears solo mode** at `terminals.js:2566` by stripping `is-solo`. Nothing in team mode should reach that path once the strip is hidden — but guard it anyway: a team-scoped window must never silently become an unscoped one, because its namespaced layout keys would then be writing under the wrong prefix.

## Edge cases
- **`?team=` naming a group that does not exist** (stale bookmark, deleted team). Render the not-found state, modelled on `checkSoloNotFound` (`terminals.js:1752`), which already handles the analogous case for a dead solo terminal — including painting it *before* the first fetch resolves so a slow fetch does not leave a blank window.
- **`?team=` naming a non-team group** (a derived role group, a hand-saved selection). Accept it as a plain filter but do not draw team-specific chrome that cannot resolve — check `isSpawnedTeamGroup` and degrade to a generic "group view" header. Do not 404 a legitimate group.
- **Membership changes under the window.** A re-spawn upserts `members` (`teamWiring.ts:1052`), so a team window can gain or lose rows live. Re-read the group each poll rather than caching membership at open, and reconcile seats the same way the main panel reconciles stale slots.
- **Two windows open on the same team.** Both write the same namespaced keys and will race, last-write-wins. Acceptable — the main panel has the same property across pop-outs today. Do not add locking.
- **Standing-orders client mirror.** `applyStandingOrdersClient` needs `liveNameSet()` over the *whole* fleet (`terminals.js:4431`). Confirm it takes the unfiltered set, not `scopedFleet()` — this is the concrete bug that "filter at the render boundary" prevents.
- **`postFleetStateToShell` from a team window.** A pop-out has no shell parent (`window.parent === window`, guarded at `terminals.js:1346`), so it will not push fleet state and cannot fight the main panel's pushes. Confirm this holds when the team view is opened as a pop-out *and* if it is ever hosted in an iframe.

## Verification Plan
1. `npm run compile` — clean.
2. Unit: `scopedFleet()` filters to `members` in team mode, returns the full list otherwise, and tolerates a group whose `members` names a terminal that is no longer live.
3. Unit: the settings key mapper — layout-family keys get the `terminals.team.<id>.` prefix in team mode; `terminals.groups` / `.agentGroups` / `.standingOrders` / `.groupPrefs` do **not**; nothing is prefixed outside team mode; solo still writes nothing.
4. **Isolation test, the one that matters:** arrange the main cockpit in `2x3` with specific pane assignments. Open a team window, set it to `2x2`, rearrange it, close it. Reopen the main cockpit and confirm its layout and assignments are byte-identical to before. Then reopen the team window and confirm *its* layout persisted separately.
5. Unit: `renderGroupTabStrip` returns false in team mode; the `+` picker mounts under a `team:<id>` key and survives a simulated fleet poll (the `listEl.innerHTML = ''` wipe).
6. Manual, installed VSIX: start a 4-member team. Open `/terminals?team=<groupId>` directly. Sidebar shows exactly the 4 members in `order`, head marked, no other terminals, no group strip. Grid seats only members.
7. Manual: from the same team window, spawn a terminal via the team `+`. It joins the view and the main cockpit both.
8. Manual: rename a member from the team window; confirm the name updates in the main cockpit and that team-scoped standing orders still resolve to it (`rewriteStandingOrdersForRename`).
9. Manual: `?team=does-not-exist` → not-found state, no blank window, no console spew. `?team=<a derived role group id>` → generic group view, no broken team chrome.
10. Manual: `?team=X&solo=Y` → solo wins, one terminal, no team chrome.
11. Manual: delete the team's group record from the main cockpit while the team window is open — the window explains itself rather than going blank.
12. Regression: open the plain `/terminals` panel and confirm nothing about it changed — sidebar tree, group strip, layout persistence, solo pop-outs.
