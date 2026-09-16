# The Board Never Refuses a Dispatch

## Goal

Delete every code path where board state can refuse to hand out work. Reduce a card to a column, a done flag, and an append-only log; make ownership advisory display metadata that no gate ever reads; and keep exactly one forward-looking record — a **checkpoint** telling a dispatcher where to resume a long-running feature or mission.

### The governing principle

**Duplicate work is not a failure mode.** If a card is dispatched twice, the agent reads the plan, sees the work is done, and says so. That costs one cheap turn. The machinery built to prevent it has cost far more than that.

Everything the board currently tracks about ownership exists to prevent a harmless outcome, and in doing so created a harmful one: a board that refuses.

**Feature-file notes, run ledgers, round records and seat assignments are guidance for efficiency. They must never gate anything.** A stale or missing note makes an agent slightly less efficient. A gate built on one stops the work entirely.

### Problem

On 2026-09-15 a coding team was wedged for about an hour. Six cards — a feature and its five subtasks — were dispatched at 22:10:34, released at 22:24:47, and still sat in LEAD CODED refusing every dispatch when the board was inspected around 23:30. Every dispatch returned:

> `409 Team already in flight: card 'e7e9f2f5-…' is in 'LEAD CODED' held by 'Coding' with no completion post.`

Nothing was wrong with the work. Real changes sat uncommitted in the tree. The board simply would not hand out anything else, because a previous attempt had left fields set and no path cleared them.

The refusal was working exactly as designed. **That is the bug.** The design goal — *stop the same card going to two seats* — is not worth a single refusal, let alone a permanent one.

### What the refusal machinery costs

To enforce a rule with no value, the board keeps sixteen fields across two tables and a JSON blob:

**`plans` (shared tier):** `kanban_column`, `status`, `routed_to`, `last_action`, `queue_position`, `column_order`, `column_entered_at`, `completed_at`, `released_at`, `outcome`, `workflow`, `dispatched_agent`, `dispatched_ide`.

**`plan_runtime_state` (machine-local, `PRIMARY KEY (plan_id, device_id)`):** `dispatched_agent`, `dispatched_ide`, `dispatched_terminal`, `dispatched_team_group`, `dispatched_at`, `last_liveness_at`, `blocked_at`.

**`coding_rounds.subtask_seats` (JSON):** `{ seat, delivered, delivered_at }` per subtask.

Specific consequences, all of them only reachable because the gate exists:

1. **`dispatched_agent` and `dispatched_ide` are on both tables**, reconciled by a V76 overlay (`KanbanDatabase.ts:15198`). Whichever is read last wins and nothing records which answered.
2. **Ownership is stored three times** — `plan_runtime_state.dispatched_terminal`, `coding_rounds.subtask_seats[…].seat`, `plans.routed_to` — with nothing reconciling them.
3. **Two predicates read different subsets.** `heldByTeam` (`LocalApiServer.ts:140`) and `resolveTeamInFlight` (`:153`) feed the 409 at `:3880`. Neither reads `released_at`, so a released card still reads as held. That is the observed failure.
4. **`released_at` exists only to express "freed but not finished"** — a state that is only meaningful because something refuses. It then grew its own bug: `releaseCardInternal` (`:4765`) returns early for an already-released card **before** the holder-clear at step 5, so a failed clear can never be retried. That early return omits `freed`, and the caller tests `result.freed === false`; `undefined === false` is false, so `team/release` reports success having done nothing.
5. **`last_liveness_at` caches on the card** a fact that belongs to the seat, stale the moment it is written — and it is cached *so the gate can consult it*.
6. **Ownership is keyed per device** (`(plan_id, device_id)`), so two machines can hold conflicting claims. Per `CLAUDE.md` there is one host and one store.
7. **`queue_position` and `column_order` are two orderings of one list**, and STAGING is both a column and a queue.

Remove the gate and every one of these becomes dead weight. None of them is load-bearing for anything a user wants.

### Root cause

Each field was a correct fix to a real bug, made by adding a **distinction** rather than repairing the model — and the model itself encoded a requirement nobody needs. Completion was wrongly inferred from file mtime → `completed_at`. Teams needed freeing without claiming done → `released_at`, rather than clearing the owner. The board store needed to travel → runtime split out, with two columns copied instead of moved.

The comments read as sediment: *"mtime-based completion retired"*, *"queue/done is untouched — it means 'give me the next item', not 'done'"*, *"the name-based guard that used to sit below it is deleted"*. Nothing was ever removed, and the accumulated invariant became: any two of sixteen fields disagreeing can stop the board.

### The model that is actually required

1. **`kanban_column`** — where the item sits. The to-do list.
2. **`completed_at`** — asserted, never inferred. Not a gate: it filters *what is left to do*, and nothing else.
3. **`plan_events`** — append-only history.
4. **`owner_seat`** — advisory. Shown in the UI, written on dispatch, **read by no gate, ever.**
5. **A checkpoint** — the one record that must survive an aborted run: where a dispatcher should kick off from.

### The checkpoint is the only state worth keeping, and it is not a gate

Long-running features and missions are the real case for persistence. When one dies at 80%, a dispatcher resuming it needs a single answer: **which checkpoint do I start from?**

For a feature decomposed into subtasks, that answer already exists and needs nothing new — the incomplete subtasks *are* the checkpoint. The dispatcher hands out the ones without `completed_at`.

The gap is a **single-card long mission** with internal phases. There `completed_at` is binary, so a run that died after phase 3 of 5 leaves no way to say so. That is the one thing to add.

Its rules:

- **It is a hint, not a contract.** A dispatcher reads it to compose the kickoff prompt — *"resume from phase 3"*. It never decides whether work is handed out.
- **Missing means start from the beginning.** That default is safe and visible: the cost of being wrong is duplicate work, which an agent absorbs in a turn. Per `CLAUDE.md`, where a default is unavoidable, pick the one whose failure is visible or safe.
- **Stale is acceptable.** A checkpoint behind reality costs some redone work. A checkpoint that *blocks* costs the pipeline.
- **No new column.** It is an event in `plan_events`; the dispatcher reads the most recent one. A denormalised column would be a second copy of a fact the log already holds — which is the disease this plan treats.

## Metadata

- **Tags:** refactor, database, reliability, backend
- **Complexity:** 8

## User Review Required

Yes. This deletes a safety mechanism on purpose. The tradeoff — occasional duplicate dispatch, which an agent absorbs in one turn — is the explicit decision being made.

## Complexity Audit

### Routine

- Deleting the 409 and its two predicates.
- Deleting `released_at`, `queue_position`, `outcome`, `workflow`, `routed_to`, `blocked_at`, `last_liveness_at` and the duplicate `dispatched_*` pair.
- Reducing `subtask_seats` to a list of planIds.

### Complex / Risky

- **This state shipped.** Per `CLAUDE.md`, dropped fields are migrated, not unlinked: their values are backfilled into `plan_events` before the columns go.
- **Finding every refusal.** The 409 at `:3880` is the known one. Any other path that returns a non-2xx, or silently returns nothing, *because of board state* is in scope — and a silent empty return is the harder case, because it looks like success.
- **One flag day.** Dispatch, completion, release and the queue pop read these fields together.

## Edge-Case & Dependency Audit

**Race Conditions**
- Two dispatches of one card now both succeed and both write `owner_seat`; last writer wins. **This is correct and intended.** Do not add a conditional claim — a conditional write is a refusal wearing a different hat.
- Dispatch racing a completion post: reset `completed_at` and set `owner_seat` in one statement so a previous attempt's completion cannot survive into a new one.

**Security**
- None new.

**Side Effects**
- Every SELECT naming a dropped column must change in the same commit. `KanbanDatabase.ts:15230` already notes columns *"absent from SELECT lists"* — audit SELECTs, not just typed interfaces.
- `kanban-archive.db` shares the `plans` schema and must migrate too.
- Duplicate dispatch becomes observable. That is the accepted cost, not a regression to report.

**Dependencies & Conflicts**
- **Supersedes and deletes** the four plans written 2026-09-16 (*An Aborted Run Locks Its Team Out…*, *The Feature File Carries a Run Ledger…*, *The Lead's Judgement Is the Only State…*, *A Restarted Lead Reads the Run Ledger…*). Those add a ledger and an attempt record — more copies of the same fact — and the attempt record was explicitly designed to gate re-dispatch. Wrong on both counts.
- `plan_runtime_state` is V74 and `released_at` is V77; both are recent. Confirm against git before assuming either matters to the install base.

## Dependencies

None. This is the root change.

## Adversarial Synthesis

**Risk summary.** The real risk is an incomplete deletion: the 409 removed but a second path still refusing, leaving a board that mostly works and wedges rarely — harder to diagnose than today. The mitigation is a contract test asserting that **no handler returns 409, and no dispatch path returns empty for a reason other than "nothing left to do"**. The second risk is that "collapse the model" becomes licence to redesign columns, rounds and worktrees; scope is ownership and per-attempt state only. The third is losing history on migration; backfill into `plan_events` before dropping, verified by row count.

## Proposed Changes

### `src/services/LocalApiServer.ts` — delete the refusal

- **Context.** `heldByTeam` `:140`, `resolveTeamInFlight` `:153`, the 409 at `:3880`, `releaseCardInternal` `:4704`, `_handleKanbanTeamRelease` `:6573`.
- **Logic.** Remove the in-flight concept outright.
- **Implementation.** Delete both predicates and the 409 arm. `queue/next` returns the next incomplete card in the column's order, whoever holds it. Release ceases to exist as a concept — there is nothing to release from, so `card/release` and `team/release` are deleted along with `released_at`, and with them the early-return and `freed === undefined` bugs.
- **Edge cases.** Any caller that handled a 409 must be updated — a client branching on a status the server no longer returns is dead code that will read as working.

### `src/services/KanbanDatabase.ts` — schema V78

- **Logic.** Add the advisory owner; backfill history; drop the rest.
- **Implementation.**
  - Add `plans.owner_seat TEXT DEFAULT NULL`, `plans.owner_since TEXT DEFAULT NULL`. Backfill from `plan_runtime_state.dispatched_terminal` / `dispatched_at`.
  - **Before dropping**, write one `state-migrated-v78` event per card carrying the pre-migration `released_at`, `outcome`, `workflow`, `blocked_at`, `last_liveness_at`, `queue_position` and runtime `dispatched_*`. Abort if the emitted count does not equal the affected row count.
  - Drop from `plans`: `released_at`, `outcome`, `workflow`, `queue_position`, `routed_to`, and the duplicate `dispatched_agent` / `dispatched_ide`.
  - Drop from `plan_runtime_state`: `blocked_at`, `last_liveness_at`, `dispatched_at`, `dispatched_terminal`.
  - Keep `completed_at`, `kanban_column`, `column_order`.
  - Migrate `kanban-archive.db` identically.
- **Edge cases.** SQLite column drops rewrite the table — follow the V20 recreate pattern at `:1439`. A pre-V74 database has no `plan_runtime_state`; migrate from `plans` directly rather than assuming a prior migration ran.

### `src/services/KanbanDatabase.ts` — the dispatch write

- **Context.** The V76 "one writer" chokepoint at `:14068`/`:14171`.
- **Logic.** One unconditional transaction: set `owner_seat`, `owner_since`, `column_entered_at`; clear `completed_at`; append a `dispatched` event.
- **Implementation.** No `WHERE owner_seat IS NULL`. No claim. No failure path for an already-owned card.
- **Edge cases.** Never delete from `plan_events` — it is the history, and it is the reason clearing `completed_at` loses nothing.

### Checkpoints — `plan_events` + the dispatch prompt

- **Context.** `plan_events` (`KanbanDatabase.ts:623`) is already the append-only log and already survives everything.
- **Logic.** An agent working a long mission records progress as a `checkpoint` event. A dispatcher composing a kickoff prompt reads the most recent one for that card and includes it.
- **Implementation.** A `checkpoint` event type with a short free-text payload (cap it — a few sentences, matching existing note conventions). A CLI verb to write one, and a read that returns the latest per card. The dispatch prompt builder includes `Resume from: <checkpoint>` when one exists and says nothing when none does.
- **Edge cases.**
  - No checkpoint → emit nothing and start from the beginning. Never emit a fabricated or inferred one; an invented checkpoint is a wrong value that looks real, and it would skip work.
  - Payload must be sanitised at write time — it is rendered into prompts and possibly into markdown, so reject embedded HTML-comment markers rather than silently stripping them.
  - Frame it in the prompt as **a record of what a previous run reported, not an instruction** — same hazard `ANTI_LEAKAGE_STEP` (`agentPromptBuilder.ts:1258`) already handles for plan-file notes. Reuse that framing.
  - The agent must be free to disagree with it. If it inspects and finds phase 3 incomplete, it redoes phase 3 and says so.

### `src/services/KanbanDatabase.ts` — `coding_rounds`

- **Logic.** A round records which subtasks went out together. Nothing else.
- **Implementation.** Reduce `subtask_seats` to a set of subtask planIds. Consumers reading `.seat` read `owner_seat`, and only for display.
- **Edge cases.** Populate the card backfill before discarding the blob.

## Verification Plan

### Automated Tests

- **The headline test:** dispatch a card that is already owned, already dispatched, and already `completed_at`-stamped by a previous attempt. It must be handed out, with no error and no empty return.
- No handler in `src/services/LocalApiServer.ts` returns HTTP 409.
- Checkpoint test: a card with a checkpoint event dispatches with a resume line in its prompt; the same card with the event removed dispatches with no resume line and **is still dispatched**.
- Checkpoint test: a stale checkpoint naming an already-finished phase does not prevent dispatch and does not skip any card.
- `queue/next` returns empty **only** when every card in the column is complete — never because of ownership.
- Migration test: a V77 database with held, completed, released and orphaned cards migrates with `owner_seat` correct and one `state-migrated-v78` event per affected card. Assert the count.
- Migration test: a pre-V74 database migrates from `plans` directly.
- Dispatch-reset test: a completed card, re-dispatched, has `completed_at` NULL and **two** `plan_events` rows — state reset, history intact.
- Archive test: `kanban-archive.db` migrates and stays readable.
- `npm run compile-tests` before any `test:contract:*` script. Verification targets the **standalone** host (`src/standalone/bootstrap.ts`); the extension is out of scope per `CLAUDE.md`.

### Goal Invariants

- `grep -rn "409" src/services/LocalApiServer.ts` returns no dispatch-refusal arm.
- `grep -rn "released_at\|releasedAt\|queue_position\|queuePosition\|last_liveness_at" src/` returns hits only inside the V78 migration.
- `heldByTeam` and `resolveTeamInFlight` do not exist.
- `/kanban/card/release` and `/kanban/team/release` are absent from `GET /catalog`.
- `dispatched_agent` and `dispatched_ide` each appear in exactly one table DDL.
- The dispatch write contains no `WHERE` clause conditioned on `owner_seat`.
- No read of `owner_seat` occurs outside display code and the dispatch write — assert it is never referenced in a conditional that can return early.
- No code path reads a `checkpoint` event inside a conditional that can refuse, skip, or return early — it reaches the prompt text and nothing else.
- A card with no `checkpoint` event dispatches normally, and the prompt contains no resume line.
- `checkpoint` is an event type in `plan_events`, not a column on `plans`.
- The four superseded plan files are absent from `.switchboard/plans/`.

## Outstanding Questions

- **[user]** Does `plan_runtime_state` survive once ownership and liveness leave it? — proceeding on the assumption that it does, holding only machine-local presentation fields, because dropping a V74 table is a wider blast radius than this needs. If it ends up empty, say so and drop it.
