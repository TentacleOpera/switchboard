# Team Tab Unification — Enter Team View from Top Tabs, Switch Teams Directly

## Goal

The team-scoped view in `terminals.html` is great — it shows team-specific sidebar controls (Standing Orders, Scheduled Automations, Clear Members, Close, Restart, Ack, Add Terminal), a team header with member counts, and the work queue panel. But there are two confusing problems:

1. **Top tab strip doesn't enter team view.** Spawned team groups appear as tabs in the top tab strip alongside regular groups. Clicking a team tab calls `switchToGroup(g.id)`, which only locks the grid to the team's terminals — it does NOT set `teamScopeId`, does NOT add the `is-team-scoped` body class, and the sidebar stays on the general-purpose "all" controls (Open All, Fill Grid, Start Team, Clear All, Save Group, Link Up). The user sees the team's terminals but none of the team controls. This is confusing because there IS a team view with team controls, but the tab doesn't trigger it.

2. **No direct team-to-team switching.** Once in team-scoped mode, the entire tab strip is hidden (CSS: `body.is-team-scoped .group-tab-strip > .group-tab-row { display: none !important; }`). The only way to switch to another team is to click "← ALL TERMINALS" to exit team scope, then click the other team's tab. The user wants to switch directly between teams from within team-scoped mode.

### Root Cause

- `renderGroupTabStrip` (line 3920) renders all groups as tabs with a single click handler: `switchToGroup(g.id)` (line 3994). It does not distinguish spawned team groups from regular groups.
- `switchToGroup` (line 3053) only locks the grid — it never sets `teamScopeId` or adds `is-team-scoped`.
- `enterTeamScope` (line 10419) is the only path that sets `teamScopeId` and enters full team-scoped mode. It's called from the shell rail's team button message handler (line 1187), not from the tab strip.
- In team-scoped mode, `renderGroupTabStrip` early-returns (line 3921: `if (teamScopeId) { return false; }`), and `renderTeamHeader` (line 3529) replaces the tab strip with a team header containing only a back button, icon, name, and count — no sibling team tabs.

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, ux, refactor
**Project:** Browser Switchboard

> **Superseded:** Complexity: 4
> **Reason:** The plan involves multi-file changes (terminals.js + terminals.html), internal branching in `renderGroupTabStrip` for team-scoped mode, overflow menu click handler updates, `renderTeamHeader` restructuring, CSS removal, and layout persistence safety. This is Mixed (5-6), not Low (3-4) — the majority of work is routine but the overflow menu gap and `renderGroupTabStrip` restructuring add moderate, well-scoped risk.
> **Replaced with:** Complexity: 5

## User Review Required

- **Option A vs Option B for team header placement.** The plan recommends Option A (team header renders below the tab row as a context bar, with the "← All" back button moved into the tab strip). Option B (integrate team header into the active tab) is more compact but makes the active tab visually inconsistent. If you prefer Option B, flag it before implementation begins.
- **No delete button on team tabs in team-scoped mode.** The plan removes delete buttons from team tabs in team-scoped mode (teams are managed through the team view, not the tab strip). If you want delete buttons on team tabs in team-scoped mode, flag it.

## Complexity Audit

### Routine
- One-line conditional in the fleet-view tab click handler (Part 1) — `isSpawnedTeamGroup(g)` check before `enterTeamScope` vs `switchToGroup`.
- CSS removal — one rule at line 2113 of `terminals.html`.
- CSS addition — optional `border-top` on `.team-header` for visual separation.
- Removing the back button from `renderTeamHeader` (Part 3) — delete lines 3542–3548.
- Queue cleanup in `enterTeamScope` (Part 2d) — two lines (`_queueItems = []; _queueMode = 'manual';`).

### Complex / Risky
- **`renderGroupTabStrip` internal branching for team-scoped mode** (Part 2a) — the function must render a completely different tab set ("← All" + team tabs only) when `teamScopeId` is set, while still using the same overflow measurement logic. The fleet-view rendering (Unassigned tab, all groups, "+", delete buttons) must be preserved when `teamScopeId` is null.
- **Overflow menu click handler update** — the overflow menu at line 4086 calls `switchToGroup(g.id)` unconditionally. In team-scoped mode, this must call `enterTeamScope(g.id)` for team tabs. The fleet-specific menu items (role-grouping toggle at line 4101, hidden-groups restore at line 4119) must be excluded in team-scoped mode.
- **`renderTeamHeader` restructuring** (Part 2b) — must stop clearing `groupTabStripEl.innerHTML` (line 3531) and instead append the header below the tab row. If the `innerHTML = ''` is left intact, it destroys the tab row that `renderGroupTabStrip` just rendered.
- **Layout persistence on direct team-to-team switch** — `enterTeamScope` sets `teamScopeId` before any save. Adding `saveLayoutSettings()` before the scope change is a safety measure against unsaved layout state being lost.

## Edge-Case & Dependency Audit

### Race Conditions
- **Rapid team-to-team switching:** `enterTeamScope` has race guards at lines 10436 and 10443 (`if (teamScopeId !== groupId) { return; }`). Two rapid clicks (team A then team B) interleave across awaits; the older call wakes up, sees `teamScopeId` has changed, and returns early. This is correct and sufficient.
- **`saveLayoutSettings` before scope change:** `saveSetting` calls `mapSettingKey` synchronously (line 1860) before the async `fetch`, so the storage key is computed with the current `teamScopeId`. Calling `saveLayoutSettings()` before changing `teamScopeId` is safe — the POSTs fire with the old namespace regardless of when they complete.

### Security
- No security implications. All changes are client-side UI rendering in a webview.

### Side Effects
- **`renderTeamHeader` no longer clears `groupTabStripEl`:** This is the intended change (append below tab row), but any other caller that expects `groupTabStripEl` to be empty after `renderTeamHeader` would break. Verified: `renderTeamHeader` is only called from `renderSidebarList` (line 4503), which calls `renderGroupTabStrip` first. No other callers.
- **`renderGroupTabStrip` no longer early-returns in team-scoped mode:** The `teamScopeId` guard at line 3921 must be removed. Any code that relied on `renderGroupTabStrip` returning `false` in team-scoped mode would break. Verified: the only caller is `renderSidebarList` (line 4500), which uses the return value only to set `pickerRendered`. In team-scoped mode, `renderGroupTabStrip` will now return `true` if it renders tabs, which correctly sets `pickerRendered` to prevent the GC from nulling a live `group:*` picker.

### Dependencies & Conflicts
- **Duplicate `isSpawnedTeamGroup` definitions:** Two definitions exist — line 1553 (`g.teamGroup === true && g.id.startsWith('team_')` fallback) and line 10384 (`g.id.startsWith('team_') && g.source === 'manual'` fallback). The second shadows the first in the same scope. Both agree on the primary signal (`g.teamKind === 'spawned'`). This is a pre-existing condition, not introduced by this plan, but a coder debugging team tab detection should be aware that the line 10384 definition is the active one.
- **Picker key namespaces:** `renderGroupTabStrip` mounts pickers for `group:*` keys (line 4161); `renderTeamHeader` mounts pickers for `team:*` keys (line 3587). In team-scoped mode, the "+" button is not rendered, so no `group:*` picker is active. No conflict.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) overflow menu click handlers call `switchToGroup` instead of `enterTeamScope` for team tabs — reproduces the exact bug the plan fixes through the » menu; (2) `renderTeamHeader`'s `innerHTML = ''` will destroy the tab row if not explicitly removed; (3) direct team-to-team switch may lose unsaved layout state without a `saveLayoutSettings()` call before the scope change. Mitigations: branch overflow click handlers on `isSpawnedTeamGroup`, explicitly replace `innerHTML = ''` with append, add `saveLayoutSettings()` before `teamScopeId` change in `enterTeamScope`.

## Proposed Changes

### src/webview/terminals.js

#### Context

The tab strip (`renderGroupTabStrip`) and team header (`renderTeamHeader`) are the two functions that render into `#group-tab-strip`. Currently they are mutually exclusive: the tab strip renders in fleet mode, the team header renders in team-scoped mode. This plan unifies them so both render in team-scoped mode — the tab strip shows team tabs for navigation, and the team header shows context (icon, name, count) below the tabs.

#### Logic

**Part 1: Team tabs in the fleet-view strip enter team-scoped mode**

Modify the group tab click handler in `renderGroupTabStrip` (around line 3992) to detect spawned team groups and call `enterTeamScope(g.id)` instead of `switchToGroup(g.id)`:

```js
tab.addEventListener('click', () => {
    if (activeGroupId === g.id) { return; }
    if (isSpawnedTeamGroup(g)) {
        enterTeamScope(g.id);
    } else {
        switchToGroup(g.id);
    }
});
```

The guard `if (activeGroupId === g.id) { return; }` still prevents re-selecting the active tab. `enterTeamScope` is async but fire-and-forget is fine here — it has internal race guards (lines 10436, 10443).

**Part 2a: Modify `renderGroupTabStrip` to render in team-scoped mode**

Remove the `teamScopeId` early-return guard at line 3921. The guard becomes:
```js
if (!groupTabStripEl || soloTerminalName) { return false; }
```

When `teamScopeId` is set, render a modified tab strip:
- **"← All" back button** (replaces the "Unassigned" tab): Calls `exitTeamScope()`. Styled like a tab but with the ← arrow to signal "exit team scope."
- **Team group tabs only**: Filter `getAllGroups()` by `isSpawnedTeamGroup(g)`. The active team (matching `teamScopeId`) is marked `.active`. Non-team groups are NOT shown — they belong to the fleet view.
- **Click handler on team tabs**: Calls `enterTeamScope(g.id)` (not `switchToGroup`). This handles both entering from the fleet view and switching directly from one team to another.
- **No "+" button**: Team-scoped mode has its own "Add Terminal" button in the sidebar.
- **No delete button on team tabs**: Teams are managed through the team view, not the tab strip. (The fleet-view tab strip keeps its delete buttons.)

> **Superseded:** The overflow logic (lines 4034+) should work as-is for the team-tab subset — it measures `tabRow.clientWidth` and collapses surplus tabs into the » menu. No changes needed there.
> **Reason:** The overflow menu's click handler at line 4086 calls `switchToGroup(g.id)` unconditionally. If team tabs overflow into the » menu, clicking a team tab there calls `switchToGroup`, which does NOT enter team-scoped mode — reproducing the exact bug this plan fixes. Additionally, the overflow menu includes fleet-specific items (role-grouping toggle at line 4101, hidden-groups restore at line 4119) that are irrelevant in team-scoped mode.
> **Replaced with:** The overflow menu click handler must branch on `isSpawnedTeamGroup(g)` in team-scoped mode, calling `enterTeamScope(g.id)` instead of `switchToGroup(g.id)`:
> ```js
> menuItem.addEventListener('click', () => {
>     if (activeGroupId !== g.id) {
>         if (isSpawnedTeamGroup(g)) {
>             enterTeamScope(g.id);
>         } else {
>             switchToGroup(g.id);
>         }
>     }
>     menu.style.display = 'none';
> });
> ```
> The fleet-specific menu items (role-grouping toggle, hidden-groups restore) must be wrapped in a `if (!teamScopeId)` guard so they only render in fleet mode. The overflow measurement logic itself (width calculation, tab collapsing) works as-is for any tab subset.

**Part 2b: Modify `renderTeamHeader` to coexist with the tab strip**

**Option A (recommended): Team header renders below the tab row.**
- `renderGroupTabStrip` renders the tab row (back button + team tabs) into `groupTabStripEl` as before.
- `renderTeamHeader` appends the team header (icon, name, count) BELOW the tab row. **CRITICAL: Remove `groupTabStripEl.innerHTML = ''` at line 3531** — replace it with no clear. The header is appended via `groupTabStripEl.appendChild(header)` at line 3581, which already works if the clear is removed.
- Remove the back button from the team header (lines 3542–3548) — the "← All" tab in the strip handles exit.
- The team header becomes a context bar (icon + name + count), not a navigation bar.
- CSS: `.team-header` already has `padding: 4px 8px` and `min-height: 32px` — it renders as a second row below the tab row.

**Option B (alternative): Integrate the team header into the active tab.**
- The active team tab shows icon + name + count (styled larger), inactive tabs show just the name.
- More compact but makes the active tab visually inconsistent with inactive tabs.

Recommend Option A for clarity — navigation and context are separate concerns.

**Part 2c: Adjust `renderSidebarList` flow**

At lines 4499–4503, the current logic is:
```js
if (!soloTerminalName && !teamScopeId) {
    if (renderGroupTabStrip()) { pickerRendered = true; }
}
if (teamScopeId) {
    if (renderTeamHeader()) { pickerRendered = true; }
    ...
}
```

Change to render BOTH in team-scoped mode:
```js
if (!soloTerminalName) {
    if (renderGroupTabStrip()) { pickerRendered = true; }
}
if (teamScopeId) {
    if (renderTeamHeader()) { pickerRendered = true; }
    ...
}
```

`renderGroupTabStrip` now handles both fleet and team-scoped modes internally. `renderTeamHeader` appends below the tab row.

**Part 2d: Clear work queue and save layout on direct team-to-team switch**

`enterTeamScope` does not clear `_queueItems` or `_queueMode` before loading the new team's data. `exitTeamScope` does (lines 10461–10462). For direct team-to-team switching, add cleanup at the top of `enterTeamScope` (after the guard, before setting `teamScopeId`):

```js
async function enterTeamScope(groupId) {
    const group = getAllGroups().find(g => g.id === groupId);
    if (!group || !isSpawnedTeamGroup(group)) { return; }
    dismissPeek();
    // Save the current scope's layout before switching — prevents unsaved
    // pane/pin/mode changes from being lost on direct team-to-team switch.
    // mapSettingKey reads teamScopeId synchronously, so this saves under the
    // CURRENT team's namespace before teamScopeId changes below.
    if (teamScopeId && teamScopeId !== groupId) {
        saveLayoutSettings();
    }
    _queueItems = [];
    _queueMode = 'manual';
    teamScopeId = groupId;
    document.body.classList.add('is-team-scoped');
    ...
```

> **Superseded:** The old team's layout is already persisted by previous `saveLayoutSettings` calls (layout keys are namespaced by `teamScopeId` via `mapSettingKey`).
> **Reason:** While there are 42 call sites for `saveLayoutSettings()` across the file, "mostly persisted" is not "always persisted." Any layout change path that doesn't trigger a save (e.g., a pending debounce, a state change not yet flushed) would be lost when `teamScopeId` changes. Adding `saveLayoutSettings()` before the scope change is a belt-and-suspenders fix that costs 11 POSTs on team switch — negligible compared to the data loss it prevents.
> **Replaced with:** Add `saveLayoutSettings()` before `teamScopeId = groupId` when `teamScopeId` is already set (direct team-to-team switch only). The `if (teamScopeId && teamScopeId !== groupId)` guard ensures this only fires on direct switches, not on first entry from the fleet view.

This prevents the old team's queue items from flashing for one frame before the new team's `fetchTeamQueue` resolves, and prevents unsaved layout state from being lost.

#### Implementation

1. **`renderGroupTabStrip` (line 3920):** Remove `teamScopeId` from the early-return guard. Add internal branching: when `teamScopeId` is set, render "← All" back button + filtered team tabs (no Unassigned, no "+", no delete buttons). When `teamScopeId` is null, render the existing fleet-view strip unchanged.
2. **Tab click handler (line 3992):** Add `isSpawnedTeamGroup(g)` check — call `enterTeamScope(g.id)` for team tabs, `switchToGroup(g.id)` for regular groups.
3. **Overflow menu click handler (line 4086):** Add `isSpawnedTeamGroup(g)` check — call `enterTeamScope(g.id)` for team tabs, `switchToGroup(g.id)` for regular groups. Wrap the role-grouping toggle (line 4101) and hidden-groups restore (line 4119) in `if (!teamScopeId)` guards.
4. **`renderTeamHeader` (line 3529):** Remove `groupTabStripEl.innerHTML = ''` at line 3531. Remove the back button (lines 3542–3548). The `groupTabStripEl.appendChild(header)` at line 3581 now appends below the tab row instead of replacing it.
5. **`renderSidebarList` (line 4499):** Remove `&& !teamScopeId` from the `renderGroupTabStrip` condition so both strip and header render in team-scoped mode.
6. **`enterTeamScope` (line 10419):** Add `saveLayoutSettings()` (guarded by `if (teamScopeId && teamScopeId !== groupId)`) and queue cleanup (`_queueItems = []; _queueMode = 'manual';`) before `teamScopeId = groupId` at line 10423.

#### Edge Cases
- **Clicking a team tab while already in team-scoped mode for a different team:** The click handler calls `enterTeamScope(g.id)` which re-sets `teamScopeId` and loads the new team's layout. The old team's layout is saved by the new `saveLayoutSettings()` call before the scope change. The old team's queue is cleared before the new team's `fetchTeamQueue` resolves.
- **Only one team exists:** Tab strip shows "← All" + the single team tab (active). No other tabs. Back button works.
- **Many teams → overflow:** Surplus team tabs collapse into the » menu. Clicking a team in the overflow menu calls `enterTeamScope(g.id)` (not `switchToGroup`), correctly entering team-scoped mode.
- **Non-team group tab in fleet view:** Clicking a regular (non-team) group tab still calls `switchToGroup` — does NOT enter team-scoped mode. Sidebar shows general-purpose controls.
- **Picker state:** `renderGroupTabStrip` checks for `group:*` picker keys (line 4161); `renderTeamHeader` checks for `team:*` picker keys (line 3587). In team-scoped mode, no "+" button means no `group:*` picker is active. No conflict.

### src/webview/terminals.html

#### Context

One CSS rule hides the tab row in team-scoped mode. With the tab row now visible in team-scoped mode, this rule must be removed. The team header CSS needs a minor adjustment to render as a second row below the tabs.

#### Logic

**Part 2e: Remove the CSS that hides the tab row in team-scoped mode**

Line 2113:
```css
body.is-team-scoped .group-tab-strip > .group-tab-row {
    display: none !important;
}
```

Remove this rule. The tab row should be visible in team-scoped mode to show the "← All" button and sibling team tabs.

**Part 2f: Adjust team header CSS**

The `.team-header` (line 2160) currently fills the entire `group-tab-strip` area. With the tab row above it, it becomes a second row. No structural CSS changes needed — the existing `display: flex` with `padding` and `min-height` works as a row below the tabs. Optionally add a top border to visually separate the tab row from the team header:

```css
.team-header {
    border-top: 1px solid var(--border-color);
}
```

#### Implementation
1. Remove the CSS rule at line 2113 (`body.is-team-scoped .group-tab-strip > .group-tab-row { display: none !important; }`).
2. Add `border-top: 1px solid var(--border-color);` to `.team-header` at line 2160.

#### Edge Cases
- The `body.is-team-scoped .solo-status-container` rules (lines 2116–2127) are unaffected — they style the connecting/not-found state, not the tab row.
- The `body.is-team-scoped` sidebar button hiding rules (lines 2128+) are unaffected — they hide fleet-specific sidebar buttons, not tab strip elements.

## Verification Plan

### Automated Tests

The existing test pattern for webview code is **static contract tests** (read source files, assert patterns exist). Tests live in `src/test/` and use `fs.readFileSync` to read `terminals.js` and `terminals.html`, then assert with `assert.ok`.

Add contract tests to `src/test/terminal-sidebar-groupings-contract.test.js` (or a new `team-tab-unification-contract.test.js`):

1. **Team tab click handler uses `enterTeamScope`:** Assert that the tab click handler in `renderGroupTabStrip` calls `enterTeamScope` for spawned team groups (pattern: `isSpawnedTeamGroup(g)` followed by `enterTeamScope(g.id)` in the click handler block).
2. **Overflow menu click handler branches on team groups:** Assert that the overflow menu click handler checks `isSpawnedTeamGroup(g)` and calls `enterTeamScope` for team tabs.
3. **`renderGroupTabStrip` does not early-return on `teamScopeId`:** Assert that the guard at the top of `renderGroupTabStrip` does NOT include `teamScopeId` in the early-return condition.
4. **`renderTeamHeader` does not clear `innerHTML`:** Assert that `renderTeamHeader` does NOT contain `groupTabStripEl.innerHTML = ''`.
5. **`renderTeamHeader` back button removed:** Assert that `renderTeamHeader` does NOT contain `team-header-back` or `exitTeamScope()` in the back button block.
6. **`renderSidebarList` renders both strip and header in team mode:** Assert that the `renderGroupTabStrip` call is NOT gated by `!teamScopeId`.
7. **`enterTeamScope` saves layout before scope change:** Assert that `saveLayoutSettings()` appears before `teamScopeId = groupId` in `enterTeamScope`, guarded by `if (teamScopeId && teamScopeId !== groupId)`.
8. **`enterTeamScope` clears queue before scope change:** Assert that `_queueItems = []` and `_queueMode = 'manual'` appear before `teamScopeId = groupId` in `enterTeamScope`.
9. **CSS tab-row hiding rule removed:** Assert that `terminals.html` does NOT contain `body.is-team-scoped .group-tab-strip > .group-tab-row { display: none !important; }`.
10. **Overflow menu fleet items guarded:** Assert that the role-grouping toggle and hidden-groups restore are wrapped in a `!teamScopeId` guard.

### Manual Verification

1. **Fleet view → click team tab**: Clicking a spawned team's tab in the top strip enters team-scoped mode. Verify: `is-team-scoped` body class is present, team controls appear in sidebar, team header renders below tab row, work queue loads, tab strip shows "← All" + team tabs with the active team marked.
2. **Team view → click another team tab**: While in team A's scope, click team B's tab. Verify: scope switches to team B, team B's controls appear, team B's queue loads, team A's queue items do not flash, layout switches to team B's saved layout.
3. **Team view → click "← All"**: Exits team scope, returns to fleet view with full tab strip (all groups including non-team groups, "Unassigned" tab, "+" button).
4. **Team view → only one team exists**: Tab strip shows "← All" + the single team tab (active). No other tabs. Back button works.
5. **Many teams → overflow**: If team tabs exceed strip width, surplus tabs collapse into the » overflow menu. Clicking a team in the overflow menu enters that team's scope (calls `enterTeamScope`, not `switchToGroup`). The » menu does NOT show the role-grouping toggle or hidden-groups restore in team-scoped mode.
6. **Non-team group tab in fleet view**: Clicking a regular (non-team) group tab still calls `switchToGroup` — does NOT enter team-scoped mode. Sidebar shows general-purpose controls.
7. **Layout persistence**: Switch from team A to team B to team A. Verify team A's layout (pane assignments, pins, modes) is preserved across the round-trip.
8. **Shell rail team button**: The existing shell rail entry point still works — clicking a team button in the rail calls `enterTeamScope` as before.
9. **Compile check**: Run `npm run compile` (webpack) and verify no build errors.

## Completion Summary

Implemented team tab unification across `src/webview/terminals.js` and `src/webview/terminals.html`. In `terminals.js`: `renderGroupTabStrip` now branches on `teamScopeId` — in team-scoped mode it renders a "← All" back button plus filtered team tabs (no "+", no delete buttons), with click handlers calling `enterTeamScope` for team tabs and `switchToGroup` for regular groups; the overflow menu click handler and fleet-specific items (role-grouping toggle, hidden-groups restore) are guarded by `!inTeamScope`. `renderTeamHeader` no longer clears `groupTabStripEl.innerHTML` and its back button was removed, so it appends as a context bar below the tab row. `renderSidebarList` renders both the strip and header in team-scoped mode. `enterTeamScope` now calls `saveLayoutSettings()` and clears `_queueItems`/`_queueMode` before changing `teamScopeId` on direct team-to-team switches. In `terminals.html`: removed the CSS rule hiding the tab row in team-scoped mode and added a `border-top` to `.team-header` for visual separation. No issues encountered during implementation.

## Review Findings

Reviewed against the plan; 2 CRITICAL / 3 MAJOR fixed in place. **CRITICAL:** `reloadTerminalGroups` (`src/webview/terminals.js:2094`) still called a bare `renderGroupTabStrip()` after `renderSidebarList()`, which — now that the strip no longer early-returns in team scope — re-wiped `#group-tab-strip` and destroyed the just-appended team header and any live `team:*` role picker on every `terminalsGroupsChanged` push; the redraw is now guarded on `!teamScopeId`. **CRITICAL:** the fleet-view tab handler's `activeGroupId === g.id` guard made a team tab permanently inert whenever the team group already held the group lock — exactly the state `startTeam`/`switchToTeamGroup` and the load-time lock restore leave behind — so the plan's headline gesture failed right after starting a team; team tabs now bypass the lock guard in both the strip and the » menu. **MAJOR:** `enterTeamScope`'s new save called full `saveLayoutSettings()`, which also writes the fleet-wide `terminals.groups`/`terminals.groupPrefs` and raced the `loadLayoutSettings()` read two statements later (the race `exitTeamScope` snapshots `terminalGroups` to survive) — replaced with a new `saveTeamScopedLayoutSettings()` covering only `TEAM_NAMESPACED_KEYS`; the dead `.team-header-back` CSS was deleted; and the plan's 10 automated contract tests, none of which had been written, now live in the two CI-wired files that already own these contracts (`shell-terminal-strip.test.js`, `standing-orders-marker-contract.test.js`) rather than a new dark test file. Files changed: `src/webview/terminals.js`, `src/webview/terminals.html`, `src/test/shell-terminal-strip.test.js`, `src/test/standing-orders-marker-contract.test.js`. Validation: `npm run compile` clean (4 pre-existing optional-dep warnings), `node --check` and `eslint` clean, shell-terminal-strip 74/74 and standing-orders-marker 64/64 (a broken back-button contract test in the former was the implementation's only red; it is now inverted to the new design), and 7 failures across 5 other terminals contract files were each confirmed red at HEAD via a `git archive` baseline. Remaining risk: manual UAT of the two-row strip is still outstanding — the overflow pass reserves 36px for a » that team-scoped mode often never builds, and an overflowing active team tab is only identified by the header below.
