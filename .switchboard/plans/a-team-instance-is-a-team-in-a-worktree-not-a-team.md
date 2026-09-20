# A Team Instance Is a Team *in a Worktree*, Not a Team

## Goal

Run the same team twice at once in different worktrees — two Feature teams, one
per worktree — because that was the original intent and missions depend on it.

A running team is identified by **(definition, root)**. Today it is identified
by definition alone, so the second instance is not refused by a guard being
strict; it is **inexpressible**.

### Problem analysis

#### The registry has no worktree dimension

A live spawned group row carries exactly these keys:

```
id, name, headRole, source, teamGroup, teamKind, head,
layout, members, order, externalHead, templateId, definitionId, layoutPref
```

**No root. No worktree.** So the registry cannot represent "the Feature team in
worktree A" and "the Feature team in worktree B" as different things — there is
one row per definition and nowhere to put the second.

#### So the guard can only answer workspace-wide

`startTeamById` finds the running instance with:

```ts
const own = groups.find(g => isSpawnedTeamGroup(g) && g.definitionId === teamId);
```

Keyed on `definitionId` alone. It then refuses if that row's head is live. The
guard is **correct for the model it has** — it is the model that has no room for
a second instance. Tightening or loosening the guard cannot fix this.

The group id compounds it: it is derived as `team_<head>`, so two instances
would need distinct head names before they could be distinct rows at all.

#### The intent is visible on both sides, unimplemented in the middle

- `startWorktree` is a per-team definition field, preserved through migration
  and listed among the operator-owned settings.
- `missions.max_extra_worktrees` is a column on the missions table.

Both ends assume a team can run in more than one place. The registry between
them cannot say so.

#### The fleet already knows the answer

Terminals carry `parentRoot` — `ptyListTerminals` returns it per seat. So the
running processes know which root they belong to; only the team registry has
dropped that dimension. The information exists and is being discarded at the one
layer that needs it.

#### Why this matters beyond convenience

> **Superseded:** "`max_extra_worktrees` can be set and cannot be honoured: the
> moment a mission wants the same team in a second worktree, the start is
> refused as a double start."
> **Reason:** Half wrong. `launchMission` already honours the field — it
> provisions the extra worktree (`KanbanProvider.ts:17788-17798`,
> `_createSafetyWorktree` + `addWorktree` + `_openWorktreeTerminalsBestEffort`).
> What it cannot do is seat a *second instance of the mission's team* in that
> tree: `_resolveLiveTeamHead` (`KanbanProvider.ts:17466`) picks the first live
> group matching the definition id and dispatches there. The worktree and the
> team are adjacent, never joined — the tree gets generic role terminals while
> the single team instance keeps running wherever it already was.
> **Replaced with:** `max_extra_worktrees` provisions the tree today but cannot
> put the team in it. Honouring the field fully means a mission-bound team
> instance seated *in the provisioned root*, which is exactly what (definition,
> root) identity makes expressible.

Missions with extra worktrees are half-buildable without it: the tree is
created, but the second start is still refused as a double start, and the
refusal is indistinguishable from the genuine double-start case the guard exists
to prevent — the same wrong answer for two different questions.

### Verified mechanics (read of the code, 2026-09-21)

The implementation facts the changes below hang on. All verified against `src/`.

- **Group id is name-derived, not definition-derived.** `wireSpawnedTeam` mints
  `groupId = 'team_' + encodeURIComponent(headName).replace(/[^a-zA-Z0-9_]/g, '_')`
  (teamWiring.ts:2656-2657). The same derivation is re-typed inline at three
  read sites: `resolveTeamScopedRoleTerminal` (:3496), `resolveTeamMembersForHead`
  (:3569), `resolveTeamPacingForHead` (:3858). Instance identity flows through
  **seat names**, and the whole name-keyed layer — group id, standing orders
  keyed `(scope, teamId=groupId)` (:2778-2794), the member-orders dir
  `.switchboard/teams/<groupId>/`, the per-team queue
  `/terminals/teams/<groupId>/queue` (LocalApiServer.ts:10106+) — inherits it
  for free once the head name carries an instance qualifier.
- **The head seat name comes from the definition name.** `instantiateAgentGroupCore`
  computes `seatNameFromTeamName(group.name)` (agentGroupInstantiation.ts:220-221)
  — identical for every instance of a definition.
- **Seat names are globally unique in the fleet, and collision handling is
  lossy.** `PtyFleetService.create`'s loop mints `${role}-${counter}` on a
  taken name (ptyFleetService.ts:527-532) — a second `Feature` head would come
  up as `lead-2`, dropping the team qualification entirely (the "drifting
  terminal name" defect the codebase comments name). So distinct head names are
  not a naming preference; they are forced by the fleet.
- **Delegates inherit the head's name.** Per-team seats are named
  `${parent.friendlyName}-${label||role}${-i}` (ptyFleetService.ts:1093), so an
  instance-qualified head yields an instance-qualified roster automatically.
  **Shared members do not**: they are named `${teamName}-${role}`
  (:1038-1039) where `teamName` is the *definition* name, so a `scope: 'shared'`
  seat is reused across instances — spawned once, in the first instance's cwd.
- **`terminals.groups` lives in the one board store.** `forWorkspace` resolves
  every root to the per-workspace board file (KanbanDatabase.ts:2107+); all
  instances' rows sit in one array, so a `root` field is the only thing needed
  to tell them apart.
- **Worktree provisioning already runs before the guard.** Both start paths
  provision a `tier='team'` worktree when `worktreeMode === 'auto'` *before*
  `startTeamById` is called (TaskViewerProvider.ts:14402-14407,
  KanbanProvider.ts:5764-5769). Today a refused second start therefore *leaks a
  freshly provisioned worktree*. Under (definition, root) identity the ordering
  becomes load-bearing in the other direction: the guard must evaluate the
  *provisioned* root, not the request root.
- **`resolveLiveGroupHeads` is a last-write-wins map.** It does
  `out.set(g.definitionId, head)` (teamWiring.ts:3801-3805); a second instance's
  head overwrites the first's. Its consumers attach `head` to definition rows
  (bootstrap.ts:2453, TaskViewerProvider.ts:4010).
- **The rail binds only the first matching group.** `buildTeamsForShell` uses
  `terminalGroups.find(g => g.definitionId === def.id)` (terminals.js:2027) and
  the live-group arm *skips* spawned-team rows (:2109), so a second instance
  would exist and render nowhere — reachable but invisible.
- **There is no `stopTeam`.** A team ends by its seats exiting; the row persists
  and the guard keys on head *liveness*. "Stop one instance" = kill that
  instance's seats; the other instance is untouched by construction.
- **A provisioned worktree has no `.switchboard/`.** The dir is gitignored and
  created only by the host scaffolder in the workspace root, so
  `writeMemberOrdersFile` and `bootstrapTeamReportsDirectory` no-op there
  (teamWiring.ts:2547-2550 guard). The member standing orders name the reports
  dir as a *relative* path (`.switchboard/teams/<teamId>/reports/`,
  standingOrderFragments.ts:98) which a worktree seat resolves inside the
  worktree — while the API reads reports from the board root
  (LocalApiServer.ts:11492). A worktree instance cannot report until this is
  answered.

## Metadata

**Tags:** feature, backend, ui
**Complexity:** 7
**Scope:** `src/services/teamWiring.ts` (group registration, `startTeamById`,
group-id derivation, `resolveLiveGroupHeads`, the name-keyed resolvers),
`src/services/agentGroupInstantiation.ts` (seat naming, `wireSpawnedTeam`
call), the two start paths (`TaskViewerProvider.startTeamForWorkspace`,
`KanbanProvider.startAgentGroupById`), `src/webview/terminals.js` (rail),
`src/services/KanbanProvider.ts` (`_resolveLiveTeamHead`, `launchMission`).
**Standalone only** for new wiring; `teamWiring.ts`, `agentGroupInstantiation.ts`
and `terminals.js` are shared modules, so the extension host inherits the
mechanism unchanged — per the post-cutover rule no new seam is wired into
`extension.ts`.

## User Review Required

- **Instance naming scheme** — see Outstanding Questions; the plan proceeds on
  `<Team>-<root-dir-basename>` for non-board-root instances.
- **START on an `worktreeMode: 'auto'` team** today means "one instance, fresh
  tree". Under (definition, root) identity each auto start is a *new* instance
  unless `provisionTeamWorktree` reuses the team's existing `tier='team'` tree —
  the sibling plan `team-autostart-worktrees-accumulate-with-no-reuse-and-no-cleanup`
  owns that reuse and this plan's guard semantics depend on it.
- **Shared members are shared across instances** (status-quo semantics kept):
  one `Feature-reviewer` serves every Feature instance, and its cwd is whichever
  root spawned it first.

## Constraints

**Keep the double-start guard.** Starting the same team twice **in the same
root** must still be refused — that is a real error and the reason the guard
exists. This plan narrows what "the same team" means; it does not remove the
check.

**One identity, derived once.** `(definitionId, root)` becomes the instance key
and every surface uses it. Do not let one caller key on `definitionId` while
another keys on the pair — that is the drift this codebase keeps paying for, and
a half-applied key is worse than none.

**Seat names must stay unambiguous.** Two live Feature teams cannot both have a
head called `Feature`. Naming is load-bearing: `ptySendPrompt`, the roster, the
member-orders file and the standing orders all address seats by name.

**A root must be recorded, not inferred.** Do not derive an instance's worktree
from a terminal's `parentRoot` at read time. The row states its own root, so an
instance whose seats have all exited is still attributable.

**Existing single-root teams keep working unchanged** — an instance with no
recorded root is the workspace root, and the unmigrated case must not read as a
different instance.

## Complexity Audit

### Routine
- Adding a `root` field to the group literal and its upsert-merge arm
  (teamWiring.ts:2854-2906) — `saveTerminalGroupsGuarded` passes row objects
  through verbatim, so the field survives webview whole-array saves.
- Extracting the `team_<head>` derivation into one exported helper used by all
  four inline sites (:2657, :3496, :3569, :3858).
- Extending the rail's `.find` to a filter that emits one slot per live
  instance.
- Guard predicate: `definitionId` match **and** root match — a one-line change
  in shape, though not in consequence.

### Complex / Risky
- Seat naming is a forced, board-wide-unique, restart-stable decision: the
  scheme must be deterministic in (definition, root) so a re-seat after a crash
  re-mints the same names and the reuse predicates keep working.
- Legacy rows carry no `root`: the "absent ≡ board root" reading is a real
  fallback on an identity read — justified because pre-change rows genuinely ran
  in the board root, but a pre-change `worktreeMode: 'auto'` instance in a
  provisioned tree will mis-read as board-root (wrong refusal in one direction,
  visible and self-healing on next spawn).
- `resolveLiveGroupHeads` changing from `definitionId → head` to a multi-value
  shape touches every consumer that attaches a live head to a definition row.
- Missions: joining the provisioned worktree to a seated instance is new wiring
  across `launchMission`, `startAgentGroupById`/`startTeamById`, and
  `_resolveLiveTeamHead`.
- Root comparison must normalize identically on write and read (`path.resolve`
  + best-effort `realpath`) or the guard silently fails *open* — two heads in
  the same tree, the second named `lead-2`.

## Edge-Case & Dependency Audit

- **Race Conditions:** two concurrent starts of one definition in the same root
  — the liveness check (`liveNames.has(ownHead)`) has a check-then-spawn window
  today; the window does not widen, but the group upsert is serialized through
  `_groupsWriteChain` and the fleet's name uniqueness is the final arbiter.
  Concurrent starts in *different* roots must both succeed — the shared-member
  per-name chain (ptyFleetService.ts:1049) already serializes shared-seat reuse.
- **Security:** none new — the wire still cannot supply a group definition
  (bootstrap.ts:2512); `root` is host-computed from the spawn cwd, never a wire
  field. A wire-supplied `cwd`/`parentRoot` already steers spawn location today.
- **Side Effects:** `.switchboard/teams/<groupId>/` in a worktree does not exist
  — the member-orders and reports-dir writes no-op there (see Verified
  mechanics). The plan must either scaffold `.switchboard` inside provisioned
  team worktrees or write those files under the board root and have the orders
  name a reachable path; otherwise worktree seats run with no report channel.
  Also: every auto-mode start currently leaks a provisioned worktree when the
  guard refuses — the leak persists for same-root refusals until the sibling
  reuse plan lands.
- **Dependencies & Conflicts:**
  - `.switchboard/plans/team-autostart-worktrees-accumulate-with-no-reuse-and-no-cleanup.md`
    — `provisionTeamWorktree` reuse is **load-bearing** here: without it, every
    auto-mode start mints a new root and therefore a new instance, and "START"
    becomes an instance multiplier rather than a restart.
  - `.switchboard/plans/mission-07-a-mission-can-be-paused-and-resumed.md` and
    other mission plans touch `launchMission` — sequence after them or expect
    conflicts in KanbanProvider.ts:17700-17850.
  - `ptyFleetService.create` collision fallback minting `${role}-${n}` is the
    thing this plan must never trigger — pass explicit names, always.

## Dependencies

- `team-autostart-worktrees-accumulate-with-no-reuse-and-no-cleanup` — worktree
  reuse semantics that make (definition, root) refusal correct for auto teams.
- `mission-07-a-mission-can-be-paused-and-resumed` — shares the `launchMission`
  region; land ordering only.

## Adversarial Synthesis

Key risks: the guard normalizing roots inconsistently (fails open into `lead-2`
sprawl), a worktree instance's seats having no `.switchboard` report channel,
and `resolveLiveGroupHeads`/the rail silently collapsing two instances back to
one. Mitigations: one shared normalize+compare helper used on write and read,
a deliberate decision on where per-instance files live (board root, absolute
path in orders), and making every definition→instances read return a list so a
second instance cannot be silently dropped.

## Proposed Changes

### src/services/teamWiring.ts

**Context.** The group row is written at :2854-2869 (insert) and :2884-2903
(merge arm); the guard is `startTeamById` :2366-2380; the `team_<head>`
derivation is inline at four sites.

**Logic.**
- `WireSpawnedTeamOptions` gains `root?: string` — the resolved spawn cwd.
  Write `root` onto the group literal and the merge arm (preserving an existing
  `root` the way `layout` is preserved is wrong here — a re-spawn in a new root
  is a new instance, minted under a new `groupId`, so the merge arm only ever
  refreshes the *same* root; write it unconditionally).
- Export `teamGroupIdForHead(headName)` and point all four inline derivations
  at it. The derivation IS the identity contract; it must exist once.
- Export an instance-root read: `instanceRootOf(group, boardRoot)` returning
  `group.root` when present and `boardRoot` when absent, *with a source tag* —
  `{ value, source: 'row' | 'legacy-default' }` per the fallback rule, because
  "the row said so" and "the row predates the field" must stay distinguishable.
  Pair it with `sameInstanceRoot(a, b)` doing `path.resolve` + best-effort
  `fs.realpathSync` on both sides; write and compare through this one helper.
- `startTeamById` opts gain `boardRoot: string`. The guard becomes:
  `groups.find(g => isSpawnedTeamGroup(g) && g.definitionId === teamId &&
  sameInstanceRoot(instanceRootOf(g, boardRoot).value, workspaceRoot))`.
  The refusal message gains the running instance's root so a refusal is
  attributable after the fact.
- `resolveLiveGroupHeads` becomes multi-value: `Map<string, Array<{ head, root }>>`
  (or a `Map<string, {head, root}>` keyed on group id plus a
  `Map<string, Array<…>>` keyed on definitionId — pick the shape the two
  consumers actually need; a map that can hold only one head per definition is
  the defect being removed).

**Implementation.** Small, mechanical edits once the helpers exist; the risk is
a caller re-deriving instead of calling — the contract tests below grep for the
inline derivation surviving anywhere.

**Edge cases.** Legacy row, no `root`, head dead: no refusal today, unchanged.
Legacy row, head live in a *provisioned* tree: reads as board-root → a board-root
start refuses wrongly once, visibly, and self-heals on the next spawn. Accept
and say so in the error text (name the head).

### src/services/agentGroupInstantiation.ts

**Context.** `headSeatName = seatNameFromTeamName(group?.name)` at :220-221;
`wireSpawnedTeam` is invoked at :265 with `workspaceRoot: cwd`.

**Logic.**
- `InstantiateAgentGroupOptions` gains `instanceLabel?: string` (host-computed
  from the spawn root — the worktree directory basename, sanitized through the
  same `[A-Za-z0-9_.-]` rules as `seatNameFromTeamName`). Board-root spawns pass
  no label and keep the bare team name — existing names, existing rows, no
  migration.
- Head seat name becomes `seatNameFromTeamName(group.name)` for the board-root
  instance and `${seatNameFromTeamName(group.name)}-${instanceLabel}` otherwise.
  Deterministic in (definition, root): same root re-seat → same name → the
  reuse predicates and the upsert keep working.
- Pass `root: <resolved spawn cwd>` through to `wireSpawnedTeam` at :265.
- Decide and record the shared-member answer: keep `${teamName}-${role}`
  (shared across instances — current semantics) vs `${instanceHeadName}-${role}`
  (shared within an instance). This plan keeps cross-instance sharing and notes
  the first-spawner's-cwd caveat; if isolation is wanted the label threads the
  same way.

**Edge cases.** External-headed teams take `headName` from the caller — the
instance label must apply to that path too or a second external instance
collides identically.

### src/services/TaskViewerProvider.ts + src/services/KanbanProvider.ts (start paths)

**Context.** `startTeamForWorkspace` :14379-14425 and `startAgentGroupById`
:5749-5777 both provision a worktree *before* the guard and both call
`startTeamById` with `workspaceRoot: <spawnCwd>`.

**Logic.**
- Pass `boardRoot` (the root owning the groups store — `_apiServerWorkspaceRoot
  || resolvedRoot` / `workspaceRoot`) into `startTeamById` so the legacy-default
  read has its board root.
- Compute `instanceLabel` once, host-side, from the final spawn cwd (after
  worktree provisioning): undefined when the spawn cwd resolves to the board
  root, else the spawn dir's basename. Thread it into the instantiator options.
- Update the `headMap` consumption (:4010, and bootstrap.ts:2453) for the
  multi-value `resolveLiveGroupHeads` shape.

### src/services/KanbanProvider.ts (missions)

**Context.** `_resolveLiveTeamHead` :17462 returns the first live group matching
`teamId`; `launchMission` :17788-17797 provisions the extra tree and then
dispatches to that head.

**Logic.** Change 5's mechanism: when a mission provisions a worktree, seat an
instance of the mission's team *in that root* (`startTeamById` with
`workspaceRoot = wtPath`) and dispatch to *that* instance's head —
`_resolveLiveTeamHead` gains an optional `root` and matches on (definitionId,
root). A mission with no extra tree keeps today's first-match behaviour.

### src/webview/terminals.js

**Context.** `buildTeamsForShell` :2017-2099 binds one live group per
definition via `.find`; spawned-team rows are excluded from the live-group arm.

**Logic.** Collect *all* spawned groups matching `def.id`; emit one rail entry
per live instance, labelled with the instance root's basename so two Feature
teams are tellable apart. A definition with no live instance still emits exactly
one dormant slot. The START affordance needs a target root — reuse the existing
`{ parentRoot }`/`startTeamTarget` plumbing (:1380, :10379+) so "start in
<worktree>" posts the worktree root rather than inventing a second channel.

### `agentGroups` consumers (bootstrap.ts:2453, TaskViewerProvider.ts:4010)

Read the multi-value head map; a definition served to the TEAMS tab carries
its live instances (head + root each), not a single `head`.

## Verification Plan

### Automated Tests

Contract suites run against `out/` — `npm run compile-tests` before any
`test:contract:*` invocation. House style is a `src/test/*-contract.test.js`
file asserting on source + a behavioural harness; name it
`team-instance-root-contract.test.js`.

- **Two instances of one definition in two roots both start** and both appear
  with distinct head names — the case impossible today. Assert two
  `terminals.groups` rows share `definitionId` and differ on `root`.
- **A second start in the SAME root is still refused** with
  `TEAM_ALREADY_RUNNING`, asserted beside the above.
- **Root normalization**: a start requested with a non-resolved/spelled
  differently-equal path (trailing slash, symlink) is refused, not allowed —
  the fail-open case.
- **Legacy row**: a `terminals.groups` row with no `root` plus a live head
  refuses a board-root start and allows a different-root start.
- Each instance's seats resolve to their own instance: `resolveTeamMembersForHead`,
  `resolveTeamScopedRoleTerminal`, `resolveTeamPacingForHead` answer per
  instance given each head's name.
- A dispatch to one instance's head reaches only that instance's roster.
- Killing one instance's seats leaves the other instance's row, roster and
  queue untouched.
- `resolveLiveGroupHeads` returns both instances for one definitionId.
- Rail projection: two live groups on one definition produce two team entries;
  a definition with none produces one dormant entry.
- Seat names are deterministic per (definition, root): re-seating the same
  root mints the same names (restart stability), and the names satisfy the
  `[A-Za-z0-9_.-]` charset.
- No `team_<head>` inline derivation survives outside the exported helper
  (grep assertion, the drift gate).
- Mission path: `launchMission` with `maxExtraWorktrees=1` seats an instance in
  the provisioned root and dispatches to that instance's head.

### Goal Invariants

- Assert every `terminals.groups` write of a spawned team carries `root`.
- Assert `startTeamById`'s guard contains a root comparison alongside the
  `definitionId` match — the negative form: no live-instance lookup keys on
  `definitionId` alone.
- Assert two rows sharing a `definitionId` can coexist (the registry can hold
  the state) AND that `resolveLiveGroupHeads` exposes both (the surfaces can
  see the state).
- Assert the second instance's head name is not `${role}-${n}` — i.e. the
  fleet collision fallback was never reached.

### Manual

Start the Feature team in the main worktree and again in a second worktree.
Confirm both run, both are tellable apart in the roster, a dispatch to one does
not touch the other, and each instance's seats can write reports the status
pane reads.

## Outstanding Questions

- **[user] Seat naming for non-board-root instances** — proceeding on the
  assumption of `<Team>-<root-dir-basename>` (bare name reserved for the
  board-root instance, keeping every existing name and stored order valid).
  An ordinal (`Feature-2`) is stabler under a worktree move but opaque in a
  roster; the basename dies with the worktree it names, which is the honest
  lifetime for a seat name anyway.
- **[user] One board, two instances competing for cards** — proceeding on one
  shared board: the mission's worktree binding (change 5) is what routes work
  to a specific instance; two instances with no mission simply present two
  dispatch targets, which `_resolveLiveTeamHead`-style first-match resolution
  already picks deterministically.
- **[research] none** — every open fact above was settled from the code; no
  external research is needed.

## Improvement Pass Notes (2026-09-21)

Strengthened in place: added the verified-mechanics read (group id is
head-name-derived at four sites; seat names are fleet-global; delegates inherit
the head's name; worktrees lack `.switchboard/`); corrected the
`max_extra_worktrees` claim (it provisions the tree today — the missing piece
is seating an instance in it); scoped the guard change to `startTeamById` with
a `boardRoot` parameter; named the `resolveLiveGroupHeads` last-write-wins map
and the rail's first-match `.find` as the two surfaces that would silently hide
a second instance; and recorded the provision-before-guard ordering leak plus
the sibling worktree-reuse plan as load-bearing dependencies.
