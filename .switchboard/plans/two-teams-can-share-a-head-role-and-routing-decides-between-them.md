# Two Teams Can Share a Head Role, and Routing Decides Between Them

## Goal

Let more than one team claim the same head role, and give dispatch a real rule for choosing between
them: the mission's runsheet, then worktree affinity, then whichever team is free, then a nominated
default. Today a second `lead` team is silently demoted, hidden from the UI, and unreachable.

### Problem analysis

**A head role is currently exclusive to one team, and the exclusivity exists to serve a lookup.**

> **Superseded:** `migrateAgentGroups` (`teamWiring.ts:895-930`) resolves head-role collisions: the first team in **stored order** keeps the role, every later one is marked `unassigned: true`. The rule exists because dispatch resolves a team *by role* — `findTeamForHeadRoleInRoots(roots, db, normalizedRole)` at `TaskViewerProvider.ts:12252` — and that lookup must return exactly one team.
> **Reason:** Two errors. (1) `findTeamForHeadRoleInRoots` has exactly one caller — `_selectAutobanTerminal` (TaskViewerProvider.ts:12260) — and that function is **orphaned dead code with no callers** (confirmed by prior plan `lead-paced-pipeline-4-delete-the-mode-axis-and-hybrid`: "_selectAutobanTerminal is now orphaned dead code with no callers"). The by-role team lookup is dead in every live path. (2) Live dispatch does not resolve a *team* by role at all. The queue-pop path (`dispatchNextFromQueue` → `_runQueuePop`, LocalApiServer) is team-scoped via `resolveTeamRoleTerminal` keyed on a `from` head terminal, and that head terminal is chosen by `resolveCodingHeadFromGroups` (KanbanProvider.ts:5554), which returns `leads[0]` — the first live lead terminal, arbitrarily. So the "winner is arbitrary" problem is real, but the mechanism is `resolveCodingHeadFromGroups` returning `leads[0]`, not `findTeamForHeadRoleInRoots` returning the first team by stored order.
> **Replaced with:** The exclusivity is enforced by `migrateAgentGroups` (teamWiring.ts:984-1033) marking colliding teams `unassigned: true`, but the only live reader of that flag is `resolveDefinitionForGroup`'s role-match fallback (teamWiring.ts:1340) and the UI note — the dispatch path that allegedly required it is dead. The real team-selection site is `resolveCodingHeadFromGroups` (KanbanProvider.ts:5554) and its fallback `getAliveCodingTerminalNames()[0]` (KanbanProvider.ts:13221), which pick one live lead terminal to pass as `from` to `dispatchNextFromQueue`. The ladder belongs there.

So this is not a rule about teams. It is a **data-model constraint imposed by a by-role lookup**, and
it fails in two ways:

1. **The winner is arbitrary.** "First in stored order" means which team receives dispatched work
   depends on array insertion order, not on anything the operator chose. (The arbitrariness now
   lives at `resolveCodingHeadFromGroups` returning `leads[0]`, but the failure mode is the same.)
2. **The loser disappears.** The `unassigned` flag's own comment says an unassigned team is *"visible,
   editable, explicitly startable, and does not auto-start — the flag means 'not the auto-start
   default', not 'broken'."*

> **Superseded:** The first word is false: the Teams UI filters unassigned teams out.
> **Reason:** Not accurate against current code. The Teams gallery renders unassigned teams with a muted note — `teamsTabRenderGallery` maps `agentsTabAgentGroups` with no `unassigned` filter (kanban.html:5311) and emits an explicit note for adopted unassigned teams (kanban.html:5377-5382, duplicated at 5710-5717). `peekAgentGroups`/`listAgentGroups` (KanbanProvider.ts:5077/5058) return all groups with no unassigned filter. The unassigned team is visible and deletable in the gallery. The real residual gap is that the `unassigned` flag is *nearly dead* (read only by dead `findTeamForHeadRole` and `resolveDefinitionForGroup`'s role-match fallback), so it no longer means what its comment claims.
> **Replaced with:** The UI already shows unassigned teams. The live bug that stranded the operator is not "UI hides the team" — it is that `startTeamsOnLoad` (TaskViewerProvider.ts:13958) starts every team with `startOnLoad === true` via `listTeamsInRoots`, which does **not** filter `unassigned`, so an unassigned team with `startOnLoad` (or restored by autoban) still starts. The flag does not gate start-on-load. Change #2 below becomes a regression guard, not a bugfix; the start-on-load bypass is named in Change #6.

**Observed 2026-09-09.** A `Coding` team (the operator's, 2 members) and the shipped `Lead team`
preset both carry `headRole: lead`. `Lead team` was flagged `unassigned: true`, vanished from the
Teams UI, and still started — producing a live `lc-lead-team-team` tmux session for a team the
operator could not see, had never wanted, and had no way to delete. It was removed over the API.
That is the state the design explicitly rules out: not the auto-start default, yet running.

> **Superseded:** ...vanished from the Teams UI, and still started...
> **Reason:** The "vanished from the Teams UI" observation is not reproducible against current code (the gallery renders unassigned teams with a note — see the callout above). The "still started" half is real and explained by `startTeamsOnLoad` ignoring the `unassigned` flag (Change #6). The operator's report is preserved as the triggering incident; the mechanism is corrected here so the fix targets the live cause.
> **Replaced with:** The unwanted `Lead team` seed started because `startTeamsOnLoad` / autoban-restore do not consult `unassigned`, not because dispatch routed to it. The fix is to stop demoting colliding teams (Change #1) and make start-on-load respect the routing decision / operator intent (Change #6).

#### Why project scope alone does not answer it

Dispatch already threads `initiatorProject`, and `_projectTier()` / `getScopedRoleConfig()`
(`KanbanProvider.ts:751-790`) already resolve *role config* per project. Reusing that for team
selection is tempting and insufficient: two coding teams frequently live in the **same** project,
split across two worktrees set up by a mission. Project cannot tell them apart.

### The routing ladder

Most specific first. Each rung only runs when the one above it does not decide.

| # | Rung | Signal | Why |
| :-- | :--- | :--- | :--- |
| 1 | **Mission runsheet** | `missions.team` (column on the `missions` table, already read at dispatch in `command.js:1802`) | A mission that names its team is an explicit operator decision; it must be authoritative, not advisory. |
| 2 | **Worktree affinity** | `plans.worktree_id` | This is what distinguishes two teams inside one project: they are told apart by *where their work lives*. Self-maintaining — the worktree assignment already made the choice. |
| 3 | **Whichever team is free** | `dispatched_at` set, `completed_at` null | Self-balancing and needs no configuration. The right default for an operator who just has two teams. |
| 4 | **Nominated default for the scope** | project → workspace → global, as role config already resolves | Deterministic tiebreak; replaces "first in stored order". |

> **Superseded:** Rung 1 signal was `mission_members` (`mission_id`, `member_id`, `member_kind`).
> **Reason:** `mission_members.member_kind` is typed `'plan' | 'feature'` everywhere — `addMissionMember(missionId, memberId, kind: 'plan' | 'feature' = 'plan')` (KanbanDatabase.ts:13248) and `getMissionMembers` returns `Array<{ memberId; kind: 'plan' | 'feature' }>` (KanbanDatabase.ts:13317), collapsing anything non-`'feature'` to `'plan'`. There is no `'team'` kind, and `UNIQUE(member_id)` means a member belongs to one mission and is a plan/feature. Rung 1 as written could never fire — no team is ever a mission member — so the ladder would pass its own success check while rung 1 silently matched nothing.
> **Replaced with:** `missions.team` — a `TEXT DEFAULT ''` column on the `missions` table (KanbanDatabase.ts:795, read at 12986/13102, written at 13200/13237), already consulted at dispatch time (`resolveLaunchOriginSeat`, command.js:1802: `activeMission?.team`). No schema change or migration is required for rung 1; the card's mission id must be threaded to the head-resolution site so `missions.team` can be read.

#### "Free" is team-level, and must be asserted

**A team is busy when ANY member holds a row with `dispatched_at` set and `completed_at` null.**

Team-level, not seat-level, and the reason is concrete: a team commits once, as its head. Dispatching
into a team whose lead is mid-review means the lead cannot triage the result and the commit is
disturbed — the exact failure the review structure exists to prevent. A team with two idle coders and
a busy lead is **busy**.

**Never infer freedom from silence.** Not "the seat looks quiet", not "the card sits in a coding
column", not an mtime. This board's standing contract is that completion is asserted and never
inferred, and the stall-nudge work on 2026-09-08 is a live example of what timestamp-derived liveness
costs. A router that computes "free" from silence will hand a second batch to a team mid-task.

**When nobody is free**, queue against the rung-4 default team rather than picking arbitrarily or
refusing. The board is already a queue; this needs no new concept.

**The crashed-seat caveat (named deliverable, not a footnote).** A member whose terminal has exited
but whose row was never marked `completed_at` would pin its team busy forever under the literal
predicate. The mitigation is a **stale-dispatch sweep** that reconciles in-flight dispatch rows
against the live fleet (a seat whose terminal is `exited` and was never completed is not busy), run
before the router consults the predicate. This is scoped as a reconciliation against the fleet, NOT a
widening of the `isTeamBusy` predicate — the predicate stays "dispatched_at set, completed_at null";
the sweep corrects the rows the predicate reads. See Change #4.

## Metadata

**Complexity:** 7
**Tags:** backend, ui, feature, refactor
**Dependencies:** none

> **Complexity raised from 6.** The original 6 understated the work: the ladder must be inserted at `resolveCodingHeadFromGroups` (KanbanProvider.ts:5554), which today takes only `workspaceRoot`. Threading card context (mission id, worktree id, project) to that site means widening a signature shared by `runQueue` (KanbanProvider.ts:13216), `_scheduleQueuePop` (TaskViewerProvider.ts:28877/29002), the autoban/queue-watch arm (KanbanProvider.ts:2744/8964), `stageForQueue`, and the `setQueueHeadResolver` seam (extension.ts:1055, bootstrap.ts:2040/3922). Multi-file signature threading + a new fleet-reconciliation sweep + a per-role default store = High.

## User Review Required

Yes — see **Outstanding Questions**. The plan's original root-cause analysis cited a dead dispatch
path (`findTeamForHeadRoleInRoots`); the live team-selection site is `resolveCodingHeadFromGroups`.
The reframe is required for the plan to route anything, but it changes the primary edit site, so the
operator should confirm the reframe before coding begins.

## Complexity Audit

### Routine
- Removing the head-role collision demotion in `migrateAgentGroups` (teamWiring.ts:984-1033): delete the `seenHeadRoles` collision pass. Localized, reuses the existing converter shape.
- Clearing existing `unassigned: true` rows on load (or simply no longer setting them): one converter step, idempotent.
- Reading `missions.team` for rung 1: the column exists and is already read at dispatch; a new read at the head-resolution site is a one-liner once the mission id is threaded.
- Rendering the per-role nominated-default dropdown in the Teams UI: mirrors the existing `getScopedRoleConfig` tiering and the existing role-picker dropdown patterns.

### Complex / Risky
- **Threading card context (mission id, worktree id, project) into `resolveCodingHeadFromGroups`.** Today it takes only `workspaceRoot`; every caller (`runQueue`, `_scheduleQueuePop`, autoban, `stageForQueue`, `setQueueHeadResolver`) must pass the card context. A missed caller silently routes via the old `leads[0]` arbitrary pick — a green-metric-over-real-goal gap.
- **The stale-dispatch sweep.** Reconciling in-flight `dispatched_at`/`completed_at` rows against the live fleet is a new liveness-reconciliation subsystem. It races the very completion assertion the predicate relies on; getting the ordering wrong (sweep clobbers a genuine in-flight row) re-introduces the silence-inference failure.
- **`startOnLoad` / autoban-restore respecting routing.** `startTeamsOnLoad` (TaskViewerProvider.ts:13958) starts every `startOnLoad` team blindly via `listTeamsInRoots` (no `unassigned` filter). Two lead teams both marked `startOnLoad` both spawn; the ladder then routes between live heads but the unwanted team still ran. Deciding which team auto-starts when two share a head role is a new policy decision.
- **`resolveDefinitionForGroup` role-match fallback** (teamWiring.ts:1340) reads `!def.unassigned`. If the demotion is removed and the flag is cleared, the fallback's uniqueness demand (`matches.length === 1`) now sees two definitions for the same role and returns `null` — already-running legacy teams lose their definition link until next spawn. Acceptable (the exact `definitionId` path is preferred), but must be confirmed not to break live-team standing-orders reads.

## Edge-Case & Dependency Audit

**Race Conditions**
- Two batches dispatched concurrently both consult the ladder; without coordination both can pick the same "free" team and double-dispatch into a lead mid-task. The queue is already a single serialized pop chain (`_queueNextChain`, LocalApiServer.ts:73), so the ladder's read must happen *inside* the serialized pop, not before it, or the "free" decision is stale by the time the pop commits.
- The stale-dispatch sweep must not run concurrently with a completion write that flips `completed_at` from null to set; ordering the sweep before the predicate read (still inside the pop chain) avoids clobbering a genuine completion.

**Security**
- No new trust boundaries. The nominated-default store is operator-authored config in the same tiered store role config uses; no untrusted input reaches the router.

**Side Effects**
- Removing the demotion changes `migrateAgentGroups` from "returns null when nothing changed" to "returns the array when unassigned flags are cleared" — every load that holds legacy `unassigned: true` rows now triggers a write-back. Confirm the write chain (`_agentGroupsWriteChain`) tolerates the one-time extra write on upgraded installs.
- Clearing `unassigned` on already-running teams: `resolveDefinitionForGroup`'s role-match fallback returns `null` for a now-ambiguous role (two definitions, neither unassigned). Live teams keep running; standing-orders reads that hit the fallback return the default. Non-fatal, but a behavior change for upgraded installs with live collision-loser teams.

**Dependencies & Conflicts**
- `resolveCodingHeadFromGroups` is shared by `runQueue`, `_scheduleQueuePop`, autoban/queue-watch, `stageForQueue`, and `setQueueHeadResolver` (extension.ts:1055, bootstrap.ts:2040/3922). Widening its signature touches all of them; a contract test (`queue-pipeline-contract.test.js`) asserts its name at multiple sites — retarget after the signature change.
- `missions.team` is read by `resolveLaunchOriginSeat` (command.js:1802) and written by `upsertMission` (KanbanDatabase.ts:13200). The ladder's rung-1 read is additive (a new reader), no conflict with the existing writer.
- `getScopedRoleConfig` (KanbanProvider.ts:757) is the tiering model the nominated-default store mirrors; reuse its `project → workspace → global` resolution rather than forking a second tier resolver.

## Dependencies

- None.

## Adversarial Synthesis

Key risks: (1) the ladder was originally targeted at a dead dispatch path (`findTeamForHeadRoleInRoots` / `_selectAutobanTerminal`) — it must move to the live team-selection site `resolveCodingHeadFromGroups` or it routes nothing; (2) rung 1 cited `mission_members` (plan/feature members only) and would never fire — corrected to the existing `missions.team` column; (3) the `isTeamBusy` predicate is unsafe without a stale-dispatch sweep that reconciles crashed seats against the live fleet, and that sweep is a new liveness subsystem, not a footnote; (4) `startTeamsOnLoad` ignores `unassigned`, which is the actual cause of the operator's "still started" incident. Mitigations: insert the ladder inside the serialized queue pop; read `missions.team` for rung 1 with no schema change; ship the sweep as a named deliverable scoped to fleet reconciliation; make start-on-load respect the routing decision (Change #6).

## Proposed Changes

### 1. Stop demoting a colliding team (`src/services/teamWiring.ts:984-1033`)

- **Logic:** Remove the automatic first-in-stored-order collision resolution (the `seenHeadRoles` pass in `migrateAgentGroups`). Two teams may share a head role; the ladder decides between them at dispatch time. Stop *setting* the flag rather than clearing-on-load a flag nothing reads.
- **Edge cases:** Existing installs carry `unassigned: true` rows. Add a one-time converter step that clears `unassigned`/`unassignedReason` from every group (sets `changed = true` so the write-back fires once on upgrade). Confirm `resolveDefinitionForGroup`'s role-match fallback (teamWiring.ts:1340) degrades gracefully when two definitions share a role (returns `null`; the `definitionId` exact path is preferred and unaffected).

### 2. Keep the Teams UI showing every team (regression guard, not a bugfix)

- **Logic:** The gallery already renders unassigned teams with a note (kanban.html:5311, 5377-5382, 5710-5717) and `peekAgentGroups`/`listAgentGroups` do not filter `unassigned`. With Change #1 the flag is gone, so this is now a regression guard: assert (in a contract test) that no future filter hides a team that remains startable. A hidden startable team is unmanageable by construction: the only surface that could delete it would filter it out.
- **Rationale:** The original premise ("the Teams UI filters unassigned teams out") is not accurate against current code; the invariant is still worth pinning so the flag's removal cannot be quietly re-introduced as a hide filter.

### 3. Replace the arbitrary head pick with the ladder (`src/services/KanbanProvider.ts:5554` and the queue-pop `from` resolution)

> **Superseded:** Replace the by-role lookup with the ladder (`TaskViewerProvider.ts:12252` and its standalone twin). `findTeamForHeadRoleInRoots` returns one team by role. Replace with a resolver that takes the card (mission, worktree, project) plus the role and walks rungs 1-4. One resolver, called from both hosts. `resolveTeamById` already exists for the explicit case; the by-role path is the legacy one and is what dictates the current model.
> **Reason:** `findTeamForHeadRoleInRoots` is dead code (only caller is the orphaned `_selectAutobanTerminal`); there is no "standalone twin" — both hosts share `TaskViewerProvider`. Live dispatch does not resolve a team by role; it resolves a *terminal* by role+worktree, and the team is chosen by which head terminal is passed as `from` to `dispatchNextFromQueue`. That head terminal is picked by `resolveCodingHeadFromGroups` returning `leads[0]`.
> **Replaced with:** Insert the ladder at `resolveCodingHeadFromGroups` (KanbanProvider.ts:5554) and its fallback `getAliveCodingTerminalNames()[0]` (KanbanProvider.ts:13221). Widen the resolver to take the card context — `{ workspaceRoot, missionId?, worktreeId?, project? }` — and walk rungs 1-4 to pick the head terminal that becomes `from`:

- **Logic:** `resolveCodingHeadForCard(ctx)` walks: (1) `missions.team` for the card's mission id → that team's live head terminal; (2) the team whose worktree matches the card's `worktree_id` → its live head; (3) a team whose roster has no member with `dispatched_at` set and `completed_at` null (Change #4); (4) the nominated default for the role at the card's project tier (Change #5). Falls back to today's `leads[0]` only when no rung decides AND no default is nominated (preserving single-team-board behaviour exactly).
- **Implementation:** One resolver, called from every site that currently calls `resolveCodingHeadFromGroups` for a dispatch: `runQueue` (KanbanProvider.ts:13216), `_scheduleQueuePop` (TaskViewerProvider.ts:28877/29002), the autoban/queue-watch arm (KanbanProvider.ts:2744/8964), and the `setQueueHeadResolver` seam (extension.ts:1055, bootstrap.ts:2040/3922). The non-dispatch callers (liveness checks, `stageForQueue` arming) keep the existing `resolveCodingHeadFromGroups(workspaceRoot)` signature — do not thread card context into reads that do not dispatch.
- **Edge cases:** One team for a role — every rung falls through to it, so a single-team board needs no configuration and behaves exactly as today. A mission whose `team` names a deleted/non-live team falls through to rung 2. The ladder's read must execute inside the serialized `_queueNextChain` pop so two concurrent batches cannot both see the same "free" team.

### 4. A team-busy predicate with one definition, plus a stale-dispatch sweep

- **Logic:** `isTeamBusy(team)` = any member has `dispatched_at` set and `completed_at` null. One implementation, used by the router (Change #3, rung 3) and by anything else that asks.
- **Stale-dispatch sweep (named deliverable):** before the router consults the predicate, reconcile in-flight dispatch rows against the live fleet — a seat whose terminal is `exited` and whose row was never `completed_at` is not busy; clear the stale `dispatched_at` (or mark the row completed-with-note) so it stops pinning the team. Scoped to fleet reconciliation; the predicate itself is not widened.
- **Edge cases:** A member whose seat has exited but whose row was never completed must not pin a team busy forever — the sweep is the mitigation. The sweep must not clobber a genuine in-flight row whose terminal is briefly unresponsive; reconcile on `status === 'exited'` only, not on silence.

### 5. Nominate a default per role, per scope (Teams UI + tiered store)

- **Logic:** A per-role dropdown — "lead work in this project goes to → Coding" — resolving project → workspace → global, the same tiering `getScopedRoleConfig` (KanbanProvider.ts:757) uses. Reuse that tier resolver; do not fork a second one.
- **Edge cases:** The nominated team being deleted falls back to the next tier, never to insertion order. A nominated team that is not live falls through to rung 3 (free team) before refusing.

### 6. Make start-on-load respect the routing decision (`src/services/TaskViewerProvider.ts:13958`)

- **Logic:** `startTeamsOnLoad` starts every team with `startOnLoad === true` via `listTeamsInRoots`, which does not filter `unassigned` and has no concept of head-role collision. When two teams share a head role and both carry `startOnLoad`, both spawn — the unwanted team still runs (the operator's 2026-09-09 incident). Decide which team auto-starts when two share a head role: the rung-4 nominated default starts on load; a non-default team with the same head role does not auto-start (it remains explicitly startable). This is the actual fix for "the demoted team still started."
- **Edge cases:** An operator who genuinely wants two lead teams both auto-starting (rare) can nominate both at different scopes (project vs workspace); the same-head-role-same-scope collision keeps exactly one auto-start. Preserve today's behaviour for single-team boards.

## Verification Plan

### Automated Tests
- Two teams with `headRole: lead` both load, both appear in the UI, neither is flagged `unassigned`.
- A card carrying a mission whose `missions.team` names a team routes there regardless of the other rungs (rung 1 reads `missions.team`, not `mission_members`).
- A card in a worktree a team is working routes to that team.
- With no mission and no worktree, a batch goes to the team with no outstanding dispatch.
- A team with idle coders and a lead holding an uncompleted dispatch counts as **busy**.
- With both teams busy, work queues against the nominated default.
- One team for a role: routing is unchanged from today (`resolveCodingHeadForCard` falls through to `leads[0]`).
- A crashed seat (terminal `exited`, `completed_at` null) is reconciled by the stale-dispatch sweep and does not pin its team busy.
- Two lead teams both marked `startOnLoad`: only the nominated default auto-starts; the other is explicitly startable but does not auto-start.
- Contract: `resolveCodingHeadFromGroups` signature change does not break `queue-pipeline-contract.test.js` (retarget the assertion after the widening).
- Regression guard: no UI filter hides a team that remains startable (pin via a contract test against `teamsTabRenderGallery` / `peekAgentGroups`).

### Goal Invariants
- No team is ever hidden from the Teams UI while remaining startable.
- Team choice never depends on stored order (assert `resolveCodingHeadForCard` does not read array index 0 when a higher rung decides).
- "Free" is derived only from an asserted completion, never from silence, column or mtime (assert `isTeamBusy` reads `dispatched_at`/`completed_at` only; assert no `status`/`kanban_column`/mtime read feeds the predicate).
- Rung 1 is resolvable: a mission with `missions.team` set routes to that team (positive); a mission with `missions.team = ''` falls through to rung 2 (negative — rung 1 does not fire on empty).
- The ladder routes nothing if inserted at the dead `findTeamForHeadRoleInRoots`: assert `resolveCodingHeadForCard` is the function `runQueue`/`_scheduleQueuePop` call, and that `findTeamForHeadRoleInRoots` has no live dispatch caller (negative invariant — the dead path is not the routing path).

### Manual
- Define two lead-headed teams in one project on two worktrees; dispatch a batch and confirm it lands
  on the worktree's team, then a second batch and confirm it lands on the free one.
- Mark a second lead team `startOnLoad` alongside the nominated default; reload the host and confirm only the default auto-starts.

## Operator Resolutions (2026-09-09, verified against code)

**1. The reframe onto `resolveCodingHeadFromGroups` — CONFIRMED.** Verified: `findTeamForHeadRoleInRoots`
has exactly one call site, `TaskViewerProvider.ts:12269`, inside `_selectAutobanTerminal` (defined
:12260) — and `_selectAutobanTerminal` has **no callers at all** (the only other mention is a comment
at `KanbanProvider.ts:13491`). It is dead code reached only from dead code. The live demotion is
`KanbanProvider.ts:5554`, `if (leads.length > 0) return leads[0]`.

> **Additional requirement the plan must state:** `resolveCodingHeadFromGroups` has **three live
> callers** — `KanbanProvider.ts:2744`, `:8964`, `:13216`. The ladder must be threaded through all
> three, or routing becomes path-dependent and the same two teams resolve differently depending on
> which site dispatched.

**2. `missions.team` as rung 1's signal — CONFIRMED, and stronger than the plan claims.** The column
exists (`KanbanDatabase.ts:795`, `team TEXT DEFAULT ''`), and `command.js:1802` already performs
rung 1 end to end: read `activeMission.team`, match it against `teamRoster` by id or name, resolve
that team's head. So rung 1 is not new behaviour — it is making dispatch agree with what the command
surface already does.

> The dismissal of `mission_members` also holds, for a blunter reason than the plan gives: the read
> path coerces. `KanbanDatabase.ts:13324` is
> `kind: (String(r.member_kind) === 'feature' ? 'feature' : 'plan')` — anything not `'feature'` reads
> back as `'plan'`. That table **cannot** carry a team reference without a read-path change, so it is
> closed as a carrier, not merely unpreferred. (`kind: 'team'` in the codebase is
> `PipelineDefinition.ts`, an unrelated union.)

**3. `startOnLoad` policy — DO NOT adopt the plan's proposal.** Change #6 proposes that only the
rung-4 nominated default auto-starts. Rejected: it makes the *last* rung the only one that can bring a
team up, so the ladder's priority order and its start behaviour disagree — a mission naming team B
still gets team A at boot, and B starts only once something dispatches to it. It also reinstates the
single-winner assumption (`leads[0]`) that this plan exists to remove, one layer up.

**SUPERSEDED — auto-start is being deleted.** See `teams-start-when-a-card-needs-them-not-at-boot`.
Question 3 asked what should auto-start when two teams share a head role; the operator's answer is
that nothing should: teams are started by the operator or by the controller agent (`ptyStartTeam`),
never because the host came up. So this plan needs no `startOnLoad` policy at all — the ladder routes
among whatever heads are live, and what is live is someone's explicit decision.

For the record, the reason the original recommendation here (auto-start every marked team) was wrong:
nothing consults `MemAvailable` before spawning, `MAX_LIVE_DELEGATE_PTYS = 32` permits ~8 GB of seats
at ~250 MB each, and three 4-seat teams plus the ~486 MB controller is ~3.0 GB against an advertised
2 GB minimum. It would have OOM-killed the box on boot. Rationale, measured on the target host: an idle `devin` seat costs ~60-80 MB and CPU only
while working, so a second parked team is affordable on a 4 GB box; and rungs 1-3 are only exercised
when there is more than one live head to choose between, so starting one team leaves the routing
logic untested in practice. If a guard is wanted, cap concurrently auto-started teams per head role —
do not hard-limit to the nominated default.

## BLOCKER: a lone terminal registers a phantom team

**This must be fixed before this plan ships.** The plan's whole subject is "two teams claim one head
role"; today the roster can gain teams the operator never created, so the ladder would route between
a real team and an artefact.

Operator report: starting a lone terminal from the Teams panel adds a new team.

Root cause — `agentGroupInstantiation.ts:88`, `instantiateAgentGroupCore`:

```js
const workers = Array.isArray(result.delegates) ? result.delegates : [];   // may be []
const roster  = [headName, ...workers.map(w => w.friendlyName)];           // -> [headName]
const wired   = await wireSpawnedTeam({ …, children: workers, … });        // UNGUARDED
```

`wireSpawnedTeam` then registers `team_<headName>` in `switchboard.prompts.terminals.groups`, and
`terminals.js:1406` classifies any `team_`-prefixed row as a team — so a single seat becomes a team in
the panel.

**The standalone host already guards this and the two paths have diverged.** `bootstrap.ts:2217` wraps
the identical call in `if (spawned.children.length > 0)`. This is the same divergence pattern as the
drag/advance defect: one behaviour implemented twice, the copies disagreeing.

**No existing plan covers it.** Nearest three, all checked:
`start-team-seats-one-head-into-the-open-grid…` (seating, not registration),
`new-agent-ignores-the-empty-slot…` (slot assignment, never calls `wireSpawnedTeam`), and
`fix-headrole-missing-from-live-terminal-groups` (adds `headRole` to what is persisted; never asks
whether persisting is correct for zero delegates).

**Fix:** guard the call the way standalone does — no delegates, no team registration — and prefer
deleting one of the two implementations over guarding both.

> **Overlap to watch:** `fix-headrole-missing-from-live-terminal-groups` edits
> `resolveCodingRolesFromGroups`, the resolver directly beneath `resolveCodingHeadFromGroups` that
> this plan reframes onto. Live data confirms that plan has partly landed — `team_Coding` carries
> `headRole: "lead"` while the older `grp_` row carries none. Sequence the two, or they will collide
> on the same function.

## Outstanding Questions

- **[user]** The plan's original root-cause analysis cited `findTeamForHeadRoleInRoots` (TaskViewerProvider.ts:12252) as the dispatch lookup, but that function is dead code (only caller is the orphaned `_selectAutobanTerminal`). The live team-selection site is `resolveCodingHeadFromGroups` (KanbanProvider.ts:5554) returning `leads[0]`. This reframe moves the primary edit site from `teamWiring.ts`/`TaskViewerProvider.ts` to `KanbanProvider.ts` and widens a shared signature. Proceeding on the assumption that the reframe is correct (the ladder must route at the live site or it routes nothing), but the operator should confirm before coding begins.
- **[user]** Rung 1's signal is corrected from `mission_members` (which holds only plan/feature members, kind `'plan'|'feature'`) to the existing `missions.team` column. Proceeding on the assumption that `missions.team` is the intended "mission names its team" signal (it is already read at dispatch in `command.js:1802`); confirm, or name the alternative carrier.
- **[user]** When two teams share a head role and both carry `startOnLoad`, Change #6 proposes only the rung-4 nominated default auto-starts. Proceeding on the assumption that single-scope auto-start of one team per head role is the desired policy; confirm, or state the preferred rule (e.g. both start, ladder routes live heads).
