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

## Dependencies & sequencing

- **Cross-feature dependencies:** none. This workstream is fully independent of the
  remote-control / board-visibility feature (per the scope note above) — different code paths,
  no shared dependency. All five subtasks close over changes internal to this feature.
- **Shipping order within the feature:**
  1. `working-state-model-and-dispatch-on.md` (B-1) **must land first** — it adds the
     `dispatched_at` column, the derived `working` flag on `KanbanCard` (at all three card-build
     sites), and the `buildBoardSignature` re-render hook. Every other subtask consumes one of
     these.
  2. `stage-complete-prompt-directive.md` (B-3) **before** `stage-complete-marker-clears-working-state.md`
     (B-2): B-3 defines and exports the shared `STAGE_COMPLETE_LABEL` constant and emits the
     directive; B-2's parser imports that same constant. If B-2 lands first, the parser
     references a not-yet-existing export.
  3. `stage-complete-marker-clears-working-state.md` (B-2) — the marker-driven OFF-switch
     (adds `clearWorkingState` + the watcher update-branch wiring). Depends on B-1 (column) and
     B-3 (label).
  4. `working-state-timeout-sweep.md` (B-5) and `card-working-light-ui.md` (UI) depend **only**
     on B-1 (the `dispatched_at` column / `working` flag / signature). They are independent of
     B-2 and B-3, so they can proceed in parallel with the B-3 → B-2 chain once B-1 has landed.
     B-5 is the timeout backstop; UI is the visible dot. Land them in either order.
- **Prerequisites / guards:**
  - The single shared `STAGE_COMPLETE_LABEL` constant must exist before B-2's parser uses it
    (export from `agentPromptBuilder.ts`, import into `planMetadataUtils.ts`).
  - B-1's `buildBoardSignature` change (`kanban.html:4607`) must ship with or before the UI
    subtask, or the light renders once and never updates.
  - B-1 must set `working` at **all three** card-build sites (`KanbanProvider.ts:1368-1400`,
    `~2931-2964`, `~3102-3123`) — a missed site yields a board path with no light.
  - **Open decision:** dispatches to untracked columns (BACKLOG, custom agent columns) hit
    `_recordDispatchIdentity`'s early-return at `KanbanProvider.ts:2740` and will NOT light up.
    Confirm whether that is desired or whether the early-return should be relaxed for the
    activity light (flagged in B-1's User Review Required).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [`**Stage Complete:**` marker parsing clears working state](../plans/stage-complete-marker-clears-working-state.md) — **CODER CODED**
- [ ] [Mandatory `**Stage Complete:**` directive in dispatch prompts](../plans/stage-complete-prompt-directive.md) — **CODER CODED**
- [ ] [Working-state data model + activity light ON at dispatch](../plans/working-state-model-and-dispatch-on.md) — **CODER CODED**
- [ ] [20-minute working-state timeout sweep](../plans/working-state-timeout-sweep.md) — **CODER CODED**
- [ ] [Card working-light UI](../plans/card-working-light-ui.md) — **CODER CODED**
<!-- END SUBTASKS -->
