# Nothing Arms a Stall Watch, So Every Nudge Sweep Reads an Empty List

## Goal

Make the stall watches arm themselves from the events that already happen, so the feature- and
queue-level nudges actually run. Today both watch lists are empty on a live, busy board, every sweep
tick reads `[]`, and the operator does by hand the thing the sweep exists to do.

### Problem analysis

**Measured on the live board, 2026-09-08:**

```
kanban.featureWatches   []
kanban.queueWatches     []
```

Both empty, on a workspace with 4 active seats and 126 recorded dispatches. The two nudges that can
push a *seat* forward are armed-only, so neither has ever fired here. The reported symptom — *"I often
have to nudge them forward"* — is this, not a threshold.

The thresholds are a red herring and should not be touched to chase this. `turnEndSilenceMs` (90s)
gates nudging **too soon**; the fault is nothing nudging **at all**. Lowering a gate cannot arm a
watch that does not exist.

> **Superseded:** "every sweep tick reads `[]`, and the operator does by hand the thing the sweep exists to do" — i.e. *nothing* nudges any seat because the two armed lists are empty.
> **Reason:** `PlanIngestionEngine` runs **four** nudge sweeps per tick, not two. Two of them — `_runDispatchStallSweep` (`PlanIngestionEngine.ts:2268`) and `_runMemberCompletionReminderSweep` (`PlanIngestionEngine.ts:687`) — are **predicate-based and need no arming**. The dispatch-stall sweep reads the board for `dispatchedAt && !completedAt` and fires past `dispatchStallMs` (default 30 min) for *any* dispatched card, regardless of watch lists. The member-reminder sweep fires for *any* team member holding an uncompleted card past `turnEndSilenceMs`, "NOT gated on an armed watch" (`:684`). A board-dispatched coder going quiet is covered by both. The empty `featureWatches`/`queueWatches` lists only silence the feature-drive and queue-pace sweeps — they do not silence all nudging. The "nothing nudges" conclusion is true only for the two armed sweeps, false for the system as a whole.
> **Replaced with:** The armed lists silence the *feature-drive* nudge (a head driving a feature stalls between subtasks with no dispatch outstanding) and the *queue-pace* nudge (a lead-paced pipeline with the schedule off and cards staged). The dispatch-stall and member-reminder sweeps cover the board-dispatched-card-goes-quiet case without arming. The operator's symptom must be reconciled with the fact that two predicate-based sweeps already fire for that case — see `## Outstanding Questions`.

---

#### Layer 1 — the feature watch arms on one narrow path

`_autoArmDriveModeFeatureWatch` (`KanbanProvider.ts:3813`) exists and is correct. It no-ops unless
**all four** hold: the card is a feature, a workspace root resolved, `feature_drive_enabled === 'true'`,
and `dispatchedAgent` is a real terminal.

On this board `feature_drive_enabled` is `true` and `dispatched_agent` is populated — so the gates
that close are structural, not configuration:

| Recently dispatched feature | `dispatched_agent` |
| :--- | :--- |
| `63292fe7` | `reviewer` |
| `ce72d301`, `2c56790c`, `1b5ef61f` | `planner` |
| `f2da9334` | `reviewer` |

The helper has two call sites (`KanbanProvider.ts:10702` and `:10812`) and **both** are gated
`if (role === 'lead')` (`:10694` and `:10810` respectively).

> **Superseded:** "the second is gated `if (role === 'lead')`" — implying only the second call site is gated.
> **Reason:** Both call sites gate on `role === 'lead'`. `:10694` is `if (dispatched && role === 'lead')` → `:10702` calls the helper; `:10810` is `if (role === 'lead')` → `:10812` calls it. A single-line fix at one site leaves the other gated.
> **Replaced with:** Both call sites must be widened together (or the arming hoisted above the role gate) so that a feature dispatched to a planner or reviewer — the actual population on this board — arms a feature watch.

**No feature on this board went to a lead.** They went to planners and a reviewer, and a feature
being driven by anything other than a drive-mode lead arms nothing. That is a defensible scope for a
*feature-driving* watch and an indefensible one for the operator, who still has a stalled seat and no
backstop.

#### Layer 2 — the queue watch arms only from the queue endpoints, and one host cannot arm it at all

`armQueueWatch` (`PlanIngestionEngine.ts:282`) is armed from exactly two places, both in
`LocalApiServer` and both behind `if (this._options.armQueueWatch)`:

- `:3753` — queue dispatch, `{ onDispatch: true }`
- `:5529` — team release, `{ onDispatch: false }`

> **Superseded:** The release arm site was cited as `:5289`.
> **Reason:** `:5289` is the queue/done relay block (`ptySendPrompt` to the team lead), which arms nothing. The actual release arm is `:5529` (`if (pop && ... && this._options.armQueueWatch) { await this._options.armQueueWatch(workspaceRoot, from, { onDispatch: false }); }`).
> **Replaced with:** The release arm site is `LocalApiServer.ts:5529`.

So a card dispatched from the **board** — the normal gesture — arms no queue watch. Only the queue
pop and the release path do.

And the option itself is a composition-root split:

| | wires `armQueueWatch` |
| :--- | :--- |
| `src/standalone/bootstrap.ts` | yes (8 refs, wiring at `:4233`) |
| `src/services/TaskViewerProvider.ts` | yes (4 refs, wiring at `:4510`) |
| `src/extension.ts` | **0** (delegates to `TaskViewerProvider`) |

> **Superseded:** "`src/extension.ts` has 0 references" presented as a composition-root split where "the extension host is genuinely unable to arm."
> **Reason:** `extension.ts` has zero *direct* references because it delegates: it constructs `TaskViewerProvider` (`extension.ts:1005`), calls `activateHostIntegrations()`, which runs `_startLocalApiServer`, which builds the `LocalApiServer` options literal at `TaskViewerProvider.ts:4407` containing `armQueueWatch: async (wsRoot, headTerminal, opts) => { if (this._planIngestionEngine) { await this._planIngestionEngine.armQueueWatch(wsRoot, headTerminal, opts); } }` (`:4510`). The engine reference is wired later by `extension.ts:1094` (`taskViewerProvider.setPlanIngestionEngine(...)`). Both roots wire `armQueueWatch` to the same `ingestionEngine.armQueueWatch`. There is no split; the table grepped the wrong file.
> **Replaced with:** Both hosts wire `armQueueWatch` — standalone at `bootstrap.ts:4233`, extension via `TaskViewerProvider.ts:4510`. The "close the composition-root split" deliverable is dropped. The only real Layer-2 gap is that board dispatch (the normal gesture) arms no queue watch — but see the queue-watch semantics correction under `## Proposed Changes` before acting on that.

> **Superseded:** `bootstrap.ts` wiring cited at `:3763`.
> **Reason:** `:3763` is a turn-end delivery comment, not the `armQueueWatch` wiring. The wiring callback is at `bootstrap.ts:4233` (`armQueueWatch: async (wsRoot, headTerminal, armOpts?) => { ... }`), with the explanatory comment at `:4226-4232`.
> **Replaced with:** The standalone `armQueueWatch` wiring is at `bootstrap.ts:4233`.

#### Layer 3 — `watchFeature` is a verb no caller is ever told about

`watchFeature` / `unwatchFeature` exist as verbs: schema (`verbSchemas.ts`), allowlist
(`generated/verbAllowlist.ts`), provider arm (`KanbanProvider.ts:12348`), sweep consumer
(`PlanIngestionEngine.ts:1121`). The sweep's comment says *"armed by the head agent via
`watchFeature`"*.

The head is never told to call it. Zero mentions in `agentPromptBuilder.ts`, `standingOrders.ts`,
`standingOrderFragments.ts` or `teamWiring.ts`. It is a handshake whose other half was never written,
and `KanbanProvider.ts:5783` records that the drive block *"intentionally does NOT include the
`watchFeature` arming call"* — so the omission is deliberate and the auto-arm helper is its
replacement. That decision is right and this plan keeps it: **arming stays a system action, never an
instruction an agent has to remember.** Nine untyped role arrays and a prompt clause that can be
dropped by a lower-effort seat are not a mechanism.

### Design position

Arm from events the system already observes, never from an agent remembering. Concretely: a dispatch
that puts work on a seat should arm a watch for that seat's pipeline regardless of role, drive mode,
or which surface fired it. Disarm on the explicit completion post, which is the only assertion that
is not a timestamp the sweep can null.

> **Superseded:** "a dispatch that puts work on a seat should arm a watch for that seat's pipeline regardless of role, drive mode, or which surface fired it" — i.e. arm the existing `featureWatches`/`queueWatches` lists on every dispatch.
> **Reason:** The two armed watch types are scenario-specific, not general seat-stall watches. `featureWatches` is keyed by `featureId` and nudges the head about un-accepted *subtasks* (`PlanIngestionEngine.ts:1083-1185`); arming it for a non-feature plan is a category error (no featureId, no subtasks). `queueWatches` is keyed by `workspaceRoot` and the sweep drops it when `kanbanColumn === 'STAGING' && !dispatchedAt && !featureId` is empty (`:1419-1429`); a board dispatch moves a card to a coding column, not STAGING, so a board-dispatch-armed queue watch drops on the next tick or nudges about staged cards the board dispatch did not create. The general "seat goes quiet holding a dispatched card" case is already the job of the predicate-based `_runDispatchStallSweep` (`:2268`) and `_runMemberCompletionReminderSweep` (`:687`), which need no arming.
> **Replaced with:** Arm the **feature** watch on any **feature** dispatch (drop the `role === 'lead'` and `feature_drive_enabled` gates so a feature driven by a planner/reviewer also arms), keeping it feature-specific. Do **not** arm the queue watch from board dispatch — it is for queue-paced (STAGING) pipelines and board dispatch doesn't stage. The board-dispatched-card-goes-quiet case is covered by the dispatch-stall and member-reminder sweeps; the open question is why the operator still nudges despite that coverage (see `## Outstanding Questions`).

**This plan does not change a single threshold.** `turnEndSilenceMs`, `nudgeSilenceMs`,
`dispatchStallMs`, `timeoutMs` and `livenessWindowMs` all stay as they are. Tuning them is a separate
question that cannot be answered until nudges have run on real data.

**Sequencing note.** The liveness heartbeat was frozen — `goPtyFleetProjection.ts` dropped binary
output frames, so `lastDataAt` never advanced. That is fixed in the current source
(`goPtyFleetProjection.ts:599-606` decodes binary frames first) but needs a rebuild to reach the live
host. **The freeze's failure mode is the opposite of silence:** the Go host stamps `lastDataAt` at
spawn, so the value stays *positive* while never advancing; every nudge guard
`lastDataAt <= 0 || now - lastDataAt < turnEndSilenceMs` reads a frozen positive stamp as "silent for
hours" and the sweeps **fire into actively working seats** (`goPtyFleetProjection.ts:587-597`). On the
frozen build, the dispatch-stall sweep was over-firing, not absent. Any verification of this plan must
run against the rebuilt (un-frozen) host; a watch armed against a frozen clock proves nothing, and a
frozen clock makes the predicate-based sweeps fire wrongly — which is itself a likely contributor to
the operator's symptom (wrong nudges, not no nudges).

## Metadata

**Complexity:** 4
**Tags:** bugfix, reliability, backend
**Dependencies:** none (see the liveness sequencing note above)

## User Review Required

The narrowed scope (feature-watch widening only; queue-watch-from-board-dispatch and
composition-root-split deliverables dropped) changes what gets built. Confirm before dispatch that
the feature-watch widening alone is the desired fix, and that the "operator still nudges despite
predicate-based coverage" question is acceptable to leave open pending the liveness rebuild.

## Complexity Audit

### Routine
- Dropping the `role === 'lead'` and `feature_drive_enabled === 'true'` gates inside
  `_autoArmDriveModeFeatureWatch` (`KanbanProvider.ts:3813`) and its two call sites (`:10694`, `:10810`).
- The arming write is already idempotent (filter-then-push replaces, never stacks) — no new
  deduplication logic.
- No threshold changes, no new watch types, no new sweep.

### Complex / Risky
- The feature watch's sweep keys on un-accepted *subtasks* (`PlanIngestionEngine.ts:1160-1185`).
  Widening the arm to non-drive features means features driven by a planner/reviewer now get
  feature-level nudges — verify the nudge text and the `headTerminal` resolution still make sense when
  the "head" is a planner, not a drive-mode lead. The helper reads `dispatchedAgent` from the plan
  record (`:3831-3833`); a planner-dispatched feature has a real `dispatchedAgent`, so the terminal
  resolves, but the nudge semantics ("un-accepted subtasks") assume a driving lead.
- Reconciling the operator's symptom with the two predicate-based sweeps that already fire — this is
  an open question, not a code change, but it determines whether the feature-watch widening is
  sufficient or a symptom of a deeper gap (e.g. the liveness freeze causing wrong nudges that the
  operator learned to ignore).

## Edge-Case & Dependency Audit

- **Race Conditions:** Re-arming stays idempotent (filter-then-push). A feature re-dispatched to a
  different seat re-arms with the new `headTerminal` — the filter keys on `featureId`, so the old
  watch is replaced, not stacked. No new race introduced.
- **Security:** No new surfaces. Arming is a DB config write, same key (`kanban.featureWatches`) the
  `watchFeature` verb already writes.
- **Side Effects:** Widening the arm means more features carry a live watch → more feature-level
  nudges. If the liveness clock is still frozen on the target host, those nudges fire into working
  seats (the over-fire failure mode). This is why the liveness rebuild is a hard prerequisite.
- **Dependencies & Conflicts:** Depends on the `goPtyFleetProjection.ts` binary-frame fix being
  deployed (liveness rebuild). Conflicts with nothing — no threshold or sweep logic changes.

## Dependencies

- `goPtyFleetProjection.ts:599-606` (binary-frame liveness fix, already in source, needs rebuild) —
  without it, any newly-armed watch fires into working seats and the verification is meaningless.

## Adversarial Synthesis

Key risks: (1) the plan's original "nothing nudges" premise ignored two predicate-based sweeps
(dispatch-stall, member-reminder) that already cover the board-dispatched-card case without arming;
(2) the liveness freeze causes over-firing, not silence, so the operator's symptom may be wrong
nudges rather than no nudges; (3) arming the queue watch from board dispatch would arm a watch that
drops on the next tick (STAGING-empty) or nudges about the wrong cards. Mitigations: narrow the fix
to feature-watch widening only; drop the queue-watch-from-board-dispatch, composition-root-split, and
eager-disarm deliverables; record the "why does the operator still nudge" question as outstanding
pending the liveness rebuild.

## Proposed Changes

### 1. Widen the feature watch to arm on any feature dispatch, not just a drive-mode lead's (`src/services/KanbanProvider.ts`)

- **Context:** `_autoArmDriveModeFeatureWatch` (`:3813`) and its two call sites (`:10694`/`:10702` and
  `:10810`/`:10812`) gate on `role === 'lead'` and, inside the helper, `feature_drive_enabled === 'true'`.
  On this board features went to planners and a reviewer, so no feature watch ever armed.
- **Logic:** Drop the `role === 'lead'` gate at **both** call sites (`:10694` and `:10810`), and drop
  the `feature_drive_enabled === 'true'` check inside the helper (`:3823-3824`). Keep the remaining
  gates: the card must be a feature (`card?.isFeature`), a workspace root must resolve, and
  `dispatchedAgent` must be a real non-`unknown` terminal (`:3831-3833`). The watch stays
  feature-specific (keyed by `featureId`, nudges about un-accepted subtasks).
- **Implementation:** Do **not** add a third call site or a new watch type. Audit both existing call
  sites and widen them in place — there are known to be several builders on the dispatch path, and an
  arm added to only one reproduces the current defect for the other.
- **Edge cases:** Re-arming stays idempotent (filter-then-push replaces). An unresolved
  `dispatchedAgent` still skips — a watch with no addressee has nobody to nudge. A feature driven by a
  planner/reviewer now arms; verify the nudge's `headTerminal` and "un-accepted subtasks" framing still
  apply when the head is not a drive-mode lead.

> **Superseded (from the original plan):** "Widen the auto-arm so any dispatch that puts a card on a seat arms the appropriate watch... a plan dispatched to a coder, planner or reviewer arms a stall watch keyed on that seat."
> **Reason:** No seat-keyed general stall watch exists. `featureWatches` is feature-specific (keyed by `featureId`, nudges about subtasks); `queueWatches` is queue-specific (keyed by `workspaceRoot`, drops on STAGING-empty). A plan dispatched to a coder is neither a feature nor a queue pop. The general seat-stall case is the predicate-based `_runDispatchStallSweep` (`PlanIngestionEngine.ts:2268`), which needs no arming. Arming the feature watch for a non-feature plan is a category error.
> **Replaced with:** Widen the feature watch to arm on any **feature** dispatch (drop the lead + drive-mode gates), keeping it feature-specific. Non-feature dispatches are left to the dispatch-stall and member-reminder sweeps.

### 2. Do NOT arm the queue watch from board dispatch (dropped deliverable)

> **Superseded (from the original plan):** "Arm the queue watch from board dispatch, not only the queue endpoints (`src/services/LocalApiServer.ts`)."
> **Reason:** The queue nudge sweep drops a watch when `kanbanColumn === 'STAGING' && !dispatchedAt && !featureId` is empty (`PlanIngestionEngine.ts:1419-1429`). A board dispatch moves a card to a coding column, not STAGING. A board-dispatch-armed queue watch either drops on the next tick (STAGING empty) or nudges about staged cards the board dispatch did not create. The watch list would be non-empty (the original plan's success metric) while the nudge is about the wrong cards — a green metric with an unmet goal.
> **Replaced with:** Dropped. The queue watch stays armed only from the queue pop (`LocalApiServer.ts:3753`) and the release path (`:5529`), which are the paths that actually stage cards.

### 3. Composition-root split — dropped (no defect exists)

> **Superseded (from the original plan):** "Close the `armQueueWatch` composition-root split (`src/extension.ts`)."
> **Reason:** Both roots wire `armQueueWatch` to the same `ingestionEngine.armQueueWatch`: standalone at `bootstrap.ts:4233`, extension via `TaskViewerProvider.ts:4510` (the options literal in `_startLocalApiServer`, reached because `extension.ts:1005` constructs the provider and `:1094` wires the engine). `extension.ts` has zero *direct* references because it delegates; the original plan grepped the wrong file and read the delegation as a split.
> **Replaced with:** Dropped. No code change.

### 4. Disarm on the completion post — dropped (the sweeps already disarm)

> **Superseded (from the original plan):** "Disarm on the completion post... Clear the watch on the explicit completion POST, which is the one signal the sweep cannot null."
> **Reason:** The feature sweep already drops a watch when every subtask has a completion post (`PlanIngestionEngine.ts:1186-1191`, keyed on `completedAt`). The queue sweep already drops when STAGING is empty (`:1424-1429`). Both key on `completed_at` / board state — the same "one signal." Moving the drop into the completion handler (`completeCardInternal`) would require a second implementation of the "are all subtasks done?" predicate that can disagree with the sweep's. Eager disarm adds a second off-switch for the same condition.
> **Replaced with:** Dropped. The sweeps' existing drop logic is the off-switch. The orphaned-watch edge case (deleted/archived card) is also already handled: archived subtasks are absent from `getSubtasksByFeatureId` (status filter) → `remaining.length === 0` → feature watch dropped; a deleted staged card empties STAGING → queue watch dropped.

### 5. A test that fails when nothing is armed (retained, narrowed to the feature watch)

- **Logic:** The defect is an empty feature-watch list for a feature dispatched to a non-lead. Add a
  check that dispatching a **feature** to a planner (or reviewer) arms a feature watch — i.e.
  `kanban.featureWatches` is non-empty for that `featureId`.
- **Rationale:** The original plan's broader test ("dispatching a card leaves a non-empty watch list
  for each dispatch surface and in both hosts") would pass for the queue-watch-from-board-dispatch
  change that this review dropped as a category error. Narrow the test to the change that survives:
  the feature watch arms for non-lead feature dispatches.
- **Note:** Do **not** assert that non-feature dispatches arm any watch — they are covered by the
  predicate-based dispatch-stall and member-reminder sweeps, which need no arming. A test asserting
  "non-feature dispatch arms a watch" would assert the wrong invariant.

## Verification Plan

### Automated Tests
- Dispatch a **feature** to a planner from the board → `kanban.featureWatches` contains a record for
  that `featureId` within one tick.
- Dispatch a **feature** to a reviewer from the board → same.
- Re-arming the same feature (re-dispatch to a different seat) replaces rather than stacks.
- A non-feature plan dispatched to a coder arms **no** watch (the dispatch-stall sweep covers it;
  arming would be a category error).
- Composition-root parity: both hosts already wire `armQueueWatch` (standalone `bootstrap.ts:4233`,
  extension `TaskViewerProvider.ts:4510`) — a parity test may assert this, but no change is needed.

### Goal Invariants
- After a feature dispatch to any role (lead, planner, reviewer), a feature watch is armed for that
  `featureId` in `kanban.featureWatches`.
- No arming path requires an agent to call a verb (`watchFeature` is never agent-instructed).
- No threshold value (`turnEndSilenceMs`, `nudgeSilenceMs`, `dispatchStallMs`, `timeoutMs`,
  `livenessWindowMs`) is changed by this plan.
- The queue watch is armed only from paths that stage cards (queue pop `:3753`, release `:5529`); a
  board dispatch to a coding column arms no queue watch.
- `_runDispatchStallSweep` and `_runMemberCompletionReminderSweep` remain predicate-based and
  un-armed — no watch list gates them.

### Manual
- Rebuild the host with the `goPtyFleetProjection.ts` binary-frame fix deployed; confirm `lastDataAt`
  advances on terminal output before any nudge verification (a frozen clock invalidates everything).
- Dispatch a feature to a planner from the board; confirm `kanban.featureWatches` is non-empty for
  that `featureId` within one tick.
- Let the feature head go quiet past `turnEndSilenceMs` with un-accepted subtasks and no completion
  post; confirm the feature nudge arrives.
- Confirm a working feature head is **not** nudged — the mid-turn gate must hold with liveness
  unfrozen (the freeze makes this gate over-fire; the rebuild is a prerequisite).
- Repeat under `npx switchboard`.

## Outstanding Questions

- **[user]** Why does the operator still nudge seats forward by hand when the predicate-based
  `_runDispatchStallSweep` (30 min default) and `_runMemberCompletionReminderSweep` already fire for
  board-dispatched cards and quiet team members without any arming? — proceeding on the assumption
  that the liveness freeze (frozen-positive `lastDataAt`) caused the predicate-based sweeps to
  over-fire into working seats, which the operator learned to ignore, masking the real signal; the
  rebuild + the feature-watch widening should be verified against the operator's actual workflow
  before declaring the symptom fixed. If the operator's seats routinely stall under 30 min, the
  dispatch-stall threshold (not the arming) is the lever — but that is a separate, post-data question.
