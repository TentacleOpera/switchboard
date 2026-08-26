# Three Fixed Team Slots In The Rail, Present Whether Or Not The Team Is Running

## Goal

Replace the rail's variable-length team list with exactly three fixed slots, one per
default team, bound by team definition rather than by what happens to be spawned. A slot
whose team is not running renders dim and starts that team on click. The rail's height
stops being a function of fleet state.

### The problem, and the root cause

`renderTerminalSection` (`src/webview/shell.js:1147`) iterates the `teams` array from
`buildTeamsForShell` (`terminals.js:1668`), which emits one entry per **spawned** team
group (`isSpawnedTeamGroup(g)`, `terminals.js:1645`). So teams appear and disappear from
the rail as they are started and stopped, and every icon below them moves. There is no
slot for a team you have not started yet, which means the rail can tell you what is
running but never what is *available* — starting a team requires going to the Agent
Control panel first.

The team-definition layer is also thinner than the rail needs. `teamWiring.ts` seeds one
team (`SEEDED_AGENT_GROUP`, `:700` — id `feature-implementation`) and *offers* a second
without seeding it (`OFFERED_REVIEW_TEAM_GROUP`, `:707` — id `review-team`, listed in
`OFFERED_TEAM_DEFINITIONS`). A planning team exists in the plan record
(`feature_plan_20260819_multi-agent-planning-team-fan-out-head-and-peer-planner-roster.md`,
`teams-tab-three-presets-and-phone-a-friend.md`) but not as a seeded definition. So "the
three default teams" is not a thing the code can currently enumerate.

## Metadata
- **Complexity:** 6
- **Tags:** frontend, backend, ui, ux, feature
- **Feature:** 4c1323fb-a025-467f-b289-88f50b1f8347

## No migration

Clean break. Three team definitions are seeded unconditionally, replacing whatever
`terminals.agentGroups` holds for those three ids. Do NOT write a migration, do not
preserve prior user edits to those rows, and do not compare against
`OLD_SEEDED_AGENT_GROUP` (`teamWiring.ts:728`) — that comparison exists for a migration
this release is not doing. CLAUDE.md's migration rule is explicitly waived.

Team *names* are the operator's to set and are being renamed outside this plan. This plan
therefore keys every binding on **definition id**, never on a display name, and must not
assert any particular name in code or tests.

## Scope: both composition roots

Seeded definitions are read through the agent-groups path in both hosts. The rail's slot
binding is served through the fleet relay in `terminals.js`, shared by both. Verify the
seed lands in both — `TaskViewerProvider.ts` and `bootstrap.ts` each own their own
config read.

## Implementation

1. **Declare three default definitions in `teamWiring.ts`,** each with a stable id and a
   head role — the head role is the durable identity, the name is decoration:
   - planning team — head `planner`
   - coding team — id `feature-implementation` (reuse the existing id; it is already
     seeded and reusing it avoids a second row meaning the same thing), head `lead`
   - review team — id `review-team`, head `reviewer`
   Export them as an ordered `DEFAULT_TEAM_DEFINITIONS` array. Rail order is array
   order — the rail must not sort, because it cannot know definition order (the same
   constraint `shell-strip-team-icons-instead-of-per-terminal-cli-icons.md` records).
   Retire `OFFERED_TEAM_DEFINITIONS` / `OFFERED_REVIEW_TEAM_GROUP` in favour of it.
2. **All three are member-less.** A member-less team starts only its head. This is the
   `SEEDED_AGENT_GROUP` precedent (`teamWiring.ts:694`) and it is what keeps seeding
   three rows from spawning a fleet of unrequested agent CLIs on first run.
3. **`buildTeamsForShell` emits slots, not spawned teams.** Iterate
   `DEFAULT_TEAM_DEFINITIONS`, and for each look up a live group by definition id. Emit
   `{ definitionId, name, iconUri, running: boolean, groupId: string|null, ... }`. Always
   three entries, always in the same order.
4. **A fourth team is not a rail slot.** Operator-created teams beyond the three defaults
   do not appear in the rail; they live in the Agent Control and Terminals panels. State
   this in the code comment — otherwise the next change re-grows the rail.
5. **Slot rendering in `renderTerminalSection`.** Running slots render as today (accent
   glyph per the colour plan). Dormant slots render dim, using the
   `.strip-icon.is-dormant` class promoted out of the UFO's
   `#strip-mission-control.mission-control-dimmed` rules (`shell.html:267`: `opacity .35`
   + grayscale). **Ordering dependency:** the rail restructure plan deletes the UFO and
   its CSS. The promotion has to happen before or in that deletion, or these slots have no
   dim state. Do not re-add a bespoke dim treatment here — one class, two former users.
6. **Click behaviour, two arms.**
   - **Running** → unchanged: `selectPanel('terminals')` then post `switchToTeam` with
     the live `groupId` (`shell.js:1224`).
   - **Absent** → start that team. Reuse the start path the Agent Control panel's team
     start already uses (`btn-start-team`, `terminals.html:2401`) rather than minting a
     second start route. Carry over the in-flight discipline the UFO's start used
     (`shell.js:302-315`): disable the button while the start request is pending so a
     double-click cannot fire two starts, while the actual protection stays the
     service-level guard in `ptyFleetService.create()` — a client flag was never
     sufficient there (two shell tabs, a reload mid-flight) and is not sufficient here.
     **No confirmation dialog** (CLAUDE.md).
7. **Rail height is now constant** at 5 primary + 3 slots + 4 cold = 12 buttons,
   independent of fleet size. That is the point of the plan; assert it in a test.

## Edge cases

- **A default team's definition deleted by the operator.** The slot must still render
  (dim) and starting it must re-seed the definition, or the rail acquires a permanent
  dead button. Decide explicitly: re-seed on demand.
- **Two live groups claiming one definition id.** Possible if a group is duplicated.
  Bind to the first by stable order and comment why; do not render two slots.
- **Start fails** (no head role configured, node-pty absent). Surface it through
  `showStripToast` (`shell.js:318`) and leave the slot dim. Never leave the button
  disabled after a failed start. Note that helper was written for the UFO's start
  feedback: the rail restructure plan deletes the UFO, so this plan is what keeps
  `showStripToast` alive. Whichever lands second must not delete it.
- **Terminals panel absent.** `frames.has('terminals')` gates the whole fleet section
  (`shell.js:1067`). With no Terminals panel there is no team scope to switch to, so the
  slots must not render at all — same fail-closed test the section already makes.
- **Icon fallback.** `team.iconUri` may be absent. The existing two-deep fallback ends at
  a role letter (`shell.js:1189`); the interceptor plan replaces that with the jet glyph.
  Whichever is current, an empty button is not acceptable — the rail is primary
  navigation.
- **Queue depth on an absent slot** is meaningless; suppress the fetch for non-running
  slots rather than requesting `/terminals/teams/<null>/queue`.

## Verification plan

1. `npm run compile` clean.
2. Fresh workspace, zero teams started: rail shows exactly three dim team slots in
   declared order.
3. Click each dim slot; confirm the team's head starts, the slot lights, and no second
   terminal is created by a rapid double-click.
4. Stop a team; confirm its slot returns to dim and **no icon below it moves**.
5. Create a fourth operator team; confirm no fourth rail slot and that it is reachable in
   Agent Control and Terminals.
6. Spawn nine terminals across the three teams; confirm the rail is still 12 buttons.
7. Delete a default team definition, then click its slot; confirm re-seed and start.
8. Both hosts — and confirm the seed lands in both, since each reads its own config.
