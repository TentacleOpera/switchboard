# Teams Ship as Four Defaults, and You Can Switch One Off

## Goal

Ship exactly four default teams — **Planning**, **Coding**, **Review**, **Multi-agent planning** —
present on every board, none of them deletable. Three start enabled (Planning, Coding, Review);
Multi-agent planning is present and **off**. Give a team an in-use switch, so a team that exists is
not automatically a team that plays.

Teams are how this product works. There have to be defaults, and the operator has to be able to say
"not that one" without deleting it.

### Problem analysis

**A team has exactly one state today: it exists.** There is no `enabled` field on a team definition
anywhere — `grep enabled src/services/teamWiring.ts` returns nothing. Presence in
`terminals.agentGroups` is the whole story, and presence means: rendered on every roster and rail,
startable, and **competing for its head role**. An operator who does not want a team has no move
except delete, and delete does not stick (below).

**There are two team catalogues and they disagree.**

*Catalogue A — `SHIPPED_TEAM_TYPES`* (`src/webview/agent-control.js:1017+`), five types, no ids:
Batch planners, Coding, Review, Multi-agent planning, Planning with analyst. Picking one calls
`teamsTabAdopt` (`agent-control.js:1679`) — *"Fork a shipped type into the workspace's own teams and
persist it"* — minting a definition with a generated id
(`'group-' + name + '-' + Date.now().toString(36)`, `:1681`).

*Catalogue B — `DEFAULT_TEAM_DEFINITIONS`* (`src/services/teamWiring.ts:560-590`), three definitions
with fixed ids, force-seeded into the board on every load: `planning-team` ("Planning team"),
`feature-implementation` ("Lead team"), `review-team` ("Review team").

The list you choose from and the list pushed onto you are different lists. "Lead team" is in B with
no counterpart in A, which is why a board grows a lead-headed team the operator never created.
Multi-agent planning is in A and is never a default.

**"Planning with analyst" is not a team type.** It is a planner with a general-purpose subagent —
a role-config concern wearing a team costume. It comes out of the catalogue.

**Delete does not stick, and the code comments claim it does.** `_loadAgentGroups`
(`KanbanProvider.ts:5329-5335`) re-adds any missing default whenever the key is present:

```js
for (const def of DEFAULT_TEAM_DEFINITIONS) {
    if (!working.some(g => g && g.id === def.id)) { working.push(seedCopy(def)); changed = true; }
}
```

`_deleteAgentGroup` (`KanbanProvider.ts:5500-5505`) persists the filtered array *"even if empty — so
a deleted built-in stays deleted (absent = re-seed; present-and-empty = user deleted all)"*. That
intent is **unreachable**: `working === null` is true only when the key is absent, so a delete that
leaves `[]` still takes the `else` branch and re-adds all three. A second resurrection site backs it
up — `resolveTeamById` (`teamWiring.ts:1022-1030`) re-seeds a deleted default on demand.

Undeletable defaults are the intent. The comments describing a deletable built-in are stale and go.

**The existing near-miss at an off switch makes things worse.** `unassigned: true` is set by
`migrateAgentGroups` (`teamWiring.ts:794-831`) on the loser of a head-role collision. It only ever
meant "not the auto-start default", and auto-start is retired — `startOnLoad` is stripped on read
(`teamWiring.ts:735-742`). So the flag now gates almost nothing while reading, in the UI, exactly
like a disabled state. Live evidence from this board: `feature-implementation` carries
`unassigned: true` with the reason *"Head role 'lead' is the auto-start default for 'Coding'"* — a
team the operator never made, demoting itself against the team they did make, in a mechanism that no
longer does anything.

Two flags that both look like "off" is the two-copies-disagreeing trap. `unassigned` does not
survive this plan.

### The four defaults

| id | name | headRole | members | ships |
| :--- | :--- | :--- | :--- | :--- |
| `planning-team` | Planning | `planner` | 2 × `planner`, 1 × `researcher` (`scope: 'shared'`) | **enabled** |
| `feature-implementation` | Coding | `lead` | 3 × `coder` | **enabled** |
| `review-team` | Review | `reviewer` | 2 × `reviewer` | **enabled** |
| `multi-agent-planning` | Multi-agent planning | `planner` | 3 × `planner` (peer drafts), 1 × `researcher` (`scope: 'shared'`) | **disabled** |

Ids are fixed and stable; `feature-implementation` keeps its id and is **renamed** to Coding (the
name "Lead team" is what made it read as a stranger). Coding and Review rosters are the ones already
landed by *The Three Preset Teams Ship Member-Less* — this plan does not re-derive them.

**Both planner-headed teams carry a shared researcher seat.** A researcher is what stops a planner
handing its research back to the operator to action by hand; it is the seat that makes planning work
unattended. `scope: 'shared'` spawns it **unparented** and reuses a live instance
(`ptyFleetService.ts:1034-1063`), so it is a facility rather than a possession — one researcher
serves every planner team. The routing that makes a live researcher seat actually get used is a
separate plan: `a-live-researcher-seat-is-ignored-because-the-gate-asks-config-not-the-fleet`.

**Multi-agent planning is the peer-planner topology, not the fan-in one** — three planner seats that
each draft the same problem, with the head reconciling. See Dependencies.

**There is deliberately no "quick coding" team.** Ploughing a backlog of unrelated
low-complexity cards needs no team at all: stage them in Dispatch, press Run, and the queue routes
each card to a seat by complexity and sends the next on completion. That is *Kanban Queue Dispatch
Without a Team* — **already completed** — whose contract is *"no team, no head, no pacing toggle, no
roster resolution."* A team for this would be three seats plus a lead spending tokens dispensing what
the board already dispenses. Operator decision, 2026-09-17: *teams are overkill for someone who just
wants a coder to plough through the backlog.*

Catalogue A is **deleted**. "Batch planners" is the Planning team under a worse name; "Planning with
analyst" is a bug; the other three are now defaults. `teamsTabAdopt` stops being an adoption path
and becomes plain custom-team creation. One catalogue, four rows, plus whatever the operator builds.

### The switch

Copy the shape columns already use (`src/services/agentConfig.ts:163-164`):

```ts
enabled?: boolean;
enabledSource?: 'config' | 'default' | 'unknown';
```

`enabled` decides participation; `enabledSource` records **who decided**, so "off because it ships
off" and "off because the operator switched it off" are never the same value on a membership read —
the repo's fallback rule. A team the operator builds is written `enabled: true` with
`enabledSource: 'config'` at creation, so the field is never absent and there is no
absent-means-what question to answer.

Disabled is not deleted and not hidden. The Teams tab shows a disabled team greyed with its switch,
or there is no way back on.

### First run: five agents, then teams work

**The point of shipping defaults is that a new user never configures a team.** They configure agents.
The three defaults that ship **enabled** then work, because between them they use exactly five
roles:

| role | used by |
| :--- | :--- |
| `planner` | Planning (head + seats), Multi-agent planning (head + peer seats) |
| `researcher` | Planning, Multi-agent planning (shared seat) |
| `lead` | Coding (head) |
| `coder` | Coding (seats) |
| `reviewer` | Review (head + seats) |

That is the **recommended agent set** — and it is not a second list to maintain. It is derived from
`DEFAULT_TEAM_DEFINITIONS`: the union of `headRole` and member roles across the defaults that ship
**enabled**. If those defaults change, the recommended set changes with them, because it is computed,
not typed.

Deriving from the *enabled* set is what keeps first run at five commands. Multi-agent planning adds
no new role (`planner`, `researcher` are already counted), so today the enabled and full sets agree —
but **enabling a disabled team must still surface any role it needs that is not yet configured**,
rather than starting it into bare shells. That is the same `commandlessRoles` report as Change 6,
fired at enable time as well as at start.

**Today a new user faces twelve startup-command fields** — `DEFAULT_ROLE_CONFIG`
(`src/webview/sharedDefaults.js:19-54`) carries `planner`, `lead`, `coder`, `reviewer`, `tester`,
`intern`, `analyst`, `ticket_updater`, `researcher`, `claude_designer`, `phone_a_friend`,
`project_manager` — with nothing marking which five make the shipped teams run. Filling in the wrong
five produces teams that start and spawn bare shells.

**Starting is a click on the team's rail icon.** The affordance already exists: a dormant slot's
click posts `ptyStartTeam` (`shell.js:674-681`), and a running team's icon switches the terminals
panel into that team's scope. Nothing new is needed for start — only for which teams get a slot
(Change 8).

**"Automatically enables" means enabled, not started.** The three basic defaults ship `enabled` with
no team configuration step at all; configuring the five agents is what makes them *runnable*. It
does **not** mean a team spawns because the host booted — `Delete Auto-Start`
(`teams-start-when-a-card-needs-them-not-at-boot`) removed the boot sweep on an explicit operator
decision (2026-09-09) and this plan does not reintroduce it. **The reason is RAM, and it still
holds**: a board-only host fits 1 GB, board plus local agents wants 2 GB minimum — spawning three
teams because the host came up can take the board down on a small box. A team starts when the
operator clicks its rail icon, or when the controller starts it. The researcher then comes up **with**
the Planning team as its shared member, which is team-start-time, not boot-time.

## Metadata

**Complexity:** 4
**Tags:** teams, config, defaults, clean-break, standalone
**Scope:** shared services (`teamWiring.ts`, `KanbanProvider.ts`) + the standalone host and its
webviews. The extension host is not wired for this — it is being removed, and a second
implementation there is throwaway work.

## Dependencies

**Not blocked by `two-teams-can-share-a-head-role-and-routing-decides-between-them`.** The shipped
set has two `planner`-headed teams (Planning, Multi-agent planning) and two `lead`-headed ones
(Coding, Quick coding). **That is not a conflict.** The only thing that ever treated it as one is the
demotion in `migrateAgentGroups` (`teamWiring.ts:794-831`), which **Change 4 of this plan deletes** —
along with `unassigned`, the flag it wrote. After this plan, two teams sharing a head role is an
ordinary configuration that nothing objects to.

What that other plan adds is a **routing ladder** — which of two *live* same-role teams receives a
given board dispatch, replacing `resolveCodingHeadFromGroups`' arbitrary `leads[0]`
(`KanbanProvider.ts:5891-5897`). That matters for dispatch quality once an operator runs two lead
teams at once; it is not a precondition for shipping five defaults, and `leads[0]` is arbitrary
rather than broken in the meantime. **Sibling, not blocker** — and it gets simpler once the demotion
is gone, because it no longer has to reason about a flag that marked one team as the loser.

**Not dependent on `a-team-declares-what-work-it-accepts`.** That plan's `acceptedKinds` /
`complexityBand` fields remain worth having for operator-built teams, but no shipped default needs
them: the four defaults are distinguishable by head role and roster, and backlog batches are handled
by the queue rather than by a team that declares it accepts them.

**Depends on `multi-agent-planning-team-fan-out-head-and-peer-planner-roster`.** Default #4 seeds
from whatever roster and `headPrompt` that card lands. Seeding catalogue A's current fan-in entry
instead would ship a fourth default that is Planning with more seats and a head that never dispatches
to them. Sequence that card first.

**Depends on `a-live-researcher-seat-is-ignored-because-the-gate-asks-config-not-the-fleet`** for the
researcher seat on both planner-headed defaults to do anything. Without it the seat spawns, idles,
and the planner still hands its research prompt to the operator.

**Sibling, already landed:** *The Three Preset Teams Ship Member-Less* put members on the presets in
the seed. This plan takes the Coding and Review rosters as given and does not re-derive them.

## Proposed Changes

### 1. Four defaults, fixed ids, one renamed (`teamWiring.ts:560-590`)

Extend `DEFAULT_TEAM_DEFINITIONS` to the four rows above. Rename `feature-implementation` to
`Coding`. Add `multi-agent-planning` with catalogue A's roster and `purpose`/`prompt`/`headPrompt`
copy moved across verbatim — that copy is under contract test
(`src/test/coding-head-prompt-contract.test.js`, `standing-orders-marker-contract.test.js`), so it
moves, it is not retyped.

Stamp each default `enabled` + `enabledSource: 'default'` at seed time.

`SEEDED_AGENT_GROUP` (`teamWiring.ts:592`) is `DEFAULT_TEAM_DEFINITIONS[1]` — a positional alias that
breaks silently when the array grows. Resolve it by id or delete it.

### 2. `enabled` on the definition, honoured at every read

Add the two fields. Then decide, per read site, what a disabled team means:

- **`migrateAgentGroups` head-role collision** (`teamWiring.ts:794-831`) — **nothing to gate: the
  collision resolution is deleted outright by Change 4.** Two teams sharing a head role is not a
  conflict and never was; the demotion was the bug. `enabled` does not need to exclude a disabled
  team from a contest that no longer happens.
- **`listAgentGroups` / `peekAgentGroups`** (`KanbanProvider.ts:5378`, `:5397`) — return every team
  with its flag. Filtering here would hide the switch from the tab that owns it.
- **`ptyListAgentGroups` verb** → Command roster — disabled teams are not listed.
- **The shell rail** (`terminals.js:1902` `buildTeamsForShell` → `shell.js:590-696`) — **this is the
  start affordance**: a dormant slot's click posts `ptyStartTeam` (`shell.js:674-681`). A disabled
  team must not hold a slot, or the switch is decorative and clicking it starts a team the operator
  switched off. The rail also carries live groups and is no longer defaults-only — see Change 8.
- **`resolveTeamById`** (`teamWiring.ts:1014`) → explicit start — refuse a disabled team with a
  message naming the switch. Enable-and-start would make the switch unfalsifiable.
- **`resolveDefinitionForGroup`** role-match fallback (`teamWiring.ts:1122`) — drop the
  `!g.unassigned` filter with the flag it reads.

### 3. Defaults are not deletable

Remove the delete affordance for the four in the Teams tab — absent, not a confirm gate
(`CLAUDE.md`: no confirmation dialogs, and `window.confirm` is a silent no-op in a webview). The off
switch is the replacement for deleting one.

`_deleteAgentGroup` (`KanbanProvider.ts:5500-5505`) refuses a default id and its stale comment about
a deleted built-in staying deleted goes with it. `resolveTeamById`'s on-demand re-seed
(`teamWiring.ts:1022-1030`) is then dead — a default can no longer be missing — and is deleted, not
left as a second resurrection site.

### 4. Delete `unassigned`

`unassigned` and `unassignedReason` are deleted outright — the writer in `migrateAgentGroups`
(`teamWiring.ts:794-831`), the `!g.unassigned` filters in `findTeamForHeadRole` (`:956`) and
`resolveDefinitionForGroup` (`:1122`), and the UI note that renders the reason string. No
clear-on-read shim: Change 5 resets the store, so no row survives carrying the field.

### 5. Reset the store — clean break, no migration

Teams have only ever existed in unreleased dev work, so this takes a clean break (`CLAUDE.md`:
unreleased features take clean breaks; no migrations, no compat shims). **Operator decision,
2026-09-17: existing team definitions are disposable.**

`terminals.agentGroups` is reset to the four defaults on load, once, behind a one-shot marker so a
reset does not fight an operator's later edits. Everything currently stored — the adopted
`group-coding-*` rows, the three legacy presets with `members: []`, the stale `Lead team` name, every
`unassigned` flag — goes. Nothing is preserved, archived or imported.

No repair pass, no roster-vs-operator-edit arbitration, no duplicate-head-role reconciliation. Those
three branches existed only to protect stored state that does not need protecting.

### 6. Mark the five recommended agents on the setup surface

Derive the recommended set from `DEFAULT_TEAM_DEFINITIONS` (union of `headRole` + member roles) and
mark those roles in the agents/startup-command UI as the set the shipped teams need. The other seven
roles stay available and configurable — they are not deprecated, they are just not the first-run
path.

Surface, per team, which of its roles still have no startup command. `instantiateAgentGroupCore`
already computes exactly this (`commandlessRoles`, `agentGroupInstantiation.ts:155-166`) and team
start already reports it (completed plan *Team start silently spawns bare shells for roles with no
startup command*). The gap is that the report arrives at **start** — the first-run user needs it
before, in the setup surface, as "Coding needs `lead` and `coder`."

Derived, never typed: a hard-coded list of five drifts the moment a default's roster changes, and
the failure is silent — a team whose new role nobody was told to configure.

### 7. Delete catalogue A (`agent-control.js:1017+`)

Remove `SHIPPED_TEAM_TYPES` and `teamsTabAdopt`'s fork path. The Teams tab renders the four defaults
plus operator-built teams from one list. "New team" creates an empty custom definition; it does not
fork a type.

### 8. The rail renders every team and every group

`buildTeamsForShell` (`terminals.js:1902-1914`) iterates the **module constant**
`DEFAULT_TEAM_DEFINITIONS` and uses the stored definitions only to override name and icon. Its
comment states today's rule: *"three FIXED slots — one per `DEFAULT_TEAM_DEFINITIONS` entry, in array
order… Operator-created teams beyond the three defaults are not rail slots."* `shell.js:589` agrees:
*"Teams mode (the only mode)… Exactly three fixed slots."*

**That model is retired.** The rail shows **all teams and all groups**:

- **One slot per enabled team definition** — default or operator-built, running or not. A dormant
  slot's click starts it (`shell.js:674-681`, unchanged). A disabled team has no slot; that is what
  the switch does.
- **One slot per live group** — the `grp_` rows in `terminals.groups`, the ones FILL GRID and SAVE AS
  GROUP create. A group exists only while its seats do (see `groups-are-ephemeral-teams-are-durable`),
  so its slot comes and goes with it. **There is no dormant group, and a group is never made durable.**

  Operator decision, 2026-09-17: *if a user wants a lasting group, they start a team.* That is the
  whole distinction between the two kinds, and it is why the rail can carry both without a mode
  switch — a team slot persists and can be started; a group slot only ever reflects something already
  live. Any future request to "save" or "restore" a group is answered by making it a team.
- **Unassigned seats get no slot.** An agent in no team and no group is shown by the **terminals panel
  icon** — clicking it opens the fleet view, which is where ungrouped seats live. The rail is for
  named arrangements; the panel is the default for everything else.

Good news on the mechanics: there is **no hard limit of three** — it is a `for…of` over the array, so
the count was never the constraint, only what it iterated. And `buildTeamsForShell` already holds both
inputs it needs: `_agentGroupsCache` (definitions) and `terminalGroups` (live rows, both kinds,
told apart by `isSpawnedTeamGroup`, `terminals.js:1794-1799`).

**A group slot must never post `ptyStartTeam`.** The click handler's three arms
(`shell.js:643-693`) are: running + `groupId` → switch the terminals panel into that scope; running +
head, no `groupId` → focus the head; otherwise → start. A group has no definition to start, so it
must take the first arm only. Falling through to the start arm would post a `teamId` that resolves to
nothing — and `resolveTeamById` re-seeds on a miss today (Change 3 deletes that, so the order of these
two changes matters).

Naming, since both kinds now sit in one strip: a team slot and a group slot must be
distinguishable at 22px. The strip already carries a per-team initial and role-coloured jet; groups
need their own mark rather than borrowing the team jet, or the rail says two different things with
one picture.

## Verification Plan

### Automated

- The recommended agent set computed from the **enabled** defaults is exactly `planner`,
  `researcher`, `lead`, `coder`, `reviewer` — asserted against the defaults, not against a literal, so
  changing a default's roster changes the assertion's expected value by construction.
- Enabling a disabled team whose roles have no startup command reports the commandless roles rather
  than starting into bare shells.
- With all five configured, each enabled default reports zero commandless roles; with none
  configured, each reports its own roles and no team is silently startable into bare shells.
- The rail payload carries one entry per enabled team (running or not) plus one per live `grp_`
  group, and none for a disabled team or an ungrouped seat. A group entry is not startable — assert
  no `ptyStartTeam` post is reachable from it.
- A fresh board seeds exactly four definitions with the four fixed ids; Planning, Coding and Review
  are `enabled: true`, Multi-agent planning `enabled: false`, all four `enabledSource: 'default'`.
- Deleting a default is refused and the definition is still present after a reload.
- A disabled team: absent from `ptyListAgentGroups`, present in `listAgentGroups` with its flag,
  refused by `resolveTeamById`, and **does not appear in `migrateAgentGroups`' collision
  resolution** — enabling Multi-agent planning must not mark Planning `unassigned` (the field no
  longer exists; assert its absence).
- Reset: a board holding the legacy presets and an adopted `group-coding-*` comes back holding
  exactly the four defaults and nothing else; the reset runs once, not on every load.
- `unassigned`/`unassignedReason` appear nowhere in the source or in a seeded definition.
- The moved head-prompt copy still satisfies `coding-head-prompt-contract` and
  `standing-orders-marker-contract` (run `npm run compile-tests` first — contract suites run against
  `out/`).

### Goal invariants

- A team that exists is not necessarily a team that plays. Switching one off changes what the board
  does, not what it remembers.
- Every membership read can answer "which source decided this team is in play?"
- There is one catalogue.
- Two teams sharing a head role is unremarkable. No team is demoted, flagged, hidden or refused for
  declaring the same `headRole` as another.
- A new user configures agents, never teams. No team configuration step exists on the first-run path.
- Nothing starts because the host booted.
- Every named arrangement — team or group — is reachable from the rail. Everything unnamed is
  reachable from the terminals panel icon.

### Manual

Fresh board: three teams live, Multi-agent planning present and greyed. Switch it on, switch Planning
off, restart the host, confirm the states survive. Confirm no default can be deleted and no confirm
dialog appears anywhere.

## Outstanding Questions

- **[ANSWERED 2026-09-17 — NO QUICK CODING TEAM]** A fifth "Quick coding" default (lead + coder +
  intern, for batches of unrelated low-complexity cards) was proposed and dropped. Its whole
  behaviour — dispense one at a time, lead reviews, no parallelism analysis — is either what the
  Coding head prompt already does or what the Dispatch queue already does without a team. The
  backlog case is the queue plus one seat, not a team.

- **[ANSWERED 2026-09-17 — ALL TEAMS AND GROUPS]** The rail is not defaults-only and is not
  teams-only. It renders every enabled team (default or operator-built) and every live group.
  Unassigned agents are not rail entries — they are the default view behind the terminals panel icon.
  The "three fixed slots, defaults only" model in `terminals.js:1731-1737` and `shell.js:589-591` is
  outdated and goes.

- **[ANSWERED 2026-09-17 — PEER PLANNERS]** Default #4 is the peer-planner topology from
  `Multi-Agent Planning Team — Fan-Out Head Prompt and Peer-Planner Roster`, not catalogue A's
  fan-in researcher+analyst roster. The fan-in shape is Planning with a bigger roster — the same
  duplication "Batch planners" was cut for — and it ships with no `headPrompt`, so its head plans
  alone beside three idle seats. That card lands first; this plan seeds default #4 from it and does
  not fork its own copy.
- **[ANSWERED 2026-09-17 — RESET]** Existing team definitions are disposable; teams are unreleased
  dev work. No migration, no fold, no preservation of the adopted `group-coding-*` row. Change 5 is a
  reset.
