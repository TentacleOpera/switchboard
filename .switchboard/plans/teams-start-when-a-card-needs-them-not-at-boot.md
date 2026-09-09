# Delete Auto-Start

## Goal

Remove auto-start. Nothing should spawn a fleet because the host came up. A team is started by the
operator, or by the controller agent, when there is work for it.

Operator decision, 2026-09-09: *"we probably shouldn't have any auto start teams… the user can set up
teams, the controller agent can start them."*

**This is a deletion, not a redesign.** Dispatch behaviour is explicitly out of scope; the capability
to start a team already exists and is already reachable by an agent.

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
auto-start every `startOnLoad` team — that policy goes away with the feature.

## User Review Required

None.

## Proposed Changes

### 1. Delete the boot sweep

- Remove the `startOnLoad` boot sweep at `TaskViewerProvider.ts:14105-14139`, started once per host.

### 2. Retire the `startOnLoad` field

- Remove it from the team model and stop persisting it. Stored definitions carrying it have it cleared
  on read rather than migrated in place — it is a checkbox, not data anyone loses.
- Remove the control from the teams UI in the same pass, or the setting appears to do nothing.

## Verification Plan

### Automated Tests

- `test:contract:no-autostart-on-boot` (new): a host started with teams configured spawns no seats.
  Assert on the live terminal registry being empty, not on intent.
- `ptyStartTeam` still starts a team when called — the replacement path must not regress alongside the
  feature it replaces.

### Goal Invariants

- A freshly started host has no live seats until something asks for one.
- No code path reads `startOnLoad`.

### Manual

1. Configure three teams, reboot: nothing starts, memory is idle, the board is reachable.
2. Start one team from the panel: it starts.
3. Have the controller agent call `ptyStartTeam`: it starts.

## Outstanding Questions

- Does anything else rely on a team being live at boot — a scheduled mission, a queue watch — that
  would now find no head? Worth a sweep before deleting, since that failure would be silent.
