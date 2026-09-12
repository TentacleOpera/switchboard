# Delete Auto-Start

## Goal

Remove auto-start. Nothing should spawn a fleet because the host came up. A team is started by the
operator, or by the controller agent, when there is work for it.

Operator decision, 2026-09-09: *"we probably shouldn't have any auto start teams… the user can set up
teams, the controller agent can start them."*

**This is a deletion, not a redesign.** Dispatch behaviour is explicitly out of scope; the capability
to start a team already exists and is already reachable by an agent.

> **Verified this session (line drift):** the boot sweep is `startTeamsOnLoad` at
> `TaskViewerProvider.ts:14293` (plan originally cited `:14105-14139`; file grew ~165 lines). It is
> called from `extension.ts:1250` and `bootstrap.ts:5261` — **both hosts**, so the deletion must
> touch both call sites. The `marked` filter is at `:14304`.

### Why: no admission control, and boot is the worst moment

**Nothing consults memory before spawning.** `grep -rnE "freemem|totalmem|MemAvailable"` over `src`
returns nothing outside tests. The only admission control is a pair of counts
(`src/services/ptyLimits.ts`):

```ts
export const MAX_DELEGATES_PER_PARENT = 8;
export const MAX_LIVE_DELEGATE_PTYS = 32;
```

At the per-seat cost measured on a Pi 400 — a working `agy` coder is ~250 MB RSS — **32 delegate PTYs
is about 8 GB**: four times the total RAM of the 2 GB box the site advertises as the minimum, and
twice the recommended 4 GB.

**Auto-start is unbounded.** `TaskViewerProvider.ts:14139` starts every marked team, once per host,
with no ordering or throttle:

```ts
const marked = (teams || []).filter(t => t && t.startOnLoad === true);
```

**The arithmetic, measured on this box:**

| | measured |
|---|---|
| controller (host process RSS) | ~486 MB |
| `devin` seat (lead/planner) | 60–84 MB |
| `agy` seat (coder/intern) | ~250 MB |
| one 4-seat coding team | ~830 MB |
| 3 teams + controller | **~3.0 GB** |

On 4 GB that leaves little for the OS and a browser. On the advertised 2 GB minimum, three marked
teams cannot fit at all.

**Boot is worse than the steady state.** Auto-start spawns every seat at once and each CLI's heap
peaks while initialising, so real demand exceeds that table at exactly the moment nothing has settled
enough to shed load.

**And the failure compounds.** The OOM killer goes by resident size, so the likely victim is the
controller (~486 MB). If it dies the board goes with it — but the seats **survive**, because they are
children of the tmux server, not of the host. The operator restarts, auto-start tries again, and each
pass leaves another generation of orphans. This session found exactly that residue: 8 orphaned seats
holding ~1.5 GB across two host restarts, unreaped.

### The start path already exists

Nothing needs building to replace auto-start:

- **Agent-reachable:** the `ptyStartTeam` verb (`src/standalone/bootstrap.ts:2121`) takes a `teamId`
  and calls `kanbanProvider.startAgentGroupById` (:2146). Available over the local API, so the
  controller agent starts a team the same way the UI does.
- **Operator:** the terminals panel's START TEAM button, and `startTeamForWorkspace`
  (`TaskViewerProvider.ts:14038`).

## Metadata

**Complexity:** 2
**Tags:** reliability, memory, startup, teams
**Dependencies:** none. **Amends**
`two-teams-can-share-a-head-role-and-routing-decides-between-them`, whose adopted policy was to
auto-start every `startOnLoad` team — that policy goes away with the feature. (Note: the
`Team Wiring` plan, subtask 1, is independent — it does not touch the boot sweep.)

## User Review Required

None.

## Complexity Audit

### Routine
- The boot sweep is one method (`startTeamsOnLoad`, `TaskViewerProvider.ts:14293`) with two call sites (`extension.ts:1250`, `bootstrap.ts:5261`). Deleting the method + the two calls is mechanical.
- The `startOnLoad` field is a boolean checkbox; clear-on-read is a one-line migration in the team-model reader.
- The replacement paths (`ptyStartTeam` verb `bootstrap.ts`, START TEAM button / `startTeamForWorkspace`) already exist and are unchanged.

### Complex / Risky
- **`startWorktree` coupling.** The UI deletes `startWorktree` alongside `startOnLoad` (kanban.html:5431-5432) and only shows the worktree input when `startOnLoad` is checked (kanban.html:5405). But `startWorktree` is load-bearing for MANUAL start: `startAgentGroupById` (KanbanProvider:5112) and `startTeamForWorkspace` (TaskViewerProvider:14226) both read it as the spawn cwd / worktree-provision trigger. Retiring it with `startOnLoad` would silently drop a manual start's worktree. The field must stay; only the UI input's gating must move.
- **Orphan reaping (out of scope, noted).** The tmux server outlives the host, so crash-orphans accumulate regardless of auto-start. Deleting auto-start stops new auto-start orphans but does not reap existing ones. This plan does not address reaping; it is a follow-up, not a blocker for the deletion.

## Edge-Case & Dependency Audit

- **Race Conditions:** none. The boot sweep runs once per host launch under a `_teamAutostartDone` latch (`TaskViewerProvider.ts:14299`); deleting it removes the only writer.
- **Side Effects:** removing `startTeamsOnLoad` leaves `_teamAutostartDone` and `listTeamsInRoots` callers unused — dead code to prune in the same pass. The `startOnLoad` clear-on-read must preserve every other field on the stored team definition (icon, pacing, headPrompt, members) — clear only the `startOnLoad` key.
- **Dependencies & Conflicts:** amends `two-teams-can-share-a-head-role-and-routing-decides-between-them` (its auto-start policy is removed). No conflict with subtask 3 (phantom team) or subtask 1 (team wiring): neither touches the boot sweep. `startWorktree` is shared with the manual-start path — see Complex/Risky above.

## Dependencies

- Amends `two-teams-can-share-a-head-role-and-routing-decides-between-them` — its auto-start-every-startOnLoad policy is removed by this deletion.

## Adversarial Synthesis

Key risks: (1) retiring `startWorktree` with `startOnLoad` silently breaks manual-start worktree provisioning, because the field is read by `startAgentGroupById`/`startTeamForWorkspace` on every start, not only at boot; (2) the plan raises an orphan-reaping problem it does not solve, which a reader may mistake for scope. Mitigations: retire only `startOnLoad`; move the UI worktree input out from under the auto-start gate so it stays authorable; record orphan reaping as an explicit out-of-scope follow-up so it is not silently dropped.

## Proposed Changes

### 1. Delete the boot sweep

- Remove the `startTeamsOnLoad` boot sweep at `TaskViewerProvider.ts:14293-14356`, and its two call
  sites: `extension.ts:1250` and `bootstrap.ts:5261`. Prune the now-dead `_teamAutostartDone` latch
  (`TaskViewerProvider.ts:14299`) and any `listTeamsInRoots` caller that existed only for the sweep.

### 2. Retire the `startOnLoad` field (NOT `startWorktree`)

- Remove `startOnLoad` from the team model and stop persisting it. Stored definitions carrying it
  have it cleared on read rather than migrated in place — it is a checkbox, not data anyone loses,
  and a stored `startOnLoad: true` that does nothing is the fallback-indistinguishable-from-a-value
  anti-pattern, so clearing is correct.
- Remove the auto-start checkbox control from the teams UI in the same pass, or the setting appears
  to do nothing.
- **Do NOT retire `startWorktree`.** It is the team's spawn cwd, read by `startAgentGroupById`
  (`KanbanProvider.ts:5112`) and `startTeamForWorkspace` (`TaskViewerProvider.ts:14226`) on every
  start, manual included. The UI currently gates the worktree input behind the `startOnLoad`
  checkbox (`kanban.html:5405`) and deletes both together on un-check (`:5431-5432`). Decouple them:
  move the worktree input out from under the auto-start gate so it stays authorable for manual
  starts; keep the `startWorktree` field and its `prevGroup?.startWorktree` rescue
  (`kanban.html:6315`, `team-autostart-workspace-scope.test.js:375`).

## Verification Plan

### Automated Tests

- `test:contract:no-autostart-on-boot` (new): a host started with teams configured spawns no seats.
  Assert on the live terminal registry being empty, not on intent.
- `ptyStartTeam` still starts a team when called — the replacement path must not regress alongside the
  feature it replaces.

### Goal Invariants

- A freshly started host has no live seats until something asks for one.
- No code path reads `startOnLoad`.
- **Negative:** `startWorktree` is NOT retired — it remains on the team model and is still read by
  `startAgentGroupById` (`KanbanProvider.ts:5112`) and `startTeamForWorkspace`
  (`TaskViewerProvider.ts:14226`); the UI worktree input remains authorable independent of the
  (now-removed) auto-start checkbox.
- **Paired positive:** the auto-start checkbox is gone from the teams UI, and `startOnLoad` is
  cleared on read from stored definitions.

### Manual

1. Configure three teams, reboot: nothing starts, memory is idle, the board is reachable.
2. Start one team from the panel: it starts.
3. Have the controller agent call `ptyStartTeam`: it starts.
4. A team with `startWorktree` set, started manually, still spawns into its worktree.

## Resolved: nothing relies on a team being live at boot

The Outstanding Question — "does anything else rely on a team being live at boot?" — is resolved by
code reading this session: **no.** `ScheduledJobsService` lazily creates `.switchboard/teams/<id>/reports`
and `.switchboard/mission-control/reports` directories on demand (`bootstrapTeamReportsDirectory`,
`bootstrapMissionControlReportsDirectory`), not at boot. The `PlanIngestionEngine` queue watch arms on
dispatch, not on host boot. No scheduled mission or queue watch reads a live team at boot. Deleting
the boot sweep is safe on this axis.

## Out of scope (noted, not blocked)

- **Orphan reaping.** The tmux server outlives the host, so crash-orphans accumulate regardless of
  auto-start. This plan stops new auto-start orphans but does not reap existing ones. A separate
  plan should reap seats whose host is gone.

## Implementation Summary

Deleted the boot-time team auto-start feature across six files. Change 1 (delete the boot sweep):
removed `startTeamsOnLoad` and its `_waitForPtyHost` helper from `TaskViewerProvider.ts`, the
`_teamAutostartDone` latch field, and both call sites (`extension.ts` activation,
`bootstrap.ts` beside `restoreAutobanOnStartup`); a host coming up now spawns nothing. Change 2
(retire `startOnLoad`, keep `startWorktree`): added a clear-on-read step to `migrateAgentGroups`
in `teamWiring.ts` that strips `startOnLoad` from stored definitions on read and flags `changed` so
the cleaned shape is persisted (the `_loadAgentGroups` mutator already persists the converter
output), preserving every other key; removed the START ON LOAD checkbox and its CSS from
`kanban.html` and dropped `startOnLoad` from the `teamsTabSaveAgentGroup` save literal, but kept
the `startWorktree` input — now always visible for adopted teams, no longer gated behind the
removed toggle — because `startAgentGroupById` and `startTeamForWorkspace` both read it on manual
starts. Updated `team-autostart-workspace-scope.test.js`: replaced the four source-text contracts
that pinned the deleted feature (tests 19-22) with five new contracts asserting the deletion
(`startTeamsOnLoad` absent from both hosts), the clear-on-read migration (strip + idempotence),
and the field-carry split (`startWorktree` carried, `startOnLoad` not). Stale comments referencing
"auto-start" in `extension.ts`, `bootstrap.ts`, and `TaskViewerProvider.ts` were corrected. No
compilation or automated tests were run per the run's skip directives; the plan's verification
section remains for later execution.

## Review Findings

The deletion is complete and correct in both roots: `startTeamsOnLoad`, `_waitForPtyHost` and the `_teamAutostartDone` latch are gone from `TaskViewerProvider.ts`, both call sites (`extension.ts` activation, `bootstrap.ts` beside `restoreAutobanOnStartup`) are removed, `migrateAgentGroups` strips `startOnLoad` on read while preserving every other key, and `startWorktree` is untouched and still carried by `teamsTabSaveAgentGroup` — grep confirms no code path reads `startOnLoad` anywhere. One UI fix applied: removing the checkbox also removed the only label in that card row, leaving an unexplained text box on every adopted team card, so the worktree input is now labelled WORKTREE using the already-styled `.teams-card-autostart-label` class. Files changed: `src/webview/kanban.html`. Validation: `test:contract:team-autostart-scope` runs the five deletion contracts green (its one failure, `resolveTeamByIdInRoots` returning `/pinned` instead of `/selected`, reproduces at this plan's parent commit and is unrelated).

## Deferred Findings

- NIT `src/test/team-autostart-workspace-scope.test.js:346` — the plan asked `no-autostart-on-boot` to "assert on the live terminal registry being empty, not on intent"; the implemented checks are source-text assertions that the identifier is absent. Adequate for a total deletion, weaker than the plan specified.
- NIT — the cross-window debounce row `terminals.autostart.lastRunAt` is now an orphan: its only writer was deleted, so existing boards keep a config key nothing reads or clears.
- NIT — orphan reaping remains out of scope, as the plan states.
