# Remote Plans Enter the Queue, Not the Agents — Batch Intake With the Orchestrator as Sequencer

## Goal

Pushing a batch of plans from Notion or Linear stages them into the session queue in arrival order instead of firing an agent per card. The remote board becomes an intake for broad orders — "here are five plans, deal with them" — rather than a trigger wired directly to the agents.

**This is entirely extension-managed and requires no orchestrator.** Remote Control is mechanical today and stays mechanical: staging a batch and letting the lead walk it one at a time needs no judgement, so no agent is in the correctness path. Optional batch *sequencing* — reordering by dependency, grouping what belongs together — is judgement and is an explicit opt-in on top of a default that is already correct without it.

### Problem & background

**A batch of remote status changes is a batch of simultaneous agent runs, uncapped.**

The poll loop walks every state delta in a cycle and dispatches per delta (`src/services/RemoteControlService.ts:602-624`). For each delta that resolves to a dispatch column it calls `_applyStateMirror`, which calls `onColumnMove` and acks (`:649-655`). The `await` is per delta, but `onColumnMove` returns when the **prompt has been sent**, not when the work finishes — the ack comment says so in as many words: *"dispatched the local agent for the **X** column. Check back in a few minutes."* So moving five issues to the execution-trigger state in one cycle produces five concurrent agent runs, with no cap, no ordering and no pacing.

**The codebase already knows burst dispatch is a hazard, and defends against it exactly once.** The seed-on-first-poll guard baselines the cursor to `now` and deliberately processes nothing, with the reason stated inline: *"so an existing board's history isn't replayed as a burst of agent runs"* (`:593-598`). That protects the very first poll of a new board and nothing afterwards. Every subsequent batch is precisely the burst that guard exists to prevent.

**The only available defence is binary.** `mode: 'ingest'` skips the state mirror entirely (`:622`) — remote cards are imported as plan sources but no column moves and no dispatches happen. `mode: 'full'` fires every one immediately. There is no middle setting that means *take these in, run them one at a time*, which is what a remote board pushing a night's work actually needs.

### Root cause — the remote board is wired to the agents instead of to the queue

Remote status changes were modelled on the manual drag, and the mapping is faithful: a drag dispatches one agent, so a mirrored move dispatches one agent. That equivalence holds for one card and breaks for a batch, because a human dragging five cards sees five agents start and stops; a poll cycle applying five deltas does not. Nothing in the path represents "these five are a set, and the set has an order."

Now that a queue exists (subtask 2) and the lead paces itself through it (subtask 1), the correct destination for remotely-arriving work is the queue, not the agent. Sequencing a set that arrived together is also exactly the orchestrator's real job — deciding scope and order — rather than the pipeline-babysitting it is being relieved of.

### This is intake, not conversation

The channel carries broad orders at batch granularity. It is not a chat: no per-turn dialogue, no resident addressee, no reply loop. Three consequences worth stating because they each *remove* work:

* **No control card and no session-level message channel.** The existing per-card comment routing stays exactly as it is.
* **No self-feeding-loop risk.** Nothing replies to comments in a loop, so the poller cannot re-ingest an agent's own output as a new instruction.
* **No resident orchestrator.** Nothing is seated, nothing waits, no session state is added.

### Why no orchestrator is required

Remote Control is extension-managed today, and that is a property worth keeping rather than an accident to fix. It works while the user is away, it is deterministic, it costs no context, and it cannot misjudge. Making the burst fix depend on an agent would put judgement in the correctness path of a mechanism whose whole value is that it has none.

The two concerns are separable:

* **Not stampeding** is mechanical — append arrivals to the queue in order, let the lead pull one at a time. No judgement, no agent, and it is the entire bug fix.
* **Sequencing and grouping** are judgement — reorder by dependency, group a batch into a feature, notice that something arrived under-specified and belongs in the planning lane. Real value, and strictly optional.

**Arrival order is a good default, not a fallback.** Plans are pushed in roughly the order they are wanted; the queue is reorderable on the board (subtask 2) and its depth is visible on the Dispatch toggle. A batch that runs in the order it was pushed, one card at a time, is a correct outcome.

**Queue mode is also more robust than `full` even for a single card.** `performKanbanDispatch` returns `409` when no terminal is live (`LocalApiServer.ts:1319`), so a remote move under `full` with no live coder fails or degrades to the clipboard. Staging always succeeds and waits for a lead — so the mechanical path removes a failure mode rather than trading one for another.

### Sequencing is opt-in and explicit, never ambient

If batch sequencing is wanted it is a setting, not a consequence of a terminal happening to be open. Behaviour that changes depending on whether an orchestrator is seated is exactly the ambient spookiness this feature exists to remove: the same five plans would run in a different order on Tuesday than on Monday, with nothing in the board explaining why. With the setting off, no agent is involved at any point. With it on, an orchestrator is woken (started if needed) to sequence the batch before the first dispatch, bounded so that its absence or failure falls back to arrival order rather than stalling the queue.

---

## Metadata

- **Complexity:** 4
- **Tags:** backend, api, reliability, feature
- **Feature:** 3e8b662b-a8a8-42c5-8e43-6d67998aa201

---

## User Review Required

**None.** Six decisions made here:

* **Remote Control requires no orchestrator.** The mechanical path is the whole fix and stays extension-managed. This reverses an earlier draft of this plan, which made staging depend on an agent being available to sequence — that put judgement in the correctness path of the one mechanism whose value is having none, and stalled the away-from-desk case that Remote Control exists for.
* **A third `mode` value, `queue`, rather than changing what `full` means.** `full` stays as the one-card "run this now" trigger, which is a legitimate use; `queue` becomes the recommended setting for a remote board that pushes batches. Changing `full` in place would alter behaviour for anyone using single-card remote triggering.
* **Sequencing is an explicit setting, not "if an orchestrator is seated".** Ambient behaviour that depends on which terminals are open makes the same batch run differently on different days with nothing on the board to explain it.
* **Sequencing is bounded and falls back to arrival order.** An absent or failed sequencer must never hold a queue shut — the failure mode of the feature that prevents stampedes cannot be a stall.
* **One wake per batch, not per card**, when sequencing is on. A wake per card reintroduces the fan-out this plan removes, one level up.
* **The ack comment tells the truth.** A card that was staged must not be acked as dispatched; the current wording would become a lie, and remote users read those acks as status.

---

## Implementation

**Blocked on subtasks 1 and 2** — staging needs a queue to stage into and a lead that pulls from it. Steps 1–4 are the whole bug fix and involve no agent. Steps 5–6 are the opt-in sequencing layer and additionally want subtask 6's handoff endpoint; they can ship later or never without weakening 1–4.

1. **`RemoteConfig.mode` gains `'queue'`** (`RemoteControlService.ts:57`): `ingest` = pull only; `queue` = pull + stage, never dispatch; `full` = pull + dispatch, today's behaviour. Normalise unknown persisted values to `queue` — the safe direction, since guessing wrong means "work waits" rather than "work stampedes."

2. **`_applyStateMirror` branches on mode.** In `queue` mode, a delta resolving to a dispatch column stages the card: move it to `DISPATCH`, assign the next `queue_position` (subtask 2), and do **not** call `onColumnMove`. The echo guard at `:640` is unchanged and still load-bearing.

3. **Truthful ack.** Staged cards get *"staged as position N in the session queue"*, naming the position, instead of the dispatch ack at `:651-654`.

4. **Nothing else.** With sequencing off, this is the complete path: arrivals stage in delta order and the lead pulls them one at a time via subtask 1. No agent is woken, nothing waits, and the queue is correct on its own.

5. **Opt-in sequencing** behind a setting (default **off**). When on, a poll cycle that staged at least one card wakes an orchestrator once with the batch — staged plan ids, arrival order, and the pre-existing queue contents. Debounced across cycles so a trickle over several polls produces one pass. Bounded: if no orchestrator can be started, or it does not respond within the bound, the queue proceeds in arrival order and the fallback is logged. The sequencer reorders before the first dispatch; it never holds the queue shut.

6. **Persona `## Remote intake`** (only reached when sequencing is on). You were woken by a batch, not a conversation. Decide the order; group what belongs together into a feature where the grouping is real; state what you changed and why; report on the cards; hand off and exit. Bounded report shape per subtask 5 — a Notion comment is a worse home for an essay than a terminal is.

---

## Verification Plan

- **Unit — the headline case:** five state deltas resolving to a dispatch column in one poll cycle, `mode: 'queue'`, sequencing **off**. Exactly zero dispatches, five cards staged, positions 1–5 in delta order — and **no agent involved at any point**, which is the property this plan turns on.
- **Unit:** the same five deltas under `mode: 'full'` still dispatch five times — existing behaviour preserved for anyone relying on it.
- **Unit:** `mode: 'ingest'` still imports without moving or dispatching.
- **Unit:** a staged card is acked as staged with its position, never as dispatched.
- **Unit:** the echo guard still no-ops a delta whose column equals the card's current column, in `queue` mode as in `full`.
- **Unit:** unknown persisted `mode` normalises to `queue`, not `full`.
- **Unit — sequencing on:** one wake for five staged cards, not five; one wake for a trickle spanning three poll cycles.
- **Unit — the fallback that must not stall:** sequencing on with no orchestrator startable, and separately with one that never responds. In both cases the queue proceeds in arrival order within the bound and logs the fallback. A stalled queue here would make the anti-stampede feature the cause of the outage.
- **Manual UAT — no agent path:** move five Notion issues to the trigger state at once with sequencing off. Nothing starts, the Dispatch toggle reads 5, and the lead walks all five one at a time in pushed order.
- **Manual UAT — single card:** one remote move with no live coder. Under `queue` it stages successfully; under `full` it 409s or clipboards — confirming queue mode removes that failure mode.
- **Manual UAT — sequencing on:** the same batch reordered by the orchestrator before the first dispatch, with the reordering stated on the cards.
- **Regression:** per-card remote comment routing, the two cursors, the seen-set, `authoredBySelf` and cursor-advance-after-dispatch are all untouched.
