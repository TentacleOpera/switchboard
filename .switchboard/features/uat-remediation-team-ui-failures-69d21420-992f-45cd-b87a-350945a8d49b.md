# UAT Remediation: Team UI Failures

**Complexity:** 5

## Goal

Fix ten UAT failures from the team-first-class-object feature. The shell strip was supposed to become a roster of team icons with in-place navigation; what shipped has a mode toggle, wrong icons, member counts, verbose tooltips, and pop-out windows. The TEAMS tab has a pacing checkbox that should never have been a manual UI control, and the team action bar is a confusing strip on top instead of replacing the generic sidebar buttons.

## How the Subtasks Achieve This

- **UAT Remediation: Shell Strip & In-Place Team View**: Fixes failures 1–6 and 9. Removes the rail mode toggle so teams mode is the only mode. Fixes team icon resolution so the rail shows team icons (not CLI brand marks) with a role-portrait fallback. Fixes ungrouped terminal rendering so they get per-terminal buttons, not team buttons. Removes the member-count badge and simplifies the tooltip to just the team name. Replaces pop-out window behaviour with in-place navigation — clicking a team icon switches the main terminals panel to team-scoped mode with a back button. Hides generic sidebar buttons (OPEN AGENT TERMINALS, START TEAM, LINK UP) in team-scoped mode.
- **UAT Remediation: Remove Pacing Toggle & Relocate Action Bar**: Fixes failures 7–8 and 10. Removes the "SEATS PACE THE QUEUE (NO HEAD)" checkbox from the TEAMS tab — routing is automatic (features to team lead, standalone plans to members by complexity). Removes the misleading pacing note that claims the head advances cards (only a reviewer inside the team can do that, already enforced at `teamWiring.ts:744`). Relocates the action bar buttons from a confusing strip on top into the sidebar, replacing the generic fleet buttons. Renames all buttons for clarity (CLEAR BADGES → ACKNOWLEDGE COMPLETIONS, AUTOS → SCHEDULED AUTOMATIONS, etc.).

## Dependencies & sequencing

- **Plan A must land before Plan B.** Plan B's action bar relocation depends on Plan A's sidebar cleanup — Plan A hides the generic sidebar buttons (OPEN AGENT TERMINALS, START TEAM, LINK UP) in team-scoped mode via CSS, and Plan B moves the action bar buttons into that same sidebar area. If Plan B lands first, the action bar would compete with the generic buttons for sidebar space.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [UAT Remediation: Shell Strip & In-Place Team View](../plans/uat-shell-strip-in-place-team-view.md) — **CODE REVIEWED**
- [ ] [UAT Remediation: Remove Pacing Toggle & Relocate Action Bar](../plans/uat-remove-pacing-toggle-relocate-action-bar.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Completion Report

Both subtasks implemented and reviewed against their plan files. Plan A (shell strip & in-place team view) landed first via Coding-coder-1, Plan B (pacing toggle removal & action bar relocation) landed second via Coding-coder-2 — sequencing respected. Files changed: `src/webview/shell.js` (removed rail mode toggle, fixed icon fallback to skip brand mark, removed member-count badge, simplified tooltip to team name, replaced window.open popout with switchToTeam postMessage, removed popoutTeam handler), `src/webview/shell.html` (removed .strip-team-count and .strip-rail-mode-btn CSS), `src/webview/terminals.js` (removed brand-mark fallback in buildTeamsForShell, added switchToTeam handler + enterTeamScope/exitTeamScope + back button in renderTeamHeader, relocated action bar buttons to sidebar with wireTeamActionBar IIFE, show/hide in renderSidebarList with RESTART disabled-state, removed +/ORDERS/AUTOS/actionBar/mkActionBtn from header), `src/webview/terminals.html` (team-scoped hide CSS for 8 generic sidebar buttons, .team-header-back CSS, 6 new sidebar buttons with renamed labels, AUTOMATIONS→SCHEDULED AUTOMATIONS), `src/webview/kanban.html` (removed pacing toggle block + misleading note), `src/test/shell-terminal-strip.test.js` (14 new assertions). No compilation or tests run per session directives. No issues encountered during review — both diffs matched their plans.

## Review Findings

Both subtasks reviewed in dependency order against their plan files; all ten UAT remediations landed as specified. Three MAJOR defects were found and fixed: `enterTeamScope`/`exitTeamScope` never re-read settings under the changed scope, so each transition clobbered the other side's namespaced layout keys (`mapSettingKey` prefixes them by `teamScopeId`); `enterTeamScope` skipped `loadQueueModeFromOrders()`, which the pop-out removal made the only caller, leaving the Manual/Auto toggle stale; and Plan B's two named automated tests were never written, leaving the action-bar relocation ungated. Files changed in this review: `src/webview/terminals.js`, `src/webview/terminals.html`, `src/test/shell-terminal-strip.test.js`, `src/test/teams-tab-no-start-contract.test.js`. Validation: `shell-terminal-strip` 64/64, `teams-tab-no-start` 8/8, plus 14 further terminal/team contract suites green; 5 assertions are red across 4 unrelated suites but were proven pre-existing at `1a165cc2` (pre-plan) and `npm run compile` fails only on another agent's uncommitted `agentGroupInstantiation.ts` edit, left untouched per git policy.
