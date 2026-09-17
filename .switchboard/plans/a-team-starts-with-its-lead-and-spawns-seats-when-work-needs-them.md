# A team starts with its lead, and spawns seats when work needs them

## The problem

Starting a team spawns every seat in the group definition at once. Each seat is
a full agent CLI process, and a Claude seat converges on ~450 MB RSS whether it
is working or sitting at an empty prompt — measured on the Pi 400 this session:
three unclaimed, never-prompted processes reached 150 MB at 4 minutes, 298 MB at
9 minutes and 423 MB at 35 minutes with no conversation at all. Idle costs the
same as busy.

Often a seat is never used for the feature at all. That is the waste: not seats
left running after work, but seats that were never needed and were spawned
anyway because the team definition listed them.

Clearing a seat does not help — `/clear` empties a context, it does not return
memory. The only lever that reclaims a seat's footprint is not having spawned it.

## The shape

A team start spawns **the head only**. Member seats spawn on first dispatch to
that role, with the task prompt carried in argv.

This is deliberately *not* idle detection. There is no "is this seat still
working" read, so there is no chance of killing a seat mid-thought, and no
membership/routing default that could quietly answer wrong. A seat that is never
dispatched to is simply never created.

Cold start is not added, it is moved: the spawn cost lands at first use instead
of at team start, and for an unused seat it is never paid.

## What already exists

- **The seam is already split on standalone.** `instantiateAgentGroupCore`
  (`src/services/agentGroupInstantiation.ts`) delegates seat creation to
  `createHeadWithDelegates`; on the standalone path that is
  `ptyFleetService.create()` followed by `spawnDelegates()` — already two calls.
  Lazy spawn defers the second, it does not restructure the first.
- **Prompt-in-argv is built and tested.** `respawnArgvSuffix(family, prompt)` in
  `cmd/switchboard-pty-host/prompt.go` already composes a shell-quoted, multi-line
  prompt into the startup command's argv — positional for `claude`, after `--`
  for `devin`. It is used today only on the Devin clear path. Delivering a task
  this way skips readiness detection entirely: no quiescence heuristic, no
  per-family boot ceiling, no clear-readiness state machine on the dispatch path.
- **The UI already models the state.** `shortfall` exists in
  `src/webview/terminals.js`, `src/services/KanbanProvider.ts` and
  `src/test/terminal-sidebar-groupings-contract.test.js` — a group whose member
  count exceeds its live terminals is already a representable, rendered state.
  Lazy spawn makes it the normal resting state rather than a transient fault.

## What has to be built

1. **Deferred delegate spawn.** `instantiateAgentGroupCore` creates the head and
   records the member definitions as *unspawned* rather than spawning them.
2. **Ensure-seat-on-dispatch.** Before a dispatch delivers to a member role,
   spawn that seat if it does not exist, using the team's machine-resolved
   startup command and the deterministic seat name. Seat names must stay derived
   from team + role, never from spawn order — stable names are what make the
   has-session / has-window reuse predicates match.
3. **Standing orders ride the argv prompt.** A lazily spawned seat still needs
   its orientation and standing orders. Composing them into the single argv
   prompt (as `respawnArgvSuffix` already does) replaces the startup-orientation
   relay for this path, rather than running both.

## Decisions this forces

- **The delegate caps move from start time to dispatch time.** Today
  `instantiateAgentGroupCore` pre-flights `MAX_DELEGATES_PER_PARENT` and
  `MAX_LIVE_DELEGATE_PTYS` before creating anything, specifically so an over-cap
  group fails as "nothing happened" instead of leaving an orphan head. Spawning
  lazily means the cap is hit mid-feature instead, and the failure mode changes
  from "the team would not start" to "the feature stalled on its fourth seat."
  Either the team start reserves its full seat count against the live cap, or
  late refusal has to surface loudly at the dispatch site. It must not be
  silent — a dispatch that could not spawn its seat looks exactly like a seat
  that received a task and ignored it.
- **The unknown-family argv arm becomes reachable.** `respawnArgvSuffix` ends in
  `default: " -- " + quoted`. That arm is dead code today, because
  `clearStrategyForFamily` returns `in-process` for every family except `devin`,
  so no unknown-family seat is ever respawned. Routing first dispatch through
  this path makes it live for every family. A CLI that takes a positional prompt
  would read `-- <prompt>` as a path argument and silently start with no task —
  the same failure shape as the `'unknown'` family borrowing Claude's readiness
  ceiling. An unrecognised family must refuse to compose an argv prompt and say
  so, not guess a separator.
- **Shared-scope members.** `scope === 'shared'` members reuse a live terminal
  and are never re-injected. Decide explicitly whether a shared member can be
  the thing that triggers a spawn, or whether shared seats stay eager.

## Scope

Standalone host only — `src/standalone/`, `src/services/agentGroupInstantiation.ts`,
and the Go pty host. The VS Code extension host is **out of scope**: it is the
legacy host being removed by the staged cutover, and wiring this seam there is
throwaway work. "The extension does not have lazy spawn" is the intended state.

## Verification

- A team start with a head and three members creates **one** pty; the fleet
  projection reports three unspawned members and the sidebar renders the
  shortfall rather than an error.
- Dispatching to one member role spawns exactly that seat, with the task present
  in its argv, and leaves the other two unspawned.
- Measured RSS after starting a four-seat team is one seat's footprint, not four.
- A team whose members would exceed the live delegate cap fails at a named,
  surfaced point — not silently, and not by leaving a running head behind.
- An unrecognised CLI family dispatched to produces an explicit refusal naming
  the family, never a `--`-prefixed guess.
- Cold-start latency for a first dispatch is recorded on the Pi 400 under load,
  so the interactive cost of deferring the spawn is a known number rather than
  an assumption.
