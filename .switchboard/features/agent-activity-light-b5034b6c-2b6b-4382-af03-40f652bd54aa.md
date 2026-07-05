# Agent activity light

**Complexity:** 5

## Goal

A per-card indicator that turns on the moment a card is dispatched to an agent and off when the
agent signals completion (via a `**Stage Complete:**` marker) or a 20-minute timeout elapses. It
gives an at-a-glance answer to "is an agent actively working this card right now?" — especially
useful when dispatching remotely.

> **Scope note.** Split out of the former "Remote control … + agent activity light" feature. This
> workstream is fully independent of the remote-control/board-visibility work — different code
> paths, no shared dependency.

### Core problem & root cause

Switchboard has **no per-card activity concept**. The `plans` table has `routed_to`,
`dispatched_agent`, `dispatched_ide` but **no timestamp** — nothing records *when* an agent
started, so nothing can decide whether it is still working. There is no
`working`/`activity`/`heartbeat`/`in_progress` state anywhere in the DB or `KanbanProvider`
(`lastActivity` on `KanbanCard` is only a sort key). The light cannot exist until this state does.

### Design decisions

- **`working` is derived, not a second stored boolean** (avoids a two-field consistency problem):
  `working = dispatched_at IS NOT NULL AND no **Stage Complete:** marker cleared it AND (now −
  dispatched_at) < 20 min`.
- **Marker-driven completion, decoupled from column moves** — column moves happen in advance, so
  the light is cleared by an explicit `**Stage Complete:**` marker (or the timeout), not by a move.
- Clearing `working` is done by **nulling `dispatched_at`**, so both the marker-parse and the
  timeout sweep converge on one write.

## How the Subtasks Achieve This

(build in this order; B-1 is the foundation the rest depend on)

- `working-state-model-and-dispatch-on.md` — **(B-1, foundation)** add the `dispatched_at` column
  + migration; thread a computed `working` flag through the card payload + re-render signature; set
  it ON at dispatch (`_recordDispatchIdentity`).
- `stage-complete-prompt-directive.md` — **(B-3)** inject a mandatory "append the `**Stage
  Complete:**` marker when done" directive into every dispatched prompt. Defines the marker that
  B-2 parses.
- `stage-complete-marker-clears-working-state.md` — **(B-2)** parse `**Stage Complete:**` in the
  watcher and clear the flag (null `dispatched_at`).
- `working-state-timeout-sweep.md` — **(B-5)** clear working state older than 20 min in the
  periodic scan (the authoritative backstop for the read-time age check).
- `card-working-light-ui.md` — render the light on the card and ensure it re-renders on change.

Ordering — B-1 first; B-2 / B-4(sweep) / the UI depend on B-1; B-3 defines the marker B-2 parses.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [`**Stage Complete:**` marker parsing clears working state](../plans/stage-complete-marker-clears-working-state.md) — **CREATED**
- [ ] [Mandatory `**Stage Complete:**` directive in dispatch prompts](../plans/stage-complete-prompt-directive.md) — **CREATED**
- [ ] [Working-state data model + activity light ON at dispatch](../plans/working-state-model-and-dispatch-on.md) — **CREATED**
- [ ] [20-minute working-state timeout sweep](../plans/working-state-timeout-sweep.md) — **CREATED**
- [ ] [Card working-light UI](../plans/card-working-light-ui.md) — **CREATED**
<!-- END SUBTASKS -->
