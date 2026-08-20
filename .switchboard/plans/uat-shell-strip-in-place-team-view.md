# UAT Remediation: Shell Strip & In-Place Team View

## Goal

Fix six UAT failures in the shell strip and one in the team-scoped sidebar. The shell strip was supposed to become a roster of team icons — one button per team wearing the team's icon, clicking opens the team view in the main panel. What shipped has a mode toggle, wrong icons, member counts, verbose tooltips, pop-out windows, and ungrouped terminals rendered as teams. The team-scoped sidebar shows generic fleet buttons that should be hidden.

### The problem, and the root cause

The shell strip plan (`shell-strip-team-icons-instead-of-per-terminal-cli-icons.md`) was implemented with five deviations from the user's intent:

1. **A rail mode toggle was added** (plan step 5, `ensureRailModeToggle`). The plan's title says "in place of" — the user wanted a hard replacement, not a toggle. The toggle button clutters the rail and introduces a mode the user never asked for.
2. **Team icons resolve to CLI brand marks** — the three-deep fallback chain (team icon → head's brand mark → role letter) is hitting the brand mark arm. Either the `icon` field is not populated on the team definitions, `resolveArtForShell` is failing, or the fallback fires too eagerly. The rail shows CLI brand marks instead of team icons.
3. **Ungrouped terminals render as individual team buttons** — the grouping logic (`isSpawnedTeamGroup`) or the rendering branch is misclassifying ungrouped terminals, wrapping them in team-button styling instead of per-terminal buttons.
4. **A member-count badge appears beside each icon** (`.strip-team-count`, plan step 3). The user does not want it.
5. **The tooltip shows members and roster lines** (plan step 3, `aria-label` + roster). The user wants just the team name.
6. **Clicking a team icon pops out a new window** (`popoutTeam` → `window.open('/terminals?team=<groupId>')`). The user wants the main terminals panel to switch to team-scoped mode in-place, with a visible way back to the full fleet.

Additionally, the team-scoped sidebar (failure 9):

7. **Generic fleet buttons are still visible in team-scoped mode.** The `is-team-scoped` CSS (`terminals.html:2130`) only hides the group tab strip row. It does NOT hide the general-purpose sidebar buttons: OPEN AGENT TERMINALS, START TEAM, LINK UP. The cockpit plan said to "suppress selection/grouping affordances" but the implementation didn't hide them. The team-scoped sidebar should show only the team's members and team-relevant controls.

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, ux, bugfix, refactor
**Project:** Browser Switchboard

## User Review Required

Yes — the in-place navigation design (how the user gets back to the full fleet) needs confirmation. The approach below uses a breadcrumb/back button in the team header.

## Complexity Audit

### Routine
- Deleting `ensureRailModeToggle` and its call site (shell.js:1056–1085, call at :748) — mechanical removal.
- Deleting the `#strip-rail-mode` CSS (shell.html:444–449) — mechanical removal.
- Deleting the `.strip-team-count` badge element and CSS (shell.js:826–829, shell.html:414+) — mechanical removal.
- Simplifying the tooltip text (shell.js:792–797) — string change.
- Adding `body.is-team-scoped` CSS rules to hide `#btn-open-all`, `#btn-start-team`, `#start-team-form`, `#btn-link-up` (terminals.html:2130+) — CSS additions.
- Removing the `railMode` variable and `sb-rail-mode` localStorage (shell.js:599–603) — mechanical removal.

### Complex / Risky
- **Icon fallback chain fix (failure 2):** Requires coordinated changes in two files — `buildTeamsForShell` (terminals.js:1668–1677) must stop falling back to the head's brand mark, and the shell's `renderTerminalSection` (shell.js:799–821) must skip the brand-mark arm and go straight to the role letter. Getting either side wrong leaves the rail showing the wrong icon.
- **In-place team navigation (failure 6):** Requires a new `switchToTeam` message handler in terminals.js, a new `enterTeamScope` / `exitTeamScope` state-transition function, a back button in `renderTeamHeader`, and replacement of the `window.open` click handler in shell.js. The `switchToGroup` guard at terminals.js:3067 (`if (teamScopeId && id !== teamScopeId) { return; }`) means `teamScopeId` must be set BEFORE calling `switchToGroup` when entering scope. This is the highest-risk change — a state-management bug here could leave the panel stuck in team scope or break seating.
- **Removing the `popoutTeam` message handler** (shell.js:1256–1278) — must confirm no other code path still sends `popoutTeam` messages.

## Edge-Case & Dependency Audit

**Race Conditions:**
- The fleet poll (5s interval) calls `postFleetStateToShell` → `renderTerminalSection` rebuilds every button. If the user clicks a team icon mid-rebuild, the click handler captures the `team` object from the closure — this is safe because the rebuild creates new buttons, it does not mutate the old ones.
- Entering team scope sets `teamScopeId` then calls `switchToGroup`. If a fleet poll arrives between setting `teamScopeId` and `switchToGroup` completing, `scopedFleet()` will already filter to the team's members — this is correct, not a race; the seating just hasn't happened yet and will complete on the next `renderPaneGrid`.

**Security:**
- The new `switchToTeam` message handler in terminals.js must check `event.origin === location.origin` — same guard as every other message handler (e.g. `peekTerminal` at terminals.js:1182, `clearTeamBadges` at :1168).

**Side Effects:**
- Removing `ensureRailModeToggle` makes the `sb-rail-mode` localStorage key inert. The key may still exist on existing installs — it is simply never read. No migration needed (it is a UI preference, not user data).
- Entering team scope in-place does NOT change the URL. A page reload returns to the full fleet. This is acceptable — the team view is a transient navigation. If bookmarkability is needed later, `history.replaceState` can add the `?team=` param without a reload.
- The `popoutTeam` message handler in shell.js (lines 1256–1278) becomes dead code once the click handler stops sending `popoutTeam` messages. It should be removed for cleanliness, but leaving it is harmless (it just never fires).

**Dependencies & Conflicts:**
- **Plan B (action bar relocation) depends on this plan's sidebar cleanup.** This plan hides `#btn-open-all`, `#btn-start-team`, `#start-team-form`, `#btn-link-up` via `body.is-team-scoped` CSS. Plan B moves the action bar buttons into that same sidebar area. If Plan B lands first, the action bar would compete with the generic buttons for sidebar space.
- The `#btn-team-orders` and `#btn-team-automations` buttons (terminals.html:2430–2433) are already hidden by default and shown only when `teamScopeId` is set (terminals.js:4442–4445). These are team-relevant and should stay visible in team-scoped mode — they must NOT be hidden by the new CSS rules.
- The `#btn-fill-grid`, `#btn-clear-all`, `#btn-save-group` buttons (terminals.html:2402–2427) are fleet-wide controls. They should also be hidden in team-scoped mode (they are irrelevant to a single team's view). Add them to the CSS hide list.

## Dependencies

- **Plan B** (`uat-remove-pacing-toggle-relocate-action-bar.md`) — must land AFTER this plan. This plan's sidebar CSS cleanup creates the space Plan B fills with action bar buttons.

## Adversarial Synthesis

Key risks: the icon fallback chain fix requires coordinated two-file changes (stop brand-mark fallback in `buildTeamsForShell`, skip brand-mark arm in shell); the in-place navigation introduces new state-transition functions (`enterTeamScope`/`exitTeamScope`) that must correctly sequence `teamScopeId` assignment before `switchToGroup` to avoid the guard at terminals.js:3067; the `popoutTeam` handler removal must verify no remaining senders. Mitigations: the icon fix is a deletion of fallback code (not new logic), the state transition mirrors the existing `init()` path at terminals.js:772–782, and `popoutTeam` has exactly one sender (the click handler being replaced).

## Proposed Changes

### 1. Remove the rail mode toggle (failure 1)
**File:** `src/webview/shell.js`
**Change:** Delete `ensureRailModeToggle` (lines 1056–1085) and its call site (line 748). Delete the `railMode` variable and its localStorage read (lines 599–603). Remove the `if (railMode === 'teams' && ...)` branching at line 752 — teams mode is the only mode; the `else` branch (terminals mode, lines 896–901) is dead code and should be removed. The `terminals` array is still sent by the panel for backward compatibility but the shell no longer renders a per-terminal-only rail. The `updateRailModeIcon` function (lines 1086–1098) is also dead code — remove it.

**File:** `src/webview/shell.html`
**Change:** Delete the `.strip-rail-mode-btn` CSS (lines 444–449).

### 2. Fix team icon resolution (failure 2)
**File:** `src/webview/terminals.js` (`buildTeamsForShell`, lines 1668–1677)
**Change:** The current code falls back from no-team-icon to the head's brand mark:
```js
let resolvedIconUri = iconUri;
if (!resolvedIconUri && fleetByFriendly.has(headName)) {
    const headAgentLabel = agentLabelForRole(fleetByFriendly.get(headName).role);
    const headIconKey = brandIconForCliLabel(headAgentLabel) || 'default';
    resolvedIconUri = brandIconUri(headIconKey) || brandIconUri('default');
}
```
This is the root cause: a team with no icon gets the head's CLI brand mark, which communicates "which CLI" not "which team." Delete this fallback block entirely. Send `iconUri: iconUri || ''` (just the team icon, or empty string). The shell will handle the empty-string case.

**File:** `src/webview/shell.js` (`renderTerminalSection`, lines 799–821)
**Change:** The current three-deep fallback in the shell also falls back to the head's brand mark:
```js
if (team.iconUri) {
    // ... team icon <img>
} else {
    const headTerm = terminals.find(t => t.name === team.head);
    const roleChar = (team.headRole || (headTerm && headTerm.role) || 'T').charAt(0).toUpperCase();
    if (headTerm && headTerm.iconUri) {
        // ... head's brand mark <img>  ← THIS ARM IS WRONG
    } else {
        // ... role letter glyph
    }
}
```
Delete the `headTerm.iconUri` arm (lines 811–816). When `team.iconUri` is empty, go straight to the role letter glyph. The desired behaviour: a team with an icon shows that icon; a team with no icon shows the role portrait (the role letter), not the CLI brand mark.

### 3. Fix ungrouped terminal rendering (failure 3)
**File:** `src/webview/shell.js` (`renderTerminalSection`, lines 757–894)
**Change:** The `claimedNames` set is built from `team.memberNames` (lines 757–762). Terminals not in `claimedNames` are rendered via `buildTerminalButton` (line 893) — this is correct. The issue is that `isSpawnedTeamGroup` (terminals.js:1546–1551) may be misclassifying groups. Verify that only groups with `teamKind === 'spawned'` OR (`teamGroup === true` AND `team_`-prefixed id) become team buttons. A manual selection group or a derived role/worktree group should NOT appear as a team button. If the `teams` array from `buildTeamsForShell` is correctly filtered, ungrouped terminals will already render as `.strip-term-btn` via `buildTerminalButton`. The fix is verification, not a code change — unless `isSpawnedTeamGroup` is found to be too permissive.

### 4. Remove the member-count badge (failure 4)
**File:** `src/webview/shell.js` (`renderTerminalSection`, lines 824–829)
**Change:** Delete the badge creation code:
```js
const badge = document.createElement('span');
badge.className = 'strip-team-count';
badge.textContent = String(memberCount);
btn.appendChild(badge);
```

**File:** `src/webview/shell.html`
**Change:** Delete the `.strip-team-count` CSS (lines 414+).

### 5. Simplify the tooltip (failure 5)
**File:** `src/webview/shell.js` (`renderTerminalSection`, lines 791–797)
**Change:** Replace the verbose label and roster tooltip with just the team name:
```js
btn.setAttribute('aria-label', team.name);
btn.dataset.tooltip = team.name;
```
Delete the `labelText` construction (line 792) and the `roster` construction (lines 796–797).

### 6. In-place team navigation instead of pop-out (failure 6)
**File:** `src/webview/shell.js` (`renderTerminalSection`, team click handler, lines 842–883)
**Change:** Replace the `window.open` popout with a `postMessage` to the terminals panel. Keep the `clearTeamBadges` relay (lines 848–855) — it stays. Replace the popout block (lines 856–882) with:
```js
selectPanel('terminals');
const termFrame = frames.get('terminals');
if (termFrame && termFrame.contentWindow) {
    try {
        termFrame.contentWindow.postMessage({
            type: 'switchToTeam',
            groupId: team.groupId
        }, location.origin);
    } catch { /* ignore */ }
}
```
The `selectPanel('terminals')` call (shell.js:130) brings the terminals panel to the front in the shell layout. The `postMessage` tells the terminals panel to enter team-scoped mode.

**File:** `src/webview/shell.js` (message handler, lines 1256–1278)
**Change:** Remove the `popoutTeam` message handler block — it is now dead code (the click handler no longer sends `popoutTeam` messages). Verify no other code path sends `popoutTeam` by grepping for `type: 'popoutTeam'` across the webview files.

**File:** `src/webview/terminals.js` (message handler section, near line 1163)
**Change:** Add a new message handler for `switchToTeam`:
```js
} else if (message.type === 'switchToTeam' && typeof message.groupId === 'string') {
    if (event.origin !== location.origin) { return; }
    enterTeamScope(message.groupId);
}
```

**File:** `src/webview/terminals.js` (new function, near the team-scoped helpers at line 10428)
**Change:** Add `enterTeamScope` and `exitTeamScope` functions:
```js
function enterTeamScope(groupId) {
    const group = getAllGroups().find(g => g.id === groupId);
    if (!group || !isSpawnedTeamGroup(group)) { return; }
    dismissPeek();
    teamScopeId = groupId;
    document.body.classList.add('is-team-scoped');
    document.title = group.shortName || group.name || 'Team';
    switchToGroup(groupId);  // seats the team's members into panes
    renderSidebarList();
    renderPaneGrid();
}

function exitTeamScope() {
    teamScopeId = null;
    document.body.classList.remove('is-team-scoped');
    document.title = 'Terminals';
    activeGroupId = null;
    activeGroupPage = 0;
    setLayoutMode(layoutForFleetCount(fleetList.length));
    seatActiveGroupPage();
    renderSidebarList();
    renderPaneGrid();
}
```
Note: `switchToGroup` has a guard at line 3067 (`if (teamScopeId && id !== teamScopeId) { return; }`). Setting `teamScopeId` BEFORE calling `switchToGroup` ensures the guard passes (since `id === teamScopeId`). This mirrors the `init()` path at lines 772–782 which sets `teamScopeId` then relies on `loadLayoutSettings` to set `activeGroupId`.

**File:** `src/webview/terminals.js` (`renderTeamHeader`, near line 3532)
**Change:** Add a back button at the start of the team header, before the icon area:
```js
const backBtn = document.createElement('button');
backBtn.type = 'button';
backBtn.className = 'team-header-back';
backBtn.textContent = '← ALL TERMINALS';
backBtn.title = 'Return to the full fleet view';
backBtn.addEventListener('click', () => exitTeamScope());
header.appendChild(backBtn);
```

**File:** `src/webview/terminals.html`
**Change:** Add CSS for `.team-header-back`:
```css
.team-header-back {
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    padding: 2px 8px;
    border-radius: 3px;
    white-space: nowrap;
}
.team-header-back:hover {
    color: var(--text-primary);
    background: rgba(255, 255, 255, 0.08);
}
```

### 7. Hide generic sidebar buttons in team-scoped mode (failure 9)
**File:** `src/webview/terminals.html` (after the existing `body.is-team-scoped` rules at line 2130)
**Change:** Add CSS rules to hide the general-purpose sidebar buttons:
```css
body.is-team-scoped #btn-open-all,
body.is-team-scoped #btn-fill-grid,
body.is-team-scoped #fill-grid-form,
body.is-team-scoped #btn-start-team,
body.is-team-scoped #start-team-form,
body.is-team-scoped #btn-clear-all,
body.is-team-scoped #btn-save-group,
body.is-team-scoped #btn-link-up {
    display: none !important;
}
```
The team-relevant controls (`#btn-team-orders`, `#btn-team-automations`) are already shown/hidden by `renderSidebarList` based on `teamScopeId` (terminals.js:4442–4445) — they stay visible. The sidebar below shows only the team's members in `order` sequence. The workspace/worktree hierarchy stays (per the cockpit plan) but only for the team's terminals.

## Edge Cases

- **Team with no icon:** Show the role portrait SVG (role letter), not the CLI brand mark. The brand mark is the wrong fallback for a team button.
- **All terminals ungrouped:** The rail shows only per-terminal buttons. No team buttons. This is the correct state when no teams are spawned.
- **Team-scoped mode entered in-place:** The URL does not change (no `?team=` param). The `teamScopeId` is set in memory. A page reload returns to the full fleet. This is acceptable — the team view is a transient navigation, not a bookmarkable URL. If bookmarkability is needed later, the URL can be updated with `history.replaceState` without a page reload.
- **Back button:** Must clear `teamScopeId`, remove `is-team-scoped` body class, clear `activeGroupId`, reset layout to fleet-count-appropriate, and re-render the full fleet. The `exitTeamScope` function handles all of these.
- **Shell strip when terminals panel is not visible:** `renderTerminalSection` already removes the container when `frames.has('terminals')` is false. No change needed.
- **Entering team scope when already in team scope:** The `switchToGroup` guard at line 3067 prevents switching to a different team. If the user clicks the same team's icon again, `enterTeamScope` will call `switchToGroup(groupId)` with `id === teamScopeId` — the guard passes, and `switchToGroup` re-seats the same group (harmless).
- **Pop-out windows already open:** Existing pop-out windows (from before this fix) remain open and functional. They were opened with `?team=<groupId>` URLs and are self-contained. No cleanup needed.

## Verification Plan

### Automated Tests
- `src/test/shell-terminal-strip.test.js` — update: remove toggle tests, remove member-count assertions, simplify tooltip assertions, verify ungrouped terminals render as `.strip-term-btn` not `.strip-team-btn`. Add assertions that the `switchToTeam` message is posted (not `window.open`).

### Manual Verification
1. `npm run compile` — clean. *(Skipped this run per session directive — checks remain written down.)*
2. Manual, installed VSIX: start two teams plus one loose terminal. Rail shows two team icons (the team's chosen icons, not CLI brand marks) and one per-terminal button. No toggle button. No member counts. Hover a team — tooltip shows only the team name.
3. Manual: click a team icon — the main terminals panel switches to team-scoped mode (only that team's terminals in sidebar and grid). No new window opens. A back button ("← ALL TERMINALS") is visible in the team header.
4. Manual: click the back button — the panel returns to the full fleet view.
5. Manual: in team-scoped mode, confirm OPEN AGENT TERMINALS, START TEAM, FILL GRID, CLEAR ALL TERMINALS, SAVE AS GROUP, and LINK UP are NOT visible. Only team members, STANDING ORDERS, AUTOMATIONS, and team controls appear.
6. Manual: let a team member finish. The team button pulses once and holds the done light. Click it — the panel switches to team-scoped, the light clears.
7. Manual: close the Terminals panel and confirm the shell rail container disappears and the Setup + theme cluster stays anchored.
8. Grep assertion: no `ensureRailModeToggle`, `railMode`, `sb-rail-mode`, `strip-rail-mode` references remain in shell.js or shell.html.
9. Grep assertion: no `popoutTeam` references remain in shell.js.
10. Grep assertion: no `.strip-team-count` references remain in shell.js or shell.html.

---

## Completion Report

Implemented all seven UAT remediations. Removed the rail mode toggle (variable, localStorage, `ensureRailModeToggle`, `updateRailModeIcon`, `.strip-rail-mode-btn` CSS) and made teams mode the only mode. Fixed the team icon fallback chain: `buildTeamsForShell` no longer falls back to the head's CLI brand mark, and the shell's `renderTerminalSection` goes straight from team icon to role letter (no brand-mark arm). Removed the member-count badge (`.strip-team-count` element + CSS) and simplified the team button tooltip to just `team.name`. Replaced the `window.open` pop-out with in-place navigation: the team click handler posts `switchToTeam` to the terminals panel, which calls `enterTeamScope` (sets `teamScopeId` before `switchToGroup` to pass the guard), and a back button in `renderTeamHeader` calls `exitTeamScope` to return to the full fleet. Added `body.is-team-scoped` CSS to hide `#btn-open-all`, `#btn-fill-grid`, `#fill-grid-form`, `#btn-start-team`, `#start-team-form`, `#btn-clear-all`, `#btn-save-group`, `#btn-link-up` while keeping team-relevant controls visible. Removed the dead `popoutTeam` message handler. Updated `shell-terminal-strip.test.js` with 14 new test assertions covering all changes. Files changed: `src/webview/shell.js`, `src/webview/shell.html`, `src/webview/terminals.js`, `src/webview/terminals.html`, `src/test/shell-terminal-strip.test.js`. No issues encountered; compilation and tests skipped per session directives.
