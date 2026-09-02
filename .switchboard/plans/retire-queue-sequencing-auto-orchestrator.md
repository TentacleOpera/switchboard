# Remote staging auto-seats the orchestrator, in the one path the code says must hold no judgement — delete the flag, the dead constant, and the stale docblocks

## Goal

Remove the only automatic Mission Control wake in the system. Mission Control is an optional project-management layer — board organisation, advice on which plans to queue and whether worktrees are needed, pre-flight checks, a simpler front end than the teams UI. Seating one because cards staged inserts advisory judgement into a path the same file declares must have none.

### Problem Analysis

`RemoteControlService.ts` states the principle and then breaks it, ~50 lines apart.

At `:779-781`, the staging branch:

> *"No agent is woken — staging is mechanical, and no judgement belongs in the correctness path of the one mechanism whose value is having none."*

At `:734`, on that same staging path, `queueSequencing` calls `onSequenceBatch` with the staged plan ids.

And what that dep actually does is nothing like what it claims. `KanbanProvider:2728` calls `startMissionControlFromKanban(wsRoot, undefined)` at `:2740`, logs the staged count, and returns `{ sequenced: true }`. That is the whole implementation. Meanwhile the docblocks at `:59-68` and `:146-156` describe *"reorder by dependency / group into features before the first dispatch"* — behaviour that is not in the code and was deliberately removed. The `manage-features` skill records the removal: *"After the removal of the `Miscellaneous` sweep… Standalone plans are left standalone — under the `none` worktree default a plan with no feature dispatches straight to a team, so there is no sweep and no `Miscellaneous` catch-all."*

Three further signs the blocking design was dismantled and its scaffolding left behind:

- **`SEQUENCING_BOUND_MS` is declared and never used.** It is a local constant at `KanbanProvider:2739` (`5 * 60 * 1000`) whose neighbouring comment asserts a bound the code does not enforce — the comment at `:2742-2746` explicitly says *"A timer-based fallback is not needed here because the queue is never held shut."*
- **The queue is explicitly never held shut** — the implementation's own comment says *"the lead can pull the first card while Mission Control is still sequencing."* So the seated Mission Control gates nothing; it may reorder the tail of a queue already being consumed.
- **The flag's remaining behaviour is redundant with the default queue consumer.** `queue/next`'s default pacing is `'head'` — *"the regression gate for ~4,000 installs"* — where the requesting head receives the card and delegates subtasks itself. Nothing needs a Mission Control for the queue to work.

Grouping before dispatch also has nothing left to do: with individual plan enqueue, each staged card is pulled on its own via `queue/next`, so a feature wrapper buys nothing at that boundary.

### Root Cause

A blocking group-then-sequence step was designed, then removed once individual enqueue landed. The removal took the behaviour and left the flag, the dep, the constant, and the prose. The docblocks then became the most authoritative-looking description of a design that no longer exists — and they mislead readers into describing removed behaviour as current, which happened during the session that produced this plan.

### Non-goals

- **Not removing Mission Control.** Its deliberate entry points stay: the shell rail icon, implementation.html's Manage button, and `POST /mission-control/start`. The latter is how an external agentic app drives everything remotely, and it must keep working.
- Not changing `mode: 'queue'` staging behaviour, `queue/next`, or head pacing.
- Not adding a replacement automatic trigger of any kind.

## Metadata

**Complexity:** 3
**Tags:** remote-control, reliability, cleanup, dead-code

## User Review Required

None.

## Complexity Audit

### Routine
- Deleting an unused local constant and correcting two docblocks.

### Complex / Risky
- **`queueSequencing` is persisted config with a live UI in two webview files.** It sits inside one JSON blob in the DB `config` table under `REMOTE_CONFIG_KEY`. `src/webview/connections.js:236` reads it into a checkbox with `:277` writing it back from `#remote-queue-sequencing`. `src/webview/linear.html:377` has a second checkbox (`#linear-queue-sequencing`) with its own label and tooltip. Removing a field from a shipped config blob must preserve every unknown and legacy key rather than rewriting the object. Both UI surfaces must be removed in lockstep with the provider.
- **Anyone who turned it on gets a behaviour change.** Their staging stops seating a Mission Control. That is the intended outcome, but it should be a visible removal rather than a silent one.

## Edge-Case & Dependency Audit

- The `onSequenceBatch` dep is optional (`onSequenceBatch?`) and absent in test harnesses, so removing it should not disturb tests — verified: no test references `queueSequencing`, `onSequenceBatch`, or `SEQUENCING_BOUND_MS`.
- `RemoteConfig` normalisation runs in two places, `:305` on read and `:324` on write. Both must drop the field consistently, and neither may discard sibling keys.
- Removing the checkbox from `connections.js` **and `linear.html`** is a webview/provider contract change — all three sides in lockstep.
- **`_stagedThisCycle` must be preserved.** It is also consumed by the `onArmQueueWatch` path at `:717` (`if (this._stagedThisCycle && this._deps.onArmQueueWatch)`), which is a separate, live feature (the queue stall backstop). Only `_stagedPlanIdsThisCycle` is exclusive to the sequencing path — it is set at `:806` and read only at `:736-738` inside the `queueSequencing` branch. Delete `_stagedPlanIdsThisCycle`; keep `_stagedThisCycle`.
- Do **not** delete `startMissionControlFromKanban` or its HTTP route (`POST /mission-control/start`). Only this caller.
- The stale docblocks are the deliverable, not a side note. Leaving them corrected-but-vague repeats the failure.
- `onStageForQueue` (`KanbanProvider:2682`, the remote staging dep) is intact and unaffected — it stages to `STAGING` and is a separate code path.

## Dependencies

- Independent of the other subtasks in this feature, though it should land first: the instructions-column plan establishes the *correct* Mission Control trigger, and removing the incorrect automatic one first keeps the two from being confused.
- **Resolved, not blocking.** The DISPATCH-to-STAGING change this clause was waiting on **has landed** (commit `52404992`: a real `STAGING` column replaced the `DISPATCH` display mode), and its stale successor `feature_plan_20260811103000_staging-flag-replaces-dispatch-column.md` has been retired and deleted. `stageForQueue` was **not** removed: it survives and now stages to `STAGING`, and its live non-UI caller `onStageForQueue` (`KanbanProvider:2682`, the remote staging dep) is intact. So there is no sequencing to negotiate and no verb to retarget — stage to `STAGING` and treat the verb as stable.

## Adversarial Synthesis

Key risks: removing `_stagedThisCycle` along with `_stagedPlanIdsThisCycle` would silently disable the queue stall backstop (`onArmQueueWatch`); missing the `linear.html` checkbox leaves a dangling UI control writing to a field the provider no longer reads. Mitigations: preserve `_stagedThisCycle` explicitly; audit both webview files for the checkbox.

The tempting alternative is to keep the flag and rename it to describe what it does — "seat a Mission Control when cards stage." That preserves a trigger which contradicts the staging path's stated contract, and leaves a default-off flag nobody will find. If Mission Control is optional and consultative, the honest surface is the button that already exists.

The second temptation is to correct the docblocks and stop. That leaves working code implementing a removed design, and the next reader has to re-derive that the flag does almost nothing.

## Proposed Changes

1. **Delete the `queueSequencing` call site** at `RemoteControlService:734` and the `onSequenceBatch` dep declaration at `:146-156`, plus the `KanbanProvider:2728` implementation.
2. **Delete `SEQUENCING_BOUND_MS`** (the local constant at `KanbanProvider:2739`) and the comment asserting an unenforced bound.
3. **Remove the `queueSequencing` field from `RemoteConfig`** (the interface at `:69`) and both normalisation sites (`:305` read, `:324` write), preserving all unknown and legacy keys in the stored blob.
4. **Remove the Connections-panel checkbox** (`connections.js:236/277`) **and the Linear-panel checkbox** (`linear.html:377`) in lockstep with the provider.
5. **Correct the docblocks at `:59-68` and `:146-156`** — or delete them with the code they describe.
6. **Delete `_stagedPlanIdsThisCycle`** (declaration at `:196`, reset at `:684`, push at `:806`, read at `:736-738`). **Preserve `_stagedThisCycle`** — it is also consumed by the `onArmQueueWatch` path at `:717`.

### Migration

Field removal from a shipped config blob. Read-and-ignore rather than reject, and never rewrite the object in a way that drops sibling keys — `integration-config.json` and this blob both have a history that makes naive rewrites dangerous. No user action required; the field simply stops being honoured.

## Verification Plan

1. **Staging wakes nobody.** Stage several cards via the remote path and confirm no Mission Control terminal is created. `STAGING` is a real column at HEAD, which makes `mode: 'queue'` unnecessary — so stage by mapping a provider list to `STAGING` rather than by flipping a mode. The assertion is unchanged: staging is mechanical and must wake no agent.
2. **The queue still drains.** Confirm the head pulls staged cards via `queue/next` in `queue_position` order, unchanged.
3. **Both Mission Control entry points still work.** The shell rail icon, implementation.html's Manage button, and `POST /mission-control/start`.
4. **Legacy config is tolerated.** Load a stored blob containing `queueSequencing: true` plus an unrecognised sibling key; confirm no crash, the field is ignored, and the sibling survives a subsequent write.
5. **No dead references.** Confirm `SEQUENCING_BOUND_MS`, `onSequenceBatch`, and `_stagedPlanIdsThisCycle` have no remaining referents.
6. **Queue stall backstop intact.** Confirm `onArmQueueWatch` still fires when cards are staged (it reads `_stagedThisCycle`, which is preserved).
7. **Full suite green**, with attention to harnesses that omitted the optional dep.

### Goal Invariants

- **Negative:** `queueSequencing` is absent from the `RemoteConfig` interface at `RemoteControlService.ts`.
- **Negative:** `onSequenceBatch` is absent from the `RemoteControlDeps` interface at `RemoteControlService.ts`.
- **Negative:** `SEQUENCING_BOUND_MS` is absent from `KanbanProvider.ts`.
- **Negative:** `_stagedPlanIdsThisCycle` is absent from `RemoteControlService.ts`.
- **Positive:** `_stagedThisCycle` is still present and read at the `onArmQueueWatch` call site in `RemoteControlService.ts`.
- **Positive:** `startMissionControlFromKanban` is still present in `TaskViewerProvider.ts` and its `POST /mission-control/start` route is still routed in `LocalApiServer.ts`.
- **Negative:** `#remote-queue-sequencing` is absent from `connections.js` and `#linear-queue-sequencing` is absent from `linear.html`.

## Outstanding Questions

None.
