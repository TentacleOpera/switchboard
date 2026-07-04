---
description: 'Agent activity lights & frontmatter state signaling'
---

# Agent activity lights & frontmatter state signaling

## Goal

Give Switchboard two things it structurally lacks today: (1) a way for agents to
**advance a card's column by writing plan-file frontmatter** instead of a separate
`manifest.json` RPC, and (2) a way to **see whether an agent is currently working on
a card** — a per-card "activity light" that turns on when the card is dispatched and
turns off when the agent signals completion (or after a safety timeout).

### Core problem & background

Switchboard's kanban state is **DB-owned**: a plan's `kanban_column` and `project`
live only in `kanban.db`, never on disk (`updateColumnByPlanFile` at
`src/services/KanbanDatabase.ts:1554` writes the DB and does not touch the `.md`).
Remote agents that can't reach the extension's local API server therefore cannot
change state directly. Two gaps follow from this:

1. **Transitions need an out-of-band channel.** Remote agents advance a card by
   dropping a `manifest.json` sidecar that `PlanManifestService` ingests then deletes
   (`src/services/PlanManifestService.ts`). This subsystem — staleness guard, stale-move
   `fromColumn` guard, consume-then-delete, plus producer instructions duplicated across
   ~6 skill docs — exists **solely** because the `.md` can't express a column move. The
   watcher already reads `**Project:**` from frontmatter (`planMetadataUtils.ts:96`) and a
   `kanbanColumn:` token, but `insertFileDerivedPlan` hardcodes `'CREATED'` on insert and
   omits `kanban_column` from its ON-CONFLICT update (`KanbanDatabase.ts:1457-1465`), so a
   file cannot advance an already-imported card.

2. **No completion signal.** Once a card is dispatched, Switchboard has **no idea when
   the agent finishes**. There is no `dispatched_at`/`working` column and no per-card
   activity indicator (`createCardHtml` at `src/webview/kanban.html:5416` renders only
   complexity + epic-subtask-count; card-level live-sync indicators were deliberately
   removed, per the comment at `kanban.html:5424-5426`). The user cannot tell a stuck agent
   from a busy one from a finished one.

### Root cause

Both gaps are the same shape: **the extension has no channel for an agent to report
state back through a plan file.** The fix is a small, uniform "agent → watcher via
frontmatter" convention plus the DB/UI plumbing to surface it.

### Design decisions (settled with the user)

- **Column moves and the activity light are DECOUPLED.** Column moves happen *in
  advance* — a card is dispatched into its stage column, so it is already in the right
  column while the agent works. The completion marker therefore only turns the light
  **off**; it never moves a card. (This is why the two workstreams below stay separate
  rather than being folded into one "stage complete = advance + clear" signal.)
- **Light lifecycle:** dispatch turns the light **ON**; a mandatory `**Stage Complete:**`
  frontmatter marker written by the agent (or a 20-minute timeout) turns it **OFF**.
- **Ship as an epic** so each seam is coded and reviewed independently.

## How the Subtasks Achieve This

Two workstreams under one theme (agent → extension signaling via plan-file frontmatter):

**Workstream A — Frontmatter-driven column transitions (retire manifest.json)**
- `column-transition-frontmatter-retire-manifest.md` — teach the watcher to honor a
  `**Column:**` transition-intent line on existing rows (guarded exactly like the
  manifest's `fromColumn`), then deprecate `manifest.json`. Independent of the light work.

**Workstream B — Agent activity light** (build in this order; 2 is the foundation)
- `working-state-model-and-dispatch-on.md` — add the `dispatched_at` column + migration,
  thread a `working` flag through the `KanbanCard` payload and the board re-render
  signature, and set the flag ON at every dispatch site (centralized in
  `_recordDispatchIdentity`).
- `stage-complete-marker-clears-working-state.md` — parse a `**Stage Complete:**` marker
  in the watcher's update branch and clear the working flag.
- `stage-complete-prompt-directive.md` — inject a mandatory "append `**Stage Complete:**`
  when done" directive into every dispatched prompt (batch + custom).
- `working-state-timeout-sweep.md` — in the 10s periodic scan, clear working state for
  cards whose `dispatched_at` is older than 20 minutes (the forgot-the-marker fallback).
- `card-working-light-ui.md` — render the light on the card and ensure it re-renders on
  state change.

Subtask B-2 depends on B-1 (the flag/column). B-3, B-5, B-6 all depend on B-1. B-4 is
independent code but defines the marker B-3 parses. Workstream A is independent of all of B.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] (no subtasks)
<!-- END SUBTASKS -->
