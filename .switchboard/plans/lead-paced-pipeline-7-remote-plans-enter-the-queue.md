# Remote Plans Enter the Queue, Not the Agents — Batch Intake With the Orchestrator as Sequencer

## Goal

Pushing a batch of plans from a connected issue tracker stages them into the session queue in arrival order instead of firing an agent per card. The remote board becomes an intake for broad orders — "here are five plans, deal with them" — rather than a trigger wired directly to the agents.

**This is entirely extension-managed and requires no orchestrator.** Remote Control is mechanical today and stays mechanical: staging a batch and letting the lead walk it one at a time needs no judgement, so no agent is in the correctness path. Optional batch *sequencing* — reordering by dependency, grouping what belongs together — is judgement and is an explicit opt-in on top of a default that is already correct without it.

### Problem & background

**A batch of remote status changes is a batch of simultaneous agent runs, uncapped.**

The poll loop walks every state delta in a cycle and dispatches per delta (`src/services/RemoteControlService.ts:602-624`). For each delta that resolves to a dispatch column it calls `_applyStateMirror` (`:632`), which calls `onColumnMove` and acks (`:649-655`). The `await` is per delta, but `onColumnMove` returns when the **prompt has been sent**, not when the work finishes — the ack comment says so in as many words: *"dispatched the local agent for the **X** column. Check back in a few minutes."* So moving five issues to the execution-trigger state in one cycle produces five concurrent agent runs, with no cap, no ordering and no pacing.

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

**Queue mode is also more robust than `full` even for a single card.** `performKanbanDispatch` returns `409` when no terminal is live (`LocalApiServer.ts:1320`), so a remote move under `full` with no live coder fails or degrades to the clipboard. Staging always succeeds and waits for a lead — so the mechanical path removes a failure mode rather than trading one for another.

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

## Complexity Audit

### Routine

- Widening a two-value union to three and branching `_applyStateMirror` on it.
- Rewording one ack string.
- Reusing subtask 2's exported staging helper rather than writing a second staging path.

### Complex / Risky

- **The mode value is collapsed by two separate ternaries.** `getConfig` (`:242`) and `setConfig` (`:260`) both do `parsed.mode === 'full' ? 'full' : 'ingest'`. A third value that is not added to **both** cannot even be persisted: the settings write silently downgrades `queue` to `ingest`, the user sees the toggle revert, and the branch added to `_applyStateMirror` is dead code that no test exercises because no test can produce the state.
- **The read branch is `if (config.mode === 'ingest') { continue; }`** (`:622`) — an else-fallthrough. Any value that is not `ingest` currently dispatches, so a half-finished `queue` value stampedes rather than staging: failing *open* in the direction this plan exists to close.
- **Normalisation direction is a shipped-behaviour decision** on ~4,000 installs — see the correction below.
- **The opt-in sequencing layer has a stall failure mode** that is worse than the bug it decorates.

---

## Edge-Case & Dependency Audit

### Race Conditions

- **Staging racing the lead's pop.** Both touch `queue_position`; positions are a sort key with a deterministic tie-break, and the pop is serialized, so a stage that lands mid-pop simply appends behind it.
- **A trickle across poll cycles** with sequencing on must produce **one** wake, not one per cycle — debounce across cycles, not within one.
- **Cursor advance.** The cursor is advanced after processing (`:625-629`) and idempotency comes from the echo guard. Staging must be idempotent under a re-fetched delta for the same reason a dispatch is: a card already in `DISPATCH` re-positions rather than duplicating.

### Security

- No new external surface. The provider tokens, cursors and comment routing are untouched.

### Side Effects

- **A staged card is not a dispatched card**, and the ack is read by remote users as status. Acking a staged card as dispatched would be a lie the user acts on.
- **Staging must arm subtask 3's queue watch.** This is the one path that can leave a full queue with no dispatch at all and no user present — precisely the silent night subtask 3 exists to prevent. Without the arm, this plan's success case (five cards staged, nothing started) is indistinguishable from an outage.
- **`mode` is surfaced in the Remote tab payload** (`KanbanProvider._buildRemoteConfigPayload`, ≈`:2583-2608`) and written through the `setRemoteConfig` verb (`kanbanService.ts:290`). The verb schema is permissive and does not enumerate `mode`, so no schema change is needed — but the UI control has to offer the third value or the setting is unreachable.

### Dependencies & Conflicts

- **Subtask 2 owns `queue_position` and the staging helper.** This plan calls it; it must not write positions itself.
- **Subtask 1 supplies the lead that drains the queue.** Without it, staging is a well-ordered pile nobody walks.
- **Subtask 3 supplies the watch** this plan's staging arms.
- **Subtask 6 supplies the handoff endpoint** the optional sequencing layer uses. Steps 1–4 do not depend on it and can ship without it.

---

## Dependencies

- `e060b8c4-27bd-48ac-a5d1-c72f557ea27a` — The Coding Lead Paces Its Own Pipeline *(hard)*
- `7e0983cc-c3a6-44d4-be7f-5b03917153d6` — The Dispatch Column Becomes the Session Queue *(hard: the queue and its staging helper)*
- `85481036-a94d-46b0-9c46-afa0e06da994` — Queue Watch on the Idle Sweep *(hard for the success case: staging must arm the watch)*
- `c4b903af-effd-4f30-b81d-9edc2b8bc3ab` — The Orchestrator Hands Off and Exits *(soft: only the opt-in sequencing layer, steps 5–6)*

---

## Adversarial Synthesis

**Risk summary.** The fix fails open in two ways if implemented partially: the read branch dispatches on anything that is not `ingest`, and the two config ternaries silently downgrade `queue` to `ingest` on the way in and out — so a half-landed change either stampedes or is unreachable, and neither shows up as a compile error. Mitigations are unit tests keyed on round-tripping the persisted value through `setConfig`/`getConfig` and on the exact delta count dispatched. The second risk is a staged queue nobody walks: staging must arm subtask 3's watch, or this plan's success state and a total outage look identical from the board.

---

## Proposed Changes

### 1. `src/services/RemoteControlService.ts` — the third mode

**Context.** `RemoteConfig.mode` is a two-value union (`:51-52`) defaulting to `ingest` (`:66`), normalised by **two** identical ternaries in `getConfig` (`:242`) and `setConfig` (`:260`), and read once as an `ingest`-else-fallthrough (`:622`).

**Implementation.**

1. Widen the union: `ingest` = pull only; `queue` = pull + stage, never dispatch; `full` = pull + dispatch, today's behaviour. Update the doc comment at `:51`.
2. **Change both ternaries.** `setConfig` collapsing `queue` → `ingest` means the setting can never be saved; `getConfig` collapsing it means it can never be read back. Neither produces a compile error and neither is caught by a test that only exercises `_applyStateMirror`.
3. **Normalise unknown persisted values to `ingest`**, not `queue`.

   > **Superseded:** "Normalise unknown persisted values to `queue` — the safe direction, since guessing wrong means 'work waits' rather than 'work stampedes.'"
   > **Reason:** `queue` is not the conservative choice against *today's* behaviour. An unrecognised or corrupt value currently resolves to `ingest`, which moves nothing and dispatches nothing; the `catch` around `getConfig` already returns `DEFAULT_REMOTE_CONFIG` (`mode: 'ingest'`, `:66`). Normalising to `queue` would take shipped installs from "do nothing on garbage input" to "start moving cards to `DISPATCH` on garbage input" — a behaviour change on ~4,000 installs, in the one code path whose inputs are the least trustworthy. Both values mean "work waits"; only one of them changes shipped behaviour.
   > **Replaced with:** unknown → `ingest` (unchanged). `queue` is only ever reached by an explicit user choice, and `full` keeps its explicit meaning.

**Edge Cases.** A config written by a newer version and read by an older one degrades to `ingest` — cards are imported, nothing moves. Acceptable and quiet.

### 2. `src/services/RemoteControlService.ts` — `_applyStateMirror` branches on mode

**Context.** The echo guard at `:640` (never re-apply the column the card is already in) is load-bearing and unchanged.

**Implementation.** In `queue` mode, a delta resolving to a dispatch column stages the card: call subtask 2's `stageForQueue` (move to `DISPATCH`, assign the next `queue_position`) and do **not** call `onColumnMove`. The pre-dispatch `refreshLocalPlanFromRemote` (`:646`) still runs — a staged card must carry the remote-authored body before the lead picks it up — and `refreshedThisCycle` is still stamped so `_pollDescriptions` does not double-pull.

**Edge Cases.** A delta whose card is already in `DISPATCH` is a no-op under the echo guard, as it is under `full`. A feature card stages as one card; its subtasks are never staged individually.

### 3. `src/services/RemoteControlService.ts` — truthful ack, and arm the watch

**Implementation.**

- Staged cards get *"staged as position N in the session queue"*, naming the position, instead of the dispatch ack at `:651-654`.
- After a cycle that staged at least one card, call subtask 3's `armQueueWatch(workspaceRoot, headTerminal | null)`. If no coding head is live, arm with `null` — subtask 3's "no head seated" gate then tells the user that work is staged and nothing is driving it, which is the whole point of staging rather than dispatching.

### 4. Nothing else

With sequencing off, this is the complete path: arrivals stage in delta order and the lead pulls them one at a time via subtask 1. No agent is woken, nothing waits, and the queue is correct on its own.

### 5. Opt-in sequencing (default **off**)

**Implementation.** When on, a poll cycle that staged at least one card wakes an orchestrator **once** with the batch — staged plan ids, arrival order, and the pre-existing queue contents. Debounced across cycles so a trickle over several polls produces one pass. Bounded: if no orchestrator can be started, or it does not respond within the bound, the queue proceeds in arrival order and the fallback is logged. The sequencer reorders before the first dispatch; it never holds the queue shut.

**Edge Cases.** The bound must be enforced by the extension, not by the agent's cooperation — an agent that hangs is the expected failure, not the exception.

### 6. Persona `## Remote intake` (only reached when sequencing is on)

You were woken by a batch, not a conversation. Decide the order; group what belongs together into a feature where the grouping is real; state what you changed and why; report on the cards; hand off and exit (subtask 6). Bounded report shape per subtask 5's ceiling discipline — a remote comment thread is a worse home for an essay than a terminal is.

---

## Verification Plan

### Automated Tests

- **The headline case:** five state deltas resolving to a dispatch column in one poll cycle, `mode: 'queue'`, sequencing **off**. Exactly zero dispatches, five cards staged, positions 1–5 in delta order — and **no agent involved at any point**, which is the property this plan turns on.
- **Config round-trip (the trap):** `setConfig({mode:'queue'})` followed by `getConfig()` returns `queue`. This is the test that catches either ternary being missed; without it the feature is unreachable and every other test still passes.
- **Unit** — the same five deltas under `mode: 'full'` still dispatch five times: existing behaviour preserved for anyone relying on it.
- **Unit** — `mode: 'ingest'` still imports without moving or dispatching.
- **Unit** — a staged card is acked as staged with its position, never as dispatched.
- **Unit** — the echo guard still no-ops a delta whose column equals the card's current column, in `queue` mode as in `full`.
- **Unit** — unknown persisted `mode` normalises to `ingest`, and a `queue` value survives a round trip through the settings verb.
- **Unit** — a cycle that stages arms the queue watch, including with no live coding head.
- **Sequencing on:** one wake for five staged cards, not five; one wake for a trickle spanning three poll cycles.
- **The fallback that must not stall:** sequencing on with no orchestrator startable, and separately with one that never responds. In both cases the queue proceeds in arrival order within the bound and logs the fallback. A stalled queue here would make the anti-stampede feature the cause of the outage.

### Manual UAT

- **No-agent path:** move five remote issues to the trigger state at once with sequencing off. Nothing starts, the Dispatch toggle reads 5, and the lead walks all five one at a time in pushed order.
- **Single card:** one remote move with no live coder. Under `queue` it stages successfully; under `full` it 409s or clipboards — confirming queue mode removes that failure mode.
- **Sequencing on:** the same batch reordered by the orchestrator before the first dispatch, with the reordering stated on the cards.

### Regression

- Per-card remote comment routing, the two cursors, the seen-set, `authoredBySelf` and cursor-advance-after-dispatch are all untouched.

---

**Recommendation:** Complexity 4 → **Send to Coder.** Steps 1–4 are the bug fix and ship on their own; steps 5–6 are optional and land after subtask 6, or never.

---

## Completion Report

Also closed the arming site fenced earlier: `KanbanProvider.stageForQueue` now calls `armQueueWatch(workspaceRoot, null)` after staging — a queue staged but never dispatched is watched, which the plan calls the worst case rather than an exempt one.

Implemented the third remote mode `queue` and the opt-in sequencing layer. Widened `RemoteConfig.mode` to `'ingest' | 'queue' | 'full'` and replaced both collapsing ternaries with `_normalizeMode` (unknown → `ingest`, unchanged from shipped behaviour — `queue` is only reached by explicit user choice). In `_applyStateMirror`, `queue` mode stages the card via `onStageForQueue` (reusing `KanbanProvider.stageForQueue`) instead of calling `onColumnMove`, with a truthful ack ("staged as position N in the session queue") replacing the dispatch lie. After a cycle that staged at least one card, the queue watch is armed with `null` (subtask 3's "no head seated" gate handles the absent-lead case). Step 5 adds `queueSequencing` (default off) — when on, one wake per batch via `onSequenceBatch` (starts the orchestrator, which sequences and hands off; the queue is never held shut because the lead can pull while the orchestrator is sequencing). Step 6 adds the `## Remote intake` section to the orchestrator persona. UI: three-way radio + sequencing checkbox in connections.html/js.

Files changed: `src/services/RemoteControlService.ts` (mode union + `_normalizeMode` + `_applyStateMirror` queue branch + `_stagedThisCycle`/`_stagedPlanIdsThisCycle` + post-cycle arming + sequencing + `onStageForQueue`/`onArmQueueWatch`/`onSequenceBatch` deps), `src/services/KanbanProvider.ts` (`stageForQueue` arming + `onStageForQueue`/`onArmQueueWatch`/`onSequenceBatch` dep wiring), `src/webview/connections.html` (queue radio + sequencing checkbox), `src/webview/connections.js` (three-way mode read/write + sequencing read/write + capability gating), `.agents/skills/switchboard-orchestrator/SKILL.md` (`## Remote intake` persona section). No issues encountered; red-team confirmed no fails-open path, config round-trip safe, echo guard intact, `full`/`ingest` modes preserved.
