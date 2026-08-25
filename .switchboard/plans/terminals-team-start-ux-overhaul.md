# Terminals Sidebar: Team-Start UX Overhaul

## Goal

The team-start controls in the Terminals panel sidebar (`terminals.html` / `terminals.js`) are clunky in three ways. This plan fixes all three in one cohesive change:

1. **Workspace selector doesn't default to the kanban's workspace.** The `start-team-target` dropdown lists workspace roots in DOM order and falls through to the first one. Every other workspace selector in Switchboard (memo.js, design.js, kanban panes) defaults to `initialWorkspaceRoot` — the workspace the kanban board had selected when the panel was built. The start-team form is the lone exception.

2. **No one-click "start all teams" button.** The operator must open the START TEAM form, pick a team from a dropdown, and click START — one team at a time. There is no way to start every defined team in the current workspace with a single click.

3. **OPEN AGENT TERMINALS is redundant once teams are in use.** Teams define which agents to start (head + members with roles and counts). OPEN AGENT TERMINALS creates one bare terminal per visible agent role with no team structure, no workspace targeting, and no group wiring. Once the operator has authored teams, this button is a footgun: it spawns a disconnected fleet that bypasses team wiring, standing orders, and group seating.

## Background & Root Cause

- `initialWorkspaceRoot` is captured at boot from `data-initial-workspace-root` (terminals.js:807-810) and used by `defaultKanbanWorkspace()` (terminals.js:6755-6764) for kanban panes, but the `btnStartTeam` click handler (terminals.js:1018-1054) never consults it when populating `startTeamTarget`. This is especially wrong for the START TEAM button's primary use case: duplicating a team into a different workspace or worktree. The selector must start from the kanban's workspace so the operator can change it to the target — not from an arbitrary first root.

- `_agentGroupsCache` is refreshed on every fleet poll (~5s) via `refreshAgentGroupsForShell()` (terminals.js:1628-1636) → `buildTeamsForShell()` (terminals.js:1671-1675) → `postFleetStateToShell()` (terminals.js:2238). It holds the full list of team definitions for the current workspace. This cache is the natural signal for "are teams defined?" but is not currently used to adapt the sidebar ops block.

- The backend's `startTeamById` (teamWiring.ts:1321-1356) refuses double-starts when the head *role* is already live as an unparented (head) terminal — this check is **role-based and global**, not workspace-scoped or team-id-scoped. The guard at teamWiring.ts:1343-1344 checks `t.status === 'active' && t.role === headRole && !t.parentInstanceId`. Without frontend pre-filtering, a "start all" loop would surface these refusals as error toasts — noisy for what is a benign "already running" state. The pre-filter must mirror the backend's exact check: is the team's `headRole` already live as an active, unparented terminal in `fleetList`?

- **Two buttons, two purposes.** START ALL TEAMS is the one-click "start every non-running team in the current workspace" path. START TEAM (the existing dropdown form) is the "start a specific team, optionally in a different workspace" path — used both to duplicate a team into another workspace/worktree AND to start a second distinct team in the same workspace (e.g. when code is split across unrelated files and no worktrees are needed). The two buttons serve distinct workflows and must coexist.

- **Multiple teams, same workspace is a first-class pattern.** The codebase already handles head-role collisions: when two teams share a head role, `migrateAgentGroups` (teamWiring.ts:818-897, collision resolution at 879-897) marks the second `unassigned: true` — still explicitly startable, just not auto-start. START ALL TEAMS must include `unassigned` teams in its attempt list; the pre-filter (head-role liveness) naturally handles them: if the first team's head is live, the `unassigned` team is skipped (backend would refuse); if the first team was stopped, the `unassigned` team starts.

## Metadata

**Complexity:** 4
**Tags:** ui, ux, feature, refactor
**Project:** Browser Switchboard

## User Review Required

- The `startTeam()` function modification (adding return value + `silent` flag) touches a shared code path used by both the existing START TEAM form and the new START ALL TEAMS button. The change is backward-compatible (optional parameter, added return value that the existing caller ignores), but the implementer should verify the existing START TEAM flow is unaffected after the change.

## Complexity Audit

### Routine
- Setting `startTeamTarget.value = initialWorkspaceRoot` after the options loop — one-line addition mirroring an existing pattern in memo.js:49-60.
- Adding `#btn-start-all-teams` to the team-scoped and controller-scoped CSS hide lists in terminals.html — two selector additions.
- The `updateTeamStartButtons()` function — a 6-line visibility toggle based on `_agentGroupsCache.length`.
- Wiring the click handler near the existing `btnStartTeam` wiring — follows the same `getElementById` + `addEventListener` pattern.

### Complex / Risky
- Modifying `startTeam()` to return `data` and accept an `opts.silent` flag. This function (terminals.js:8365-8455) handles curtain-arming, fleet refresh, group seating, and multiple toast paths. The modification must preserve all existing behavior for the current caller (START TEAM form, line 1074) while enabling the new caller (START ALL TEAMS) to inspect results and suppress toasts. The function has 4 exit paths (missing team, success, error, catch) — each must return the appropriate value.
- The pre-filter's status check must match the backend's `=== 'active'` exactly. Using `!== 'exited'` (as the original plan proposed) would include transitional states ('starting', 'ready') that the backend does not consider live, causing the pre-filter to skip teams the backend would allow.

## Edge-Case & Dependency Audit

### Race Conditions
- **Team starts between frontend check and backend call.** The pre-filter reads `fleetList` (which may be up to 5s stale from the last poll). A team could start between the pre-filter check and the `startTeam()` call. Handled by treating double-start refusals as silent skips (step 6 of the START ALL TEAMS handler). The backend's error string at teamWiring.ts:1348 contains "already live" — match on that substring.
- **`_agentGroupsCache` one-poll lag.** The cache updates asynchronously on fleet poll. On first paint the cache may be empty, so OPEN AGENT TERMINALS shows briefly until the first `refreshAgentGroupsForShell` resolves (~5s). This is acceptable — the same lag exists for team icons in the shell rail today.

### Security
- No security implications. All team definitions are host-resolved (the backend's `ptyStartTeam` verb rejects caller-supplied group definitions — bootstrap.ts:1486-1488). The frontend only sends `teamId` and optional `parentRoot`.

### Side Effects
- `startTeam()` with `opts.silent` suppresses `showPaneToast` calls but preserves all other side effects: curtain-arming, `fetchTerminalList()`, group seating. This is intentional — the START ALL TEAMS handler shows only its own summary toast.
- The `updateTeamStartButtons()` call in `refreshAgentGroupsForShell()`'s `.then()` callback fires asynchronously after the cache updates. This is correct — it toggles visibility only when the cache actually changes, not on every poll.

### Dependencies & Conflicts
- **`startTeam()` modification.** The existing START TEAM form caller (terminals.js:1074) calls `startTeam({ id: teamId }, targetSpec)` without a third argument. The modification adds an optional third parameter `opts` — the existing call is unaffected (`opts` defaults to `{ silent: false }`).
- **`openAllTerminals()` sequential pattern.** The START ALL TEAMS handler starts teams sequentially for the same reason `openAllTerminals()` does (terminals.js:8620-8623): `ptyFleetService.create()` picks the next free `${role}-${n}` name, so concurrent creates for the same role can collide.
- **Published extension, ~4,000 installs.** No state migration needed — this is a pure UI change. No settings, no stored state, no DB schema changes. The new button's `hidden` attribute defaults to hidden, so users on older versions who update see no change until teams are defined.

## Dependencies

None — this plan is self-contained within `terminals.js` and `terminals.html`.

## Adversarial Synthesis

Key risks: (1) `startTeam()` returns void — the plan's error-handling strategy depends on inspecting a return value that doesn't exist, requiring a backward-compatible modification to add a return value and `silent` flag; (2) the original plan's status check (`!== 'exited'`) doesn't match the backend's (`=== 'active'`), causing false-negative skips for teams in transitional states — corrected to `=== 'active'`; (3) all line references in the original plan were wrong — corrected to match actual code. Mitigations: the `startTeam()` modification is additive (optional parameter, new return value the existing caller ignores); the status check correction aligns the pre-filter with the backend's exact guard; line references verified against current source.

## Proposed Changes

### 1. Fix workspace selector default (`terminals.js`)

In the `btnStartTeam` click handler (terminals.js:1018-1054), after populating `startTeamTarget` with workspace roots (after the `for (const r of roots)` loop at line 1044-1049), set the selected option to `initialWorkspaceRoot` if it exists in the list. This mirrors the pattern in memo.js:49-60:

```js
// After the `for (const r of roots)` loop that appends options:
if (initialWorkspaceRoot) {
    startTeamTarget.value = initialWorkspaceRoot;
}
```

If `initialWorkspaceRoot` doesn't match any option (e.g., it's from a workspace no longer in `parentsList`), the select keeps its default first-option selection — same as today, no regression.

**Context:** `initialWorkspaceRoot` is declared at terminals.js:100 and captured at terminals.js:807-810 from `document.body.dataset.initialWorkspaceRoot`. The `startTeamTarget` select is populated from `parentsList` (terminals.js:1040-1049). Setting `.value` on a `<select>` to a value that matches an existing option selects it; a non-matching value leaves the selection unchanged.

### 2. Modify `startTeam()` to return data and accept silent flag (`terminals.js`)

> **Superseded:** The original plan called `startTeam()` sequentially and inspected its return value for double-start refusals (`success === false` and error mentioning "already live"), treating them as silent skips.
> **Reason:** `startTeam()` (terminals.js:8365-8455) returns `void` — it never returns the `data` object. It also calls `showPaneToast()` on every error (line 8446), so "silent" skips would produce a toast per refusal. The plan's error-handling strategy was built on a phantom API.
> **Replaced with:** Modify `startTeam()` to return the `data` object (or `null` on network failure) at each exit path, and accept an optional third parameter `opts` with a `silent` boolean that suppresses all `showPaneToast` calls within the function. The existing caller (START TEAM form, line 1074) is unaffected — it doesn't pass `opts` and doesn't use the return value.

**Implementation:**

Change the function signature at terminals.js:8365:
```js
async function startTeam(team, targetSpec, opts) {
    const silent = opts && opts.silent;
```

Add returns at each exit path:
- **Missing team** (line 8366): `return null;`
- **Success path** (after seating/toast block, before the closing `}` of the `try`): `return data;`
- **Error path** (line 8442-8450): wrap the `showPaneToast` calls in `if (!silent) { ... }`, then `return data;`
- **Catch path** (line 8451-8454): wrap the `showPaneToast` call in `if (!silent) { ... }`, then `return null;`

The success-path toasts (seating notes, delegate warnings at lines 8435-8440) should also be guarded by `if (!silent)` — the START ALL TEAMS handler shows only its own summary toast.

**Edge cases:** The `silent` flag does NOT affect curtain-arming, `fetchTerminalList()`, or group seating — only `showPaneToast` calls. The function's side effects are preserved regardless of `silent`.

### 3. Add START ALL TEAMS button (`terminals.html` + `terminals.js`)

**HTML** — Add a new button in the `.sidebar-ops` block (terminals.html:2388), immediately above the existing `#btn-open-all` (terminals.html:2389):

```html
<button type="button" id="btn-start-all-teams" class="secondary-btn is-teal w-full"
        title="Start every defined team in the current workspace (skips teams already running)" hidden>START ALL TEAMS</button>
```

Starts `hidden`; the visibility toggle (change 5 below) reveals it when teams are defined.

**CSS** — Add `#btn-start-all-teams` to the team-scoped hide list (terminals.html:2149-2157) and the controller-scoped hide list (terminals.html:2165-2179), alongside `#btn-open-all` and `#btn-start-team`:

```css
/* team-scoped (add to the existing list at terminals.html:2149-2157) */
body.is-team-scoped #btn-start-all-teams,

/* controller-scoped (add to the existing list at terminals.html:2165-2179) */
body.is-controller-scoped #btn-start-all-teams,
```

The button is irrelevant in scoped views.

**JS** — Wire a click handler in `init()` near the existing `btnStartTeam` wiring (terminals.js:1010). Place it after the `btnOpenAll` handler block (terminals.js:924-938):

1. Fetch all team definitions via `fetchAgentGroups()` (terminals.js:7986-8001). If none, show a toast ("No teams defined — add one in the TEAMS tab.") and return.
2. Build a set of live head roles from `fleetList`: any terminal where `t.status === 'active'` and `t.role === headRole` and `!t.parentInstanceId`. This mirrors the backend's `startTeamById` double-start guard (teamWiring.ts:1343-1344) exactly — the backend refuses if the head role is already live as an active, unparented terminal, so pre-filtering on the same criterion avoids sending calls the backend will refuse. Note: teams marked `unassigned: true` (head-role collision with another team) are NOT excluded from the attempt list — they are valid, explicitly-startable teams. If their head role is live (the other team is running), the pre-filter skips them; if not, they start.
3. Filter the team list to exclude teams whose `headRole` is in the live-head-roles set. If all are running, show a toast ("All teams already running.") and return.
4. Disable the button, set text to "STARTING…".
5. Start each non-running team **sequentially** via `startTeam({ id: team.id }, targetSpec, { silent: true })`, where `targetSpec` is `{ parentRoot: initialWorkspaceRoot }` when `initialWorkspaceRoot` is set, or `undefined` otherwise (backend resolves).
6. Inspect the return value from `startTeam()`: if `data && data.success === false` and `data.error` includes "already live", skip silently — this covers the race where a team started between the check and the call.
7. If `startTeam()` returns `data` with `data.success === false` and the error does NOT include "already live", show a toast with the error message but continue starting remaining teams.
8. If `startTeam()` returns `null` (network failure), show a toast ("Could not start team '<name>' — network error.") but continue.
9. After all teams are processed, re-enable the button, restore text, and show a summary toast: "Started N team(s), skipped M running." (Only if M > 0; otherwise just "Started N team(s).")

**Why sequential:** `ptyFleetService.create()` picks the next free `${role}-${n}` name, so concurrent creates for the same role can collide. The existing `openAllTerminals()` already creates sequentially per role for the same reason (terminals.js:8620-8623 comment).

### 4. No change to START TEAM form's team-name dropdown

The team-name dropdown (`start-team-name`) defaults to the first option in DOM order. This is fine — START TEAM serves two workflows (start a different team in the same workspace, or duplicate a team into another workspace), and in neither case is there a "current team" to default to. The operator picks the team and the target workspace deliberately. The only fix needed here is the workspace selector default (change 1 above).

### 5. Conditional hide: START ALL TEAMS vs OPEN AGENT TERMINALS (`terminals.js`)

Add a function `updateTeamStartButtons()` that toggles visibility based on `_agentGroupsCache`:

```js
function updateTeamStartButtons() {
    const hasTeams = (_agentGroupsCache && _agentGroupsCache.length > 0);
    const btnAllTeams = document.getElementById('btn-start-all-teams');
    const btnOpenAll = document.getElementById('btn-open-all');
    if (btnAllTeams) { btnAllTeams.hidden = !hasTeams; }
    if (btnOpenAll)  { btnOpenAll.hidden  =  hasTeams; }
}
```

Call sites:
- In `refreshAgentGroupsForShell()`'s `.then()` callback (terminals.js:1631-1632), after `_agentGroupsCache` is updated — this is the natural update point since the cache changes there. Add `updateTeamStartButtons();` after line 1632 (`_agentGroupsCache = Array.isArray(groups) ? groups : [];`).
- Once at the end of `init()` (after `startFleetPoll()` at terminals.js:1498), before the closing `}` at line 1499 — covers the initial paint.

The `hidden` attribute is used (not `display:none` CSS) so the team-scoped / controller-scoped CSS `display:none !important` rules still win when those body classes are active. The `hidden` attribute and `display:none !important` compose correctly: `hidden` sets `display:none` by default (UA stylesheet), and `!important` overrides it only when the body class is present (which is the desired behavior — hide everything in scoped modes).

## Verification Plan

### Automated Tests

1. **Workspace selector default:**
   - Open the Terminals panel in a multi-workspace setup where the kanban board has a specific workspace selected.
   - Click START TEAM. Verify the workspace dropdown defaults to the kanban's workspace, not the first root in list.
   - Compare with the memo workspace selector and the design modal workspace selector — all three should default to the same workspace.

2. **START ALL TEAMS button:**
   - Define 2+ teams in the TEAMS tab.
   - With no teams running, click START ALL TEAMS. Verify all teams start, each with its head + members, seated in their groups.
   - With some teams already running, click START ALL TEAMS. Verify running teams are skipped silently and only non-running teams start. Verify the summary toast reports the correct counts.
   - With all teams running, click START ALL TEAMS. Verify "All teams already running." toast and no backend calls.
   - With no teams defined, verify the button is hidden and OPEN AGENT TERMINALS is shown instead.

3. **`startTeam()` return value + silent flag:**
   - Verify the existing START TEAM form still works unchanged — toasts appear on success and error, team is seated.
   - Verify START ALL TEAMS does NOT show individual per-team toasts — only the summary toast.
   - Verify a non-refusal error (e.g. PTY unavailable) during START ALL TEAMS shows a toast for that team and continues starting remaining teams.

4. **Conditional hide:**
   - With no teams defined: verify OPEN AGENT TERMINALS is visible, START ALL TEAMS is hidden.
   - Define a team in the TEAMS tab. Within ~5s (next fleet poll), verify OPEN AGENT TERMINALS hides and START ALL TEAMS appears without a page reload.
   - Delete all teams. Within ~5s, verify the buttons swap back.
   - Enter team-scoped mode (click a team on the rail). Verify both buttons are hidden.
   - Enter controller-scoped mode. Verify both buttons are hidden.

5. **No confirm dialogs:** Verify no `confirm()`, `showWarningMessage`, or two-click patterns were introduced (CLAUDE.md rule).

6. **START TEAM duplication workflow:**
   - With a team already running in workspace A, open START TEAM.
   - Verify the workspace dropdown defaults to the kanban's workspace (not the first root).
   - Select workspace B and start the same team. If the backend's head-role guard refuses (head role already live from workspace A), verify the error toast surfaces the refusal message clearly — the operator understands why and can stop the first instance if they want the duplicate.

7. **Multiple teams, same workspace:**
   - Define two teams with different head roles (e.g. a "Coding" team with head `lead` and a "Review" team with head `reviewer`) in the same workspace.
   - Click START ALL TEAMS. Verify both teams start — the pre-filter finds no live head roles, so both proceed.
   - Stop one team. Click START ALL TEAMS again. Verify only the stopped team restarts; the running one is skipped.
   - Define a third team with the same head role as one of the existing teams (e.g. another `lead` team). Verify it appears in the TEAMS tab as `unassigned`. Click START ALL TEAMS with the first `lead` team running — verify the `unassigned` team is skipped (head role live). Stop the first `lead` team, click START ALL TEAMS — verify the `unassigned` team now starts.

### Goal Invariants

- Assert `startTeam()` in `src/webview/terminals.js` returns a non-`undefined` value at the success exit path (the `data` object).
- Assert `startTeam()` in `src/webview/terminals.js` accepts a third parameter `opts` without breaking when `opts` is omitted.
- Assert `document.getElementById('btn-start-all-teams')` exists in `src/webview/terminals.html`.
- Assert `#btn-start-all-teams` appears in both the `body.is-team-scoped` and `body.is-controller-scoped` CSS hide lists in `src/webview/terminals.html`.
- Assert `updateTeamStartButtons` is called in `refreshAgentGroupsForShell`'s `.then()` callback in `src/webview/terminals.js`.
- Assert the START ALL TEAMS pre-filter checks `t.status === 'active'` (not `!== 'exited'`) in `src/webview/terminals.js`.
- Assert no `confirm(` or `window.confirm(` calls were added to `src/webview/terminals.js` or `src/webview/terminals.html`.
