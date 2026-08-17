# Remote Plans Enter the Queue, Not the Agents — Batch Intake With the Orchestrator as Sequencer

## Goal

Pushing a batch of plans from Notion or Linear stages them into the session queue and wakes an orchestrator once to decide the order. Nothing fires on arrival. The remote board becomes an intake for broad orders — "here are five plans, deal with them" — rather than a trigger wired directly to the agents.

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
* **No self-feeding-loop risk.** Nothing replies to comments in a loop, so the poller cannot re-ingest an orchestrator's own output as a new instruction.
* **No resident orchestrator.** A batch wakes one, it sequences and hands off (subtask 6), and it exits. Remote Control adds no third session state.

### Degraded mode is safe by construction

If no orchestrator is available, staged cards simply sit in the queue in arrival order — visible on the board, counted on the Dispatch toggle, and pullable by the lead. Contrast today's failure, where the same batch has already started five agents before anyone looks. "Nothing happened yet" is a recoverable state; "five agents are running" is not.

---

## Metadata

- **Complexity:** 5
- **Tags:** backend, api, reliability, feature
- **Feature:** 3e8b662b-a8a8-42c5-8e43-6d67998aa201

---

## User Review Required

**None.** Five decisions made here:

* **A third `mode` value, `queue`, rather than changing what `full` means.** `full` stays as the one-card "run this now" trigger, which is a legitimate use; `queue` becomes the recommended setting for a remote board that pushes batches. Changing `full` in place would alter behaviour for anyone using single-card remote triggering.
* **Staging happens in the poll loop; sequencing happens in the orchestrator.** The extension must never decide order — that is judgement, and it is the thing the orchestrator is actually for.
* **One wake per batch, not per card.** A wake per card reintroduces the fan-out this plan removes, one level up.
* **The ack comment tells the truth.** A card that was staged must not be acked as dispatched; the current wording would become a lie and remote users read those acks as status.
* **No orchestrator available ⇒ cards stay staged.** No fallback to direct dispatch — falling back to the burst on the path whose purpose is preventing the burst.

---

## Implementation

**Blocked on subtasks 1, 2 and 6** — staging needs the queue, and the intake orchestrator hands off through subtask 6.

1. **`RemoteConfig.mode` gains `'queue'`** (`RemoteControlService.ts:57`): `ingest` = pull only; `queue` = pull + stage, never dispatch; `full` = pull + dispatch, today's behaviour. Normalise unknown persisted values to `queue` for remote-driven boards — the safe direction, since the failure mode of guessing wrong is "work waits" rather than "work stampedes."

2. **`_applyStateMirror` branches on mode.** In `queue` mode, a delta resolving to a dispatch column stages the card: move it to `DISPATCH`, assign the next `queue_position` (subtask 2), and do **not** call `onColumnMove`. The echo guard at `:640` is unchanged and still load-bearing.

3. **Truthful ack.** Staged cards get *"staged as position N in the session queue"*, naming the position, instead of the dispatch ack at `:651-654`.

4. **One batch wake.** After a poll cycle that staged at least one card, wake an orchestrator once with the batch — the staged plan ids, their arrival order, and the pre-existing queue contents. Debounce across cycles so a trickle of arrivals over several polls produces one sequencing pass rather than several.

5. **Persona `## Remote intake`.** You were woken by a batch, not a conversation. Decide the order; group what belongs together into a feature where the grouping is real; state what you changed and why; dispatch the first card via `queue/next`; report on the cards; hand off and exit. Bounded report shape per subtask 5 — a Notion comment is a worse home for an essay than a terminal is.

6. **No orchestrator available ⇒ leave them staged** and note it once in the log. The board already shows the count; the lead can pull them in arrival order.

---

## Verification Plan

- **Unit — the headline case:** five state deltas resolving to a dispatch column in one poll cycle, `mode: 'queue'`. Exactly zero dispatches, five cards staged, positions 1–5 in delta order.
- **Unit:** the same five deltas under `mode: 'full'` still dispatch five times — the existing behaviour is preserved for anyone relying on it.
- **Unit:** `mode: 'ingest'` still imports without moving or dispatching.
- **Unit:** one batch wake for five staged cards, not five; and one wake for a trickle spanning three poll cycles.
- **Unit:** a staged card is acked as staged with its position, never as dispatched.
- **Unit:** no orchestrator available → cards remain staged, nothing dispatched, one log line.
- **Unit:** the echo guard still no-ops a delta whose column equals the card's current column, in `queue` mode as in `full`.
- **Manual UAT:** move five Notion issues to the trigger state at once. Nothing starts; the Dispatch toggle reads 5; the orchestrator wakes once, states an order, dispatches the first; the lead walks the remaining four one at a time.
- **Manual UAT:** the same batch with the orchestrator unavailable — five cards staged, nothing running, board legible.
- **Regression:** per-card remote comment routing, the two cursors, the seen-set, `authoredBySelf` and cursor-advance-after-dispatch are all untouched.
