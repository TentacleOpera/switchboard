# Start a Team Explicitly — Wire the Button That Already Exists

## Goal

Make starting a team an explicit, visible action in the terminals panel, instead of a side effect of picking a role in the "New terminal" picker. Wire the fully-built-but-uncalled `instantiateAgentGroup` path, and narrow the one-team-per-head-role rule so it constrains *auto*-start only.

### Problem analysis and root cause

**The operator looks for a "start team" button in the terminals panel and there isn't one. The code behind that button already exists and has never been called.**

Verified dead end-to-end:

- `TaskViewerProvider.instantiateAgentGroup` (`:11179`) — public, complete, resolves the workspace root, checks the PTY host, opens the DB, delegates to the shared core. **Zero callers.**
- `KanbanProvider._agentGroupInstantiator` (`:305`) — declared and assigned by `setAgentGroupInstantiator` (`:306`), which `bootstrap.ts:1866` registers for the standalone host. **Never invoked.** Grep returns the declaration and the setter, nothing else.
- `instantiateAgentGroupCore` (`agentGroupInstantiation.ts:69`) — the shared engine both hosts point at. Pre-flights all three caps *before* creating anything (specifically so an over-cap group cannot leave an orphan head running), creates head + delegates, wires the team. Reached only from those two unused entry points.

> **Superseded:** `TaskViewerProvider.instantiateAgentGroup` (`:11077`) … `bootstrap.ts:1851` registers for the standalone host.
> **Reason:** Line-number drift against the current tree.
> **Replaced with:** `instantiateAgentGroup` at `TaskViewerProvider.ts:11179`; `setAgentGroupInstantiator` registration at `bootstrap.ts:1866`. `KanbanProvider.ts:305/306` and `agentGroupInstantiation.ts:69` are unchanged and correct.

So the explicit path is finished and unwired, and the only way to start a team is the implicit one: `handlePtyVerb`'s auto-start (`bootstrap.ts:1183-1206`, and its extension-host twin at `TaskViewerProvider.ts:2539`) sees an unparented terminal whose role heads a team and injects `delegates: team.members`.

**Why that reads as confusing.** The terminals panel's spawn control is `buildRolePicker` (`terminals.js:6170`), titled **"New terminal — pick a role"**, listing roles. Choosing `Lead` when a Lead team exists spawns a head *and its members* — a control that says "new terminal" delivers five. Nothing in the picker indicates a team is involved, names the team, or lists what is about to start. The TEAMS tab even documents the behaviour as intentional — "A team starts when its head role starts — no instantiate button" — but that sentence lives in a different panel from the control it describes.

**Root cause of the head-role constraint.** Because starting a terminal is the *only* way to start a team, teams must be keyed by head role, so two teams cannot share one: `migrateAgentGroups` step 3 (`teamWiring.ts:215-258`) marks a colliding team `unassigned`, and an unassigned team never auto-starts. That is a sound rule for *auto*-start — a bare `lead` terminal must resolve to exactly one team. It is an arbitrary limit on *existence*. With an explicit start action, any number of teams can exist and be startable; the head role only decides which one auto-starts.

This removes the entire reason to mint a new head role (built-in or custom agent) for a second planning team.

**The collision rule is enforced in four places, not one.** This is the finding that turns the change from one edit into a sweep. Verified by reading each site:

| # | Site | What it does | Effect if left unchanged |
| :-- | :--- | :--- | :--- |
| 1 | `teamWiring.migrateAgentGroups` step 3 (`teamWiring.ts:245-257`) | Writes `unassigned: true` + `unassignedReason` onto the colliding team | The loser is flagged as broken |
| 2 | `findTeamForHeadRole` (`teamWiring.ts:328`) | Filters `&& !g.unassigned` before matching | Correct and must **stay** — this is the auto-start rule |
| 3 | `teamsTabRenderGallery` / `teamsTabGalleryCard` (`kanban.html:4452`, `:4464`, `:4478-4484`) | Builds `claimedRoles` from adopted teams; a card whose `headRole` is claimed renders the text *"head role claimed by X"* **and no USE button** | **The second planning team cannot be adopted at all** |
| 4 | `teamsTabShowGroupForm` (`kanban.html:4674-4679`) | Disables every head-role `<option>` whose role is claimed and appends `" (claimed)"` | The operator cannot author a second team on that head role by hand either |

Site 2 is the rule this plan *keeps*. Sites 1, 3 and 4 are the ones that must be narrowed. Sites 3 and 4 live in the TEAMS tab webview, so it is tempting to leave them to the gallery plan — but they are the *same rule*, and splitting one rule across two cards is how half of it ships. This plan owns all four.

> **Superseded:** Implementation step 5 named only `migrateAgentGroups`, and the gallery work in `teams-tab-three-presets-and-phone-a-friend.md` carried a verification step ("Both planning teams can be adopted and started") that no plan's implementation delivered.
> **Reason:** A cross-subtask audit found the collision rule enforced at four sites across two files. With only `migrateAgentGroups` narrowed, the two webview gates still hide the USE button and disable the dropdown option, so the second planning team remains unadoptable and the gallery plan's verification step fails with nothing in either plan to fix it.
> **Replaced with:** This plan owns the whole rule — all four sites — and the gallery plan depends on it rather than re-deriving it. See the reconciliation note in the feature file.

**Blast radius.** Additive. Auto-start behaviour is unchanged unless the operator opts out; `unassigned` teams become startable rather than inert.

## Metadata

**Complexity:** 4
**Tags:** ui, backend, feature

> **Superseded:** **Complexity:** 3
> **Reason:** The plan gained the two webview collision gates (`kanban.html:4452`, `:4674-4679`) moved in from the gallery plan. That is a second file, a second language, and a rule that must read identically in both — past a single-file 3.
> **Replaced with:** 4. Still "Send to Coder"; the routing does not change.

## User Review Required

None. Whether to keep implicit auto-start at all is answered below: keep it, but make it visible.

## Complexity Audit

### Routine

- Adding a route/verb that calls the existing `instantiateAgentGroup`.
- Rendering a team list in the terminals panel.

### Complex / Risky

- **The picker must stop lying.** If auto-start survives, a role that heads a team must say so *in the picker* — name the team and list what will spawn. A control labelled "New terminal" that starts five is the defect, and adding a separate team button without fixing the picker leaves it in place.
- **Two ways to start the same team must not double-spawn.** Explicit start on a team whose head role is already running, or auto-start firing while an explicit start is in flight, must reconcile — reuse the live head or refuse with a clear reason, never spawn a second head with a collision-counter name (which is also what generates the drifting terminal names behind the standing-orders leak).
- **Relaxing the collision rule touches migration.** `migrateAgentGroups` currently *writes* `unassigned: true` onto colliding teams. Narrowing the rule to auto-start means those flags stop meaning "broken" and start meaning "not the auto-start default". Existing rows carry the flag and its `unassignedReason` string; they must be reinterpreted, not orphaned.
- **The migration re-resolves collisions on every read, in both directions.** `migrateAgentGroups` (`teamWiring.ts:225-243`) also *clears* `unassigned` when the claimer disappears. So the flag is not a one-time stamp — it is recomputed on every read path that can trigger auto-start. Whatever replaces it must be equally idempotent and equally re-resolving, or a team flips state depending on read order.
- **The two webview gates must agree with the host rule.** `claimedRoles` (`kanban.html:4452`) is built in the webview from `agentsTabAgentGroups`, independently of `migrateAgentGroups`. Narrowing the host rule without narrowing these leaves the UI enforcing a constraint the backend no longer has — the classic split-brain where the API allows what the button refuses.
- **The standalone host registers its instantiator late.** `setAgentGroupInstantiator` runs at `bootstrap.ts:1866`, after `ptyFleetService` exists, and takes precedence over the TaskViewer arm. A start action firing before registration must fail with a real message, not a silent no-op.

## Edge-Case & Dependency Audit

**Race Conditions** — concurrent explicit starts of the same team, and explicit-vs-auto start. `spawnDelegates` already serialises shared-member reuse per name (`ptyFleetService.ts:475-485`); head creation has no such guard because nothing could previously start a team twice.

**Security** — the start action must be an authenticated verb like every other terminal-spawning route. Team definitions are operator-authored and host-resolved; the wire must not be able to supply a group definition, for the same reason `handlePtyVerb` overwrites caller-supplied `delegates` (`bootstrap.ts:1168`, with the comment naming the exact attack: every pty child is handed an API token).

**Side Effects** — teams that are currently `unassigned` and inert become startable. That is the intent, but it means definitions an operator wrote off as broken will now do something.

**Dependencies & Conflicts** — independent of the standing-orders work; both touch team startup but at different layers. Unblocks the three-preset gallery in `teams-tab-three-presets-and-phone-a-friend.md`, which needs two planning teams to coexist *and to be adoptable* — the latter now delivered here rather than assumed. **Shared file with the gallery plan:** both edit `src/webview/kanban.html`. Per the project's one-stream-per-file rule these two must serialise, and this plan lands first.

**Interaction with the standing-orders plan.** `instantiateAgentGroupCore` pre-flights three caps (`agentGroupInstantiation.ts:91-100`): `MAX_DELEGATES_PER_PARENT`, `MAX_LIVE_DELEGATE_PTYS`, and `MAX_ORDERS`. `standing-orders-scopes-and-decap.md` deletes the third. Whichever order the two land in, the surviving pre-flight is the two delegate caps — those are real fleet-resource limits and stay. Verification step 5 below therefore exercises a **delegate** cap, not the orders cap, so it does not go stale when the orders cap is removed.

## Dependencies

None.

## Adversarial Synthesis

**Risk summary.** The engine is written and unreachable, so the wiring itself is low-risk; the risk is everywhere *around* it. Three concerns dominate: a split-brain where the host allows two teams per head role but the webview's independently-computed `claimedRoles` still hides the USE button; a double-spawn when explicit start races auto-start on a head role that is already live; and a migration flag (`unassigned`) whose meaning changes from "broken" to "not the auto-start default" while existing rows still carry the old wording. Mitigations: own all four collision-rule sites in one change, reconcile double-start by reusing or refusing (never by spawning a second collision-counter head), and reword `unassignedReason` in the same pass that reinterprets it.

## Implementation

1. Add an authenticated verb that starts a team by id, calling the existing `instantiateAgentGroup` / registered instantiator. Host-resolve the definition from `terminals.agentGroups` — never accept one from the wire.
2. Surface teams in the terminals panel next to `buildRolePicker` (`terminals.js:6170`): one entry per defined team, labelled with the team name and what it spawns (`lead + 3× coder + shared reviewer`), with a START action.
3. Make auto-start honest in the picker: a role that heads a team shows the team name and its member list on that option, so "New terminal — Lead" never silently produces five terminals.
4. Reconcile double-start: if the team's head role is already live, reuse it or refuse with a specific message; never spawn a second head under a collision-counter name.
5. Narrow the collision rule to auto-start **at all four enforcement sites**:
   - `teamWiring.migrateAgentGroups` step 3 (`teamWiring.ts:245-257`) — keep recording which team owns the head role, but reword the flag so it reads as "not the auto-start default", not "broken". Keep the re-resolution branch at `:225-243` working in both directions.
   - `findTeamForHeadRole` (`teamWiring.ts:328`) — **leave the `!g.unassigned` filter in place.** This is the auto-start rule and it is correct.
   - `teamsTabRenderGallery` / `teamsTabGalleryCard` (`kanban.html:4452`, `:4464`, `:4478-4484`) — a claimed head role no longer suppresses the USE button. Keep the informational note ("also headed by X, auto-start goes to X") so the operator still learns which team wins auto-start.
   - `teamsTabShowGroupForm` (`kanban.html:4674-4679`) — stop disabling claimed head-role options; keep the `" (claimed)"` suffix as information.
6. Surface start failures verbatim — the cap and PTY-unavailable errors `instantiateAgentGroupCore` already returns (`agentGroupInstantiation.ts:92-100`) are good messages that currently reach nobody.

## Proposed Changes

### Team start verb
- **Context:** `instantiateAgentGroup` (`TaskViewerProvider.ts:11179`) and the registered instantiator (`KanbanProvider.ts:305`) are complete and uncalled.
- **Logic:** An authenticated verb that resolves the team host-side and starts it.
- **Edge Cases:** Standalone registers its instantiator late (`bootstrap.ts:1866`); wire-supplied definitions must be rejected.

### Terminals-panel team list — `src/webview/terminals.js`
- **Context:** The operator looks here for a start button; `buildRolePicker` (`:6170`) only offers roles.
- **Logic:** Render defined teams with a START action and a plain-language summary of what spawns.
- **Edge Cases:** No teams defined; a team whose head role is already running.

### Honest role picker — `src/webview/terminals.js`
- **Context:** "New terminal — pick a role" can spawn a whole team with no indication.
- **Logic:** Annotate role options that head a team.
- **Edge Cases:** Must reflect the live definition, not a stale copy — editing a team changes the next start.

### Auto-start-only collision rule — `src/services/teamWiring.ts` + `src/webview/kanban.html`
- **Context:** Four enforcement sites (table above). `migrateAgentGroups` marks colliding teams `unassigned`; the gallery hides their USE button; the form disables their head-role option.
- **Logic:** Collision decides the auto-start default only; all teams stay adoptable, editable and explicitly startable.
- **Edge Cases:** Existing `unassigned`/`unassignedReason` rows must be reinterpreted, not dropped; the re-resolution branch must keep clearing the flag when a claimer disappears; the webview gates must not re-impose the rule the host just dropped.

## Verification Plan

1. A START action on a team spawns its head and members — the first time `instantiateAgentGroup` is ever executed.
2. Two teams sharing a head role both exist and can both be started explicitly; exactly one of them auto-starts on a bare head-role terminal.
3. **Both gallery cards for a claimed head role still offer USE** — the webview gate no longer suppresses it — and the head-role dropdown in the team form still offers the claimed role, marked `(claimed)` but selectable.
4. Picking a team-heading role in the role picker shows the team name and member list *before* spawning.
5. Starting a team whose head is already live does not create a second head with a collision-counter name.
6. A start that exceeds `MAX_DELEGATES_PER_PARENT`, or one attempted with the PTY host unavailable, surfaces `instantiateAgentGroupCore`'s existing error text to the operator instead of failing silently.
7. An install with an existing `unassigned: true` team can start it explicitly after upgrade, and its `unassignedReason` reads as "not the auto-start default" rather than as a fault.
8. Deleting the claiming team clears the other team's `unassigned` flag on the next read — the re-resolution branch still works in both directions.
9. Auto-start still works unchanged for the single-team-per-role case — the `[bootstrap] Team auto-start:` log line is unchanged.
10. The start verb rejects a group definition supplied over the wire.
11. `npx tsc --noEmit` introduces no new errors against the pre-existing baseline (5 `TS2835` errors at HEAD).

## Recommendation

Complexity 4 → **Send to Coder, second in the set** (after the DELEGATE PARENT gate fix, which is smaller and unblocks nothing). The engine is written, tested by construction and unreachable; this is wiring, honest labelling, and one rule narrowed consistently across four sites. It removes the need for a new head role for the second planning team, so it must land before the gallery work.

## Completion Summary

Implemented the explicit team-start path and narrowed the head-role collision rule to auto-start-only across all four enforcement sites. Added two authenticated terminal verbs: `ptyStartTeam` (starts a team by id via the previously-uncalled `instantiateAgentGroup`/registered instantiator, host-resolving the definition and rejecting wire-supplied groups) and `ptyListAgentGroups` (read-only team definitions for the picker). In `teamWiring.ts` added `resolveTeamById`/`startTeamById` (the latter reconciles double-start by refusing if the head role is already live, never spawning a second collision-counter head) and reworded `migrateAgentGroups` step 3's `unassignedReason` to read as "not the auto-start default" rather than a fault; `findTeamForHeadRole`'s `!g.unassigned` filter was left intact as the auto-start rule. In `terminals.js` the role picker now renders a "Start a team" section (one START action per defined team, including unassigned ones) and annotates role options that head a team with the team name and spawn summary; start failures surface verbatim via toast. In `kanban.html` the gallery USE button is no longer suppressed for a claimed head role (informational "auto-start goes to X" note kept), the team-form head-role dropdown no longer disables claimed options (" (claimed)" suffix kept), and the unassigned row display was reworded and de-alarmed (muted, not red). Files changed: `src/services/teamWiring.ts`, `src/services/KanbanProvider.ts`, `src/standalone/bootstrap.ts`, `src/services/TaskViewerProvider.ts`, `src/webview/terminals.js`, `src/webview/terminals.html`, `src/webview/kanban.html`. Did not touch `wireSpawnedTeam`, `SHIPPED_TEAM_TYPES`, or re-add `MAX_ORDERS`/its pre-flight (standing-orders subtask already removed it). No compile or test commands were run per instructions.

## Review Findings

Reviewed against the plan; no CRITICAL or MAJOR findings, no code changes applied. All four collision-rule sites were verified narrowed as this plan claims ownership of: `migrateAgentGroups` step 3 rewords rather than faults (`teamWiring.ts:258`, `:273`) and keeps the two-way re-resolution branch (`:245-264`); `findTeamForHeadRole`'s `!g.unassigned` filter is intact as the auto-start rule (`:426`); `teamsTabGalleryCard` renders USE unconditionally with the informational auto-start note retained (`kanban.html:4536-4566`); and `teamsTabShowGroupForm` keeps the `" (claimed)"` suffix without disabling the option (`:4742-4747`). Both hosts wire `ptyStartTeam`/`ptyListAgentGroups` with the wire-supplied-group rejection intact (`TaskViewerProvider.ts:2542`, `bootstrap.ts:1174`), `startTeamById` refuses a double-start rather than minting a collision-counter head (`teamWiring.ts:535-542`), and `KanbanProvider.startAgentGroupById` returns a real message when the instantiator is not yet registered (`:4497-4499`) — the late-registration edge the plan flagged. Verification run independently this pass: `npx tsc --noEmit` clean for these files; `team-autostart-scope` 8/8, `pty-route-surface`, `pty-host-gating`, `catalog:check` and `parity:check` all pass.
