# TEAMS Tab — Three Team Types, One Phone-a-Friend Control, No Dead Spawner

## Goal

Reduce the TEAMS tab to what it is actually for: **three shipped team types** — Batch planners, Coding, Multi-agent planning — plus **Phone-a-Friend as a per-coder option**, not a team type. Remove the "Delegate children" editor, whose configuration is silently overridden whenever a team claims the role.

### Problem analysis and root cause

**The tab stacks three mechanisms that all answer "who else works with this agent", as if they were peers, without indicating that one of them is dead.**

| Subsection | Storage | Vocabulary |
| :--- | :--- | :--- |
| Team Types gallery + Your Teams | `terminals.agentGroups` | members, `scope`, `relationship` presets |
| Delegation → **Delegate children** | role config `addons.delegates` | `{role, count, label, startupCommand}`, no relationship |
| Delegation → **Phone-a-Friend** | `addons.phoneAFriend`, `addons.phoneAFriendTargets`, a `phone_a_friend` role | origin→target terminal-name map, HTTP endpoint, prompt directive |

**"Delegate children" is already dead whenever teams are used, and nothing says so.** `bootstrap.ts:1168` sets `payload.delegates` from `roleConfig.addons.delegates`; `:1203` then overwrites it with `team.members` whenever a team heads that role, commented *"The team's members override role-config delegates."* The extension host has the identical pair at `TaskViewerProvider.ts:2488` (read) and `:2539` (overwrite). So the editor does nothing for any role a team claims, and works for roles no team claims. Either way the operator gets no signal — the single largest source of "I configured it and nothing happened".

> **Superseded:** `bootstrap.ts:1153` sets `payload.delegates` …; `:1188` then overwrites it … / read path at `TaskViewerProvider.ts:2206`.
> **Reason:** Line-number drift on all three references against the current tree; the extension-host overwrite site was unnamed.
> **Replaced with:** Read paths `bootstrap.ts:1168` and `TaskViewerProvider.ts:2488`; team overwrites `bootstrap.ts:1203` and `TaskViewerProvider.ts:2539`.

**The gallery does not match the intended mental model.** It ships four types (`kanban.html:4396-4428`): Feature team, Planning team, Solo coder, Review team.

- **Solo coder** is a team-type card for something that is not a team — zero members, and its own purpose text says *"Phone-a-Friend fires from role config"*, pointing at a different mechanism entirely.
- **Review team** duplicates a relationship that the Coding team already expresses as a member (`reviewer`, shared scope).
- The two genuinely distinct planning workflows — batch planning and the multi-agent fan-in run — are collapsed into one "Planning team".

**Phone-a-Friend's UI is raw plumbing.** The Delegation panel renders `phoneAFriendTargets` as an origin-terminal → target-terminal string map with an "ADD TARGET" button (`kanban.html:4255-4280`). That is the override mechanism exposed as the primary control. The common case — "this coder calls a friend when it finishes a batch" — is a boolean plus a target.

**Stale copy.** `PHONE_A_FRIEND_DIRECTIVE` (`agentPromptBuilder.ts:674`) still tells the agent the friend is *"configured in the Agents tab"*. It moved to TEAMS.

**Root cause: the same pattern as the rest of the set.** A newer mechanism was added beside an older one and the older one was left plumbed but inert, and the tab presents both.

**Blast radius.** `addons.delegates`, `addons.phoneAFriend` and `addons.phoneAFriendTargets` are all shipped role-config state. Per the repo's migration rule they must be imported or preserved, never dropped.

## Metadata

**Complexity:** 4
**Tags:** ui, ux, refactor, database

## User Review Required

None. Three types, phone-a-friend demoted to a per-coder control, delegate-children migrated into teams and its editor removed.

## Complexity Audit

### Routine

- Editing the `SHIPPED_TEAM_TYPES` array (`kanban.html:4396`).
- Replacing the phone-a-friend map editor with a toggle plus a target select, with the map kept behind an "advanced" disclosure.

### Complex / Risky

- **The delegate-children migration is the data-risk item.** Existing `addons.delegates` entries must become a team definition for that role before the editor disappears. A role that already has a team must not have its team clobbered by the import — merge or skip, never overwrite.
- **Deleting the editor is not enough; the read path must go too.** `bootstrap.ts:1168` and `TaskViewerProvider.ts:2488` both still populate `payload.delegates` from role config. Leaving them means an un-migrated install keeps spawning delegates from an editor that no longer exists — invisible behaviour with no UI.
- **Phone-a-Friend's transport stays.** The `/phone-a-friend` endpoint, the `phone_a_friend` role, `_dispatchPhoneAFriend` and the per-terminal override map all keep working. This plan changes the control surface only. Rebuilding it on team relationships is explicitly out of scope.
- **The three types need two planning teams to coexist AND be adoptable.** With `explicit-team-start-in-terminals-panel.md` landed, both are true; without it the third type is unstartable and unadoptable, and this plan is blocked. See the dependency note below — that plan now owns the whole collision rule, including the two webview gates in this file.
- **`custom_agent_` roles are absent from the head-role dropdown**, which is static HTML (`kanban.html:3118-3127` — eight built-in `<option>` rows, `lead` through `researcher`, verified) that `teamsTabShowGroupForm` only iterates to disable claimed entries. Out of scope here, but worth knowing the dropdown cannot express a custom head role.

## Edge-Case & Dependency Audit

**Race Conditions** — none new; the agent-groups store already serialises writes through `_groupsWriteChain` (`teamWiring.ts:90`).

**Security** — none new.

**Side Effects** — removing the delegate-children read path changes spawn behaviour for any install relying on it. That is the point, but it must happen *after* the import, in that order.

**Dependencies & Conflicts** — depends on explicit team start for the third type to be startable and adoptable, and on the team-prompt work for a team to carry its own instructions. The gallery cards should be authored against the post-team-prompt shape so they are not rewritten twice.

**Shared file.** `src/webview/kanban.html` is edited by all three of: `explicit-team-start-in-terminals-panel.md` (the two collision gates), `team-prompt-replaces-pair-records.md` (the team-prompt text area) and this plan. Per the project's one-stream-per-file rule these must serialise in dependency order — explicit-start, then team-prompt, then this plan last.

**Collision-rule ownership — moved out of this plan.** The head-role collision rule is enforced at four sites, two of which are in this file: `teamsTabRenderGallery`/`teamsTabGalleryCard` (`kanban.html:4452`, `:4464`, `:4478-4484`), which suppresses the USE button for a claimed head role, and `teamsTabShowGroupForm` (`:4674-4679`), which disables claimed head-role options. Narrowing them is now owned end-to-end by `explicit-team-start-in-terminals-panel.md`.

> **Superseded:** Verification step 2 — "Both planning teams can be adopted and started, confirming the head-role collision no longer blocks existence" — with no implementation step in any plan delivering the webview half.
> **Reason:** A cross-subtask audit found the collision rule enforced at four sites. This plan asserted the outcome in its verification while `explicit-team-start-in-terminals-panel.md` implemented only the host-side site (`migrateAgentGroups`). The two webview gates live in this file and were unowned, so `teamsTabGalleryCard` would still render *"head role claimed by X"* with no USE button and the second planning team would be unadoptable — the step would fail with no plan responsible for fixing it.
> **Replaced with:** One rule, one owner. `explicit-team-start-in-terminals-panel.md` narrows all four sites, including the two in `kanban.html`. This plan consumes that as a prerequisite and verifies only its own surface (the third type exists in the gallery and can be adopted).

## Dependencies

`explicit-team-start-in-terminals-panel.md` — without it, two planning teams can neither coexist nor be adopted (it owns all four collision-rule enforcement sites, including the two in this file).
`team-prompt-replaces-pair-records.md` — the shipped types should carry team prompts, not per-member pair rows.

## Adversarial Synthesis

**Risk summary.** The gallery edit is trivial and the phone-a-friend control is a straight simplification; the risk sits entirely in the delegate-children retirement, which touches shipped role config on ~4,000 installs and has a load-bearing order — import into teams first, remove the read path second, and never overwrite an operator's existing team for that role. The second risk is a dependency that was previously assumed rather than owned: this plan's three-type gallery only works if a claimed head role stops suppressing the USE button, which is now explicitly the prerequisite plan's job across four sites. Mitigations: sequence import-then-remove within a single change and verify the removal by setting `addons.delegates` by hand and confirming it is inert; land this plan last in the feature so both prerequisites are in place.

## Implementation

1. Replace `SHIPPED_TEAM_TYPES` (`kanban.html:4396`) with three entries: **Batch planners** (today's Planning team), **Coding** (today's Feature team, originally "Feature Implementation"), and **Multi-agent planning** (the fan-in investigator team). Drop **Solo coder** — it becomes the Phone-a-Friend control — and drop **Review team**, whose reviewer is already a member of Coding.
2. Give each shipped type a team prompt (per the team-prompt plan) rather than relying on per-member relationship rows for its instructions.
3. Import existing `addons.delegates` into team definitions per role: create a team where none claims that role; merge or skip where one does. Never overwrite an operator's team.
4. Remove the "Delegate children" editor from the Delegation subsection (`kanban.html:4282` onward — including the `terminalFleet === false` early-return branch, which renders its own disabled copy of the same editor).
5. Remove the role-config delegate read path (`bootstrap.ts:1168`, `TaskViewerProvider.ts:2488`) **after** step 3, so no install is left spawning from an invisible config.
6. Replace the Phone-a-Friend map editor with a single per-role toggle plus a target select. Keep the per-terminal override map behind an "advanced" disclosure — it is shipped state and stays editable. Preserve the `phoneAFriendTargets` materialisation behaviour at `kanban.html:4262-4266` (the config object must be created on the role config, not locally, or the first write throws).
7. Rename the subsection from "Delegation & Phone-a-Friend" to "Phone a friend", since delegation is now entirely teams.
8. Fix `PHONE_A_FRIEND_DIRECTIVE`'s stale "Agents tab" reference (`agentPromptBuilder.ts:674`).

## Proposed Changes

### `SHIPPED_TEAM_TYPES` — `src/webview/kanban.html:4396-4428`
- **Context:** Four types, one of which is not a team and one of which duplicates a member relationship.
- **Logic:** Three types matching the three real workflows.
- **Edge Cases:** An operator who already adopted "Solo coder" or "Review team" keeps their forked copy — `teamsTabGalleryCard`'s USE button forks the shipped definition into `agentsTabAgentGroups` as an independent row (`:4488-4495`), so the gallery ships definitions and does not own adopted ones. Verified: an adopted team survives a gallery edit untouched.

### Delegate-children retirement
- **Context:** A second spawner, silently overridden by teams, with no signal to the operator.
- **Logic:** Import into teams, delete the editor, then delete the read path.
- **Edge Cases:** Role already has a team; ordering (import before read-path removal) is load-bearing; both hosts' read paths must go, not just the standalone one.

### Phone-a-Friend control — `src/webview/kanban.html:4246-4281`
- **Context:** The per-terminal override map is exposed as the primary control.
- **Logic:** Toggle + target, with the map behind an advanced disclosure.
- **Edge Cases:** Existing map entries must survive and stay editable; the transport is untouched; keep the config-object materialisation that the current code comments call out as a past bug.

## Verification Plan

1. The gallery shows exactly three types: Batch planners, Coding, Multi-agent planning.
2. Both planning teams appear in the gallery and can be adopted — relying on the collision-rule narrowing delivered by `explicit-team-start-in-terminals-panel.md`, and confirming this plan's third type is reachable.
3. An install with `addons.delegates` configured on a role with no team gets a team created from it on upgrade, spawning the same members as before.
4. An install with `addons.delegates` on a role that already has a team keeps its team unchanged.
5. After migration, no spawn path reads `addons.delegates` — verified by setting the key by hand and confirming it has no effect on **both** hosts.
6. Phone-a-Friend still fires at batch end for a coder with the toggle on, using the existing `/phone-a-friend` endpoint.
7. An existing per-terminal Phone-a-Friend override still resolves after the UI change, and adding a first target on a role that has never had one does not throw.
8. The dispatched prompt no longer refers to the "Agents tab".
9. An operator's previously-adopted "Solo coder" or "Review team" is untouched by the gallery change.
10. `npx tsc --noEmit` introduces no new errors against the pre-existing baseline (5 `TS2835` errors at HEAD).

## Recommendation

Complexity 4 → **Send to Coder, last in the set**, after explicit team start and the team prompt land. The gallery edit is trivial; the delegate-children migration is the part that touches shipped user state and must be ordered import-then-remove, across both hosts.

## Completion Summary

Replaced the four-type gallery with three shipped team types (Batch planners, Coding, Multi-agent planning), each carrying a team prompt with `{child}` interpolation and the git-safety directive, and dropped Solo coder and Review team. Added `importDelegatesIntoTeams` in `teamWiring.ts` and wired it into `KanbanProvider._loadAgentGroups` to run BEFORE the migration converter — for each role with a non-empty `addons.delegates` and no existing team, a team is created from the delegate entries (never overwrites an operator's team). Then removed the `addons.delegates` read path on BOTH hosts: `bootstrap.ts` and `TaskViewerProvider.ts` now set `delegates: []` unconditionally, leaving team auto-start as the sole source. Removed the Delegate children editor (including the `terminalFleet === false` disabled branch) and the `agentsTabDelegateRow` function from `kanban.html`. Rebuilt the Phone-a-Friend control as a per-role toggle plus a default target select (writing a `'*'` key into `phoneAFriendTargets`), with the per-terminal override map behind an "Advanced" disclosure; preserved the `phoneAFriendTargets` config-object materialisation and added `'*'` default resolution in `_dispatchPhoneAFriend`. Renamed the subsection to "Phone a friend" and fixed `PHONE_A_FRIEND_DIRECTIVE`'s stale "Agents tab" reference to "TEAMS tab". Did not re-touch the head-role collision rule (already narrowed by the explicit-team-start subtask). **Review fix:** the initial implementation only ran the delegate import inside `_loadAgentGroups` (a UI path), so auto-start — which resolves teams via `findTeamForHeadRole`/`findTeamForHeadRoleInRoots` without calling `_loadAgentGroups` — would silently lose delegates on an upgraded install until a UI surface happened to load. Added a boot-time `kanbanProvider.listAgentGroups(workspaceRoot)` call on BOTH hosts: in `bootstrap.ts` after the server starts and before the autoban restore (which can dispatch terminals), and in `extension.ts` `activate()` after the deprecated-column migration and before activation returns. Both are awaited so the import completes before any terminal can be spawned; both catch failures so a bad role config never takes the host down. The `_loadAgentGroups` call remains in place — the import is idempotent, so a second run is harmless. Files changed: `src/webview/kanban.html`, `src/services/teamWiring.ts`, `src/services/KanbanProvider.ts`, `src/standalone/bootstrap.ts`, `src/services/TaskViewerProvider.ts`, `src/services/agentPromptBuilder.ts`, `src/extension.ts`. No compile or test commands were run per instructions.

## Review Findings

One MAJOR, fixed; it is shared with `team-prompt-replaces-pair-records.md` because it lives in this plan's `SHIPPED_TEAM_TYPES` edit — the three shipped prompts hand-copy `GIT_SAFETY_DIRECTIVE` and `AGENT_GROUP_CALLBACK_INSTRUCTION` with nothing pinning them, so the one guardrail an adopted team's coders get could drift invisibly; a mechanical parity test was added to `standing-orders-marker-contract.test.js` and mutation-tested. Everything else verified clean: the delegate read path is retired on both hosts (`bootstrap.ts:1222`, `TaskViewerProvider.ts:2597` set `delegates: []` unconditionally) with the import ordered before it and wired at boot on **both** hosts (`extension.ts:819-825`, `bootstrap.ts:2140-2144`) as well as in `_loadAgentGroups`; a repo-wide grep found **zero** orphaned references to `addons.delegates` or `agentsTabDelegateRow` outside comments. The import's role sweep was checked for completeness rather than assumed — `BUILTIN_ROLES` (`KanbanProvider.ts:4438-4442`) is byte-equal to `ROLE_KEYS` from `sharedDefaults.js`, which is exactly the set the removed editor's role dropdown offered, so no operator config is stranded. Phone-a-Friend's `'*'` default resolves between the per-terminal override and the workspace singleton with both documented compatibility fallbacks intact (`TaskViewerProvider.ts:5456-5478`), and the `phoneAFriendTargets` config-object materialisation is preserved (`kanban.html:4312-4313`). Files changed this pass: `src/test/standing-orders-marker-contract.test.js`; verification run independently — `standing-orders-marker` 30/30, `catalog:check`, `parity:check`, `push-routing:check`, `standalone-parity:check`, `mirror:check` all pass.
