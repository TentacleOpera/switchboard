# The command console's card actions match the board

**Complexity:** 3

## Goal

Make the command surface behave like the board it fronts. Today its three card actions are each wrong in a different way: advancing a card calls the coding-seat router instead of the board's advance verb, so every card jumps to a coding column; moving a card fails outright on the standalone host because the moveCard seam is unwired; and the column lists it offers are the built-in catalogue rather than this board's enabled columns, so they include stages with no agent behind them. Each subtask fixes one of those by calling or reading what the board already uses, rather than adding a parallel mechanism to the console.

## How the Subtasks Achieve This

- **move-card.js's direct-DB fallback must go, and /kanban/move must accept a batch**: deletes
  the second write path whose result was indistinguishable from a real move, widens the route to
  take `planIds[]` so one operator gesture is one request, and makes the 503 name the missing
  seam. **The seam wiring itself is not in this feature** — it is owned by
  `wire-the-sixteen-unwired-localapiserver-seams-in-standalone.md` (planId
  `417980bd-e8d9-4465-b301-0857c39ee3d7`, already in PLAN REVIEWED), which covers `moveCard`
  plus fifteen sibling seams. That plan must land first, or deleting the fallback leaves
  standalone with no working move at all.
- **The command console never implemented advance**: replaces the console's private routing with
  a thin `POST /kanban/advance` over the `kanbanVerb` seam the dispatch handler already uses,
  sending the card's current column and letting the backend resolve the next stage exactly as
  the board's advance button does. This is the subtask that makes a card in New go to Planned
  instead of straight to a coder.
- **GET /kanban/columns publishes the built-in catalogue**: joins `agents.visibleAgents` into
  the columns response and tags each entry with `enabled` / `enabledSource`, so the console's
  dropdowns stop offering stages this board does not run. Advance is immune (it never sends a
  destination), but every column list on the surface — and every agent skill pointed at this
  endpoint as the live mapping — depends on it.

Together they remove the console's three parallel mechanisms and leave it calling the board's
own verbs and reading the board's own configuration.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [POST /kanban/move is unwired in the standalone host, so every remote card move fails 503 and the only recovery path is a raw DB write](../plans/kanban-move-is-unwired-in-the-standalone-host.md) — **CREATED** — ID: 1946ee61-5e32-4663-8ddc-7cb0b45d4cc0
- [ ] [The command console never implemented advance — it calls the coding-seat router directly, so every card jumps to a coding column](../plans/command-console-dispatch-reads-as-an-advance.md) — **CREATED** — ID: c73ea0da-6d96-41fa-81ed-95f2134e5ef1
- [ ] [GET /kanban/columns publishes the built-in catalogue instead of this board's columns, so clients offer Researcher and Ticket Updater to a board that has neither](../plans/column-reads-publish-the-catalogue-not-the-board.md) — **CREATED** — ID: d8cc4d79-ff07-4730-804d-fde66f617ac6
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints — the three subtasks touch different seams and can be executed in
parallel. Two soft orderings are worth knowing, and neither blocks a coder:

- The **advance** subtask is independently shippable and delivers the reported bug fix on its
  own; it does not wait on the other two.
- The **Move view** depends on work partly outside this feature.
  `wire-the-sixteen-unwired-localapiserver-seams-in-standalone.md` (PLAN REVIEWED, external to
  this feature) wires the `moveCard` seam; subtask 1 here must land **after** it, never before.
  Move is then only fully verifiable once the column lists are also correct (subtask 3), since
  its target dropdown is fed by `GET /kanban/columns`.
- **Multi-card selection** is delivered by the advance subtask (the console's selection state is
  shared by both views), while the batch `planIds[]` form for the move route is in subtask 1.
  Both must land for a batch *move*; a batch *advance* needs only the advance subtask.

Each subtask's verification runs on **both** composition roots — the standalone host and the
installed VSIX. Subtask 1 exists because those two roots had drifted, so a same-host-only pass
would miss the whole class of defect.

