# The Dispatch Column Becomes the Session Queue — Select Plans, Press Run, Walk Away

## Goal

The user selects a set of plans, stages them, and presses one button. That ordered set is the night's work. The first card dispatches immediately; the lead pulls the rest. No run sheet to configure, no interval to pick, no mode to choose.

### Problem & background

**The queue already exists and is currently used as a fan-out bucket instead of a queue.**

`DISPATCH` is a real stored column value rendered inside `PLAN REVIEWED`'s slot, toggled by a header button (`DISPLAY_MODE_COLUMNS`, `src/services/agentConfig.ts:165`). It already has:

* a staged-card count on its toggle (`kanban.html:7689` counts `column === 'DISPATCH' && !c.featureId`, rendered as `DISPATCH n` at `:7699`);
* multi-select across the board (`selectedCards`, `kanban.html:5676`);
* a `Send all to coders` action (`sendDispatchSetToCoders`, `src/services/KanbanProvider.ts:10767`).

So the staging concept, the visible count, and the selection mechanism are all built. What is missing is that `Send all to coders` **fans the entire set out at once** — it partitions by complexity route and dispatches every staged card to a routed coder in one press (`:10792-10821`). That is the opposite of a paced queue: it empties the staging area into N simultaneous dispatches, and pacing afterwards is nobody's job.

**Ordering is also absent.** Cards in `DISPATCH` have no queue position; they are read in whatever order the board hands them over. A user staging "do the schema change before the endpoints that depend on it" has no way to express it.

### Root cause — staging was designed for parallel fan-out, and the paced case was never given a door

The comment at `kanban.html:8275` states the intent plainly: cards enter `DISPATCH` via the Analyze button, an agent-led decision about what can run in parallel. That is a legitimate mode and is not being removed. But it left the *serial* case — one team, one card at a time, overnight — with nothing to press. The three automation modes were the answer, and they answered a question the staging column was already 80% shaped to answer.

### Why this is the cold start

Plan 1 lets a lead ask for card N+1. Nothing dispatches card 1. That is the only genuine gap a pull model opens, and it is a button, not a subsystem: press Run, the first card dispatches, the standing order carries the lead from there.

---

## Metadata

- **Complexity:** 4
- **Tags:** frontend, backend, ui, feature

---

## User Review Required

**None.** Four decisions made here:

* **`DISPATCH` is the queue — no new state, no new column.** A parallel "session queue" table would duplicate a staging area that already exists, is already visible, and already has a count badge.
* **`Send all to coders` is kept, not replaced.** Parallel fan-out stays for the multi-coder case. `Run queue` is added beside it.
* **Order is explicit and user-controlled**, persisted on the card, not derived from complexity or insertion time.
* **Pressing Run with no team seated is an error, not an auto-start.** Seating a team is the orchestrator's job (plan 6) or the user's; a button that silently spawns agents is the kind of surprise this whole redesign is removing.

---

## Implementation

1. **Queue order on the card.** Add a nullable `queue_position` integer to the plans table, set when a card enters `DISPATCH` (append to the end) and rewritten on reorder. Null sorts last, so pre-existing staged cards behave.

2. **Reorder in the Dispatch view.** Drag within the column while `showingDispatch` is true reorders rather than moving columns. The view already special-cases `DISPATCH` drags (`kanban.html:8231-8235` notes `getNextColumn('DISPATCH')` returns null), so this is filling a branch that currently dead-ends.

3. **Stage selection.** With cards selected, a `Stage for queue` action moves them to `DISPATCH` in selection order. This is the "select a bunch of plans" half of the workflow.

4. **`Run queue` button** beside `Send all to coders` in the Dispatch header (`kanban.html:6984`). It resolves the coding head, then makes one `POST /kanban/queue/next` call — the same endpoint the lead uses, so cold start and steady state share exactly one code path. Disabled with an explanatory tooltip when no coding head is live.

5. **Queue-empty is visible.** When the last card leaves, the toggle drops back to `DISPATCH` with no count, and the board posts a transient notice naming how many cards ran. The session ending should be legible without reading a log.

6. **`queue_position` clears on dispatch**, so a card that comes back to the board later does not carry a stale position.

---

## Verification Plan

- **Unit:** `queue_position` assignment on entry, rewrite on reorder, clear on dispatch. Null-position cards sort last.
- **Unit:** `Run queue` with no live coding head returns a disabled/error path and dispatches nothing.
- **Unit:** staging a selection preserves selection order.
- **Manual UAT — the headline case:** select five plans, stage them, reorder two, press `Run queue`, and confirm all five run in the stated order with every automation mode off. Check the fourth card was dispatched after the third's review passed, not before.
- **Regression:** `Send all to coders` still fans out in parallel and is unaffected by `queue_position`.
- **Regression:** the Analyze button still stages cards into `DISPATCH` as it does today.
