# Terminals Cockpit Grouping - Seat Real Teams, Stop Inventing Fake Ones

**Complexity:** 5

## Goal

Fix the terminals grid group model at both ends - the group the operator deliberately created is never seated, and a group nobody asked for materialises on its own. Starting a team head spawns every member and registers a terminals group for them, then the webview throws the whole response away and seats only the head, which makes the team feature unusable. Meanwhile a second terminal sharing a job title conjures a Planners tab, a chip on every row and a lock target, and unions planners across unrelated workspaces into one grid. Both are the same missing predicate: group membership needs operator intent and a location, not a shared string.

## How the Subtasks Achieve This

- **Seat the whole team in the terminal grid when a team head starts**: Returns the backend-registered group id on the `ptyCreateTerminal` response and has `createTerminal()` lock onto that group instead of seating one terminal — with an explicit presence check, a by-name fallback that seats the team's own names (not `fillEmptyPanes`'s strangers), focus handed to the head, and toasts for the three failure channels currently dropped on the floor.
- **Stop Auto-Creating a "Planners" Group, and Scope Role Groups to One Workspace/Worktree**: Puts derived role groups behind an opt-in flag reachable from the overflow menu (both conditional-render gates deleted, so the toggle is not hidden by the state it exists to escape), and keys them on role *plus* location using the same `parentRoot` / `worktreePath` rule `renderSidebarList` already buckets by — so the group strip and the tree never tell two different stories about where a terminal lives.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Stop Auto-Creating a "Planners" Group, and Scope Role Groups to One Workspace/Worktree](../plans/feature_plan_20260814144853_derived-role-groups-consent-and-location-scoping.md) — **CODE REVIEWED** — ID: 3eba89c5-9355-44a5-b187-50de917da542
- [ ] [Seat the whole team in the terminal grid when a team head starts](../plans/feature_plan_20260815134928_team-members-never-seated-in-terminal-grid.md) — **CODE REVIEWED** — ID: e79c9f14-0662-4a47-abae-f1eb58ab9feb
<!-- END SUBTASKS -->

## Dependencies & sequencing

No functional dependency — one subtask adds a switch onto a **manual** `team_*` group, the other gates and re-keys **derived** `dg_role_*` groups, and the role-group subtask explicitly leaves manual and backend-registered team groups untouched.

They are nonetheless **strictly sequential in practice**:

- Both edit `src/webview/terminals.js` in overlapping regions — `createTerminal`, the `restoredLockOnLoad` block in the fetch path (`~:1575`), and the group-tab strip.
- Both extend `src/test/terminal-sidebar-groupings-contract.test.js`, including its exact-literal tripwire assertions (the `groupPrefs` initialiser literal, the `keepLock` call-site count of exactly 1). A parallel edit turns one of them red for a reason unrelated to its own change.

**Recommended order: seat-the-team first** (additive, introduces its own new helpers `switchToTeamGroup` / `focusSeatedTerminal` / `seatTeamWithoutGroup`), **then role-group consent** (which reshapes `getDerivedGroups`, adds `autoRoleGroups` to the initialiser and loader whitelist, and adds a lock reconcile at the same restore site). Neither requires a migration: the role-group state is one unpushed commit old, and the team group id already persists in `terminals.groups`.

## Review Findings

Reviewer pass (2026-08-17, tests executed) across both subtasks. Both are implemented faithfully at every named edit site — 8 in `src/webview/terminals.js` for the role-group subtask, 5 across `teamWiring.ts` / `TaskViewerProvider.ts` / `bootstrap.ts` / `terminals.js` for the seat-the-team subtask — and each plan's hardest identified trap is correctly avoided: the conditional-render trap that would have hidden the role toggle inside the menu it enables, and the `assignToFocusedPane` lock-drop that would have silently reverted the team seating. **No CRITICAL or MAJOR finding survived verification and no code changes were applied**; the three material items left open by the 2026-08-16 pass (two broken test slices, the missing `activeGroupId = null`, the untracked `team-autostart-workspace-scope.test.js`) are all confirmed closed. Verification: `test:contract:terminal-sidebar-groupings` **48/48**, `test:contract:team-autostart-scope` **11/11**, `test:contract:multi-parent-terminals` **29/29**, `node --check` clean, `tsc --noEmit` clean for this work (5 pre-existing `TS2835` errors in untouched files); all three checks are both defined in `package.json` and invoked by CI (`integration-tests.yml:569/633/646`), so there is no green-while-incomplete gate hole. One MAJOR-severity gap is recorded but deliberately **out of scope**: `startTeam()` (`terminals.js:6767`) still seats the head alone via `assignToFocusedPane` while `agentGroupInstantiation.ts:122` discards `wired.groupId` — that entry point belongs to the feature *"Teams You Can See, Start and Trust"*, whose approved subtask *"Promote START TEAM Out of the Tiny `+` Picker"* rewrites the same function.
