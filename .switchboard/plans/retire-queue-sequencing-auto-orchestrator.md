# Remote staging auto-seats the orchestrator, in the one path the code says must hold no judgement — delete the flag, the dead constant, and the stale docblocks

## Goal

Remove the only automatic orchestrator wake in the system. The orchestrator is an optional project-management layer — board organisation, advice on which plans to queue and whether worktrees are needed, pre-flight checks, a simpler front end than the teams UI. Seating one because cards staged inserts advisory judgement into a path the same file declares must have none.

### Problem Analysis

`RemoteControlService.ts` states the principle and then breaks it, 40 lines apart.

At `:771-774`, the staging branch:

> *"No agent is woken — staging is mechanical, and no judgement belongs in the correctness path of the one mechanism whose value is having none."*

At `:727`, on that same staging path, `queueSequencing` calls `onSequenceBatch` with the staged plan ids.

And what that dep actually does is nothing like what it claims. `KanbanProvider:2639` calls `startOrchestratorFromKanban(wsRoot, undefined)`, logs the staged count, and returns `{ sequenced: true }`. That is the whole implementation. Meanwhile the docblocks at `:60-68` and `:148` describe *"reorder by dependency / group into features before the first dispatch"* — behaviour that is not in the code and was deliberately removed. The `manage-features` skill records the removal: *"After the removal of the `Miscellaneous` sweep… Standalone plans are left standalone — under the `none` worktree default a plan with no feature dispatches straight to a team, so there is no sweep and no `Miscellaneous` catch-all."*

Three further signs the blocking design was dismantled and its scaffolding left behind:

- **`SEQUENCING_BOUND_MS` is declared and never used.** Its neighbouring comment asserts a bound the code does not enforce.
- **The queue is explicitly never held shut** — the implementation's own comment says *"the lead can pull the first card while the orchestrator is still sequencing."* So the seated orchestrator gates nothing; it may reorder the tail of a queue already being consumed.
- **The flag's remaining behaviour is redundant with the default queue consumer.** `queue/next`'s default pacing is `'head'` — *"the regression gate for ~4,000 installs"* — where the requesting head receives the card and delegates subtasks itself. Nothing needs an orchestrator for the queue to work.

Grouping before dispatch also has nothing left to do: with individual plan enqueue, each staged card is pulled on its own via `queue/next`, so a feature wrapper buys nothing at that boundary.

### Root Cause

A blocking group-then-sequence step was designed, then removed once individual enqueue landed. The removal took the behaviour and left the flag, the dep, the constant, and the prose. The docblocks then became the most authoritative-looking description of a design that no longer exists — and they mislead readers into describing removed behaviour as current, which happened during the session that produced this plan.

### Non-goals

- **Not removing the orchestrator.** Its two deliberate entry points stay: the AUTOMATION tab's Start orchestrator button and `POST /kanban/orchestration/start`. The latter is how an external agentic app drives everything remotely, and it must keep working.
- Not changing `mode: 'queue'` staging behaviour, `queue/next`, or head pacing.
- Not adding a replacement automatic trigger of any kind.

## Metadata

**Complexity:** 3
**Tags:** remote-control, orchestrator, cleanup, dead-code

## User Review Required

None.

## Complexity Audit

### Routine
- Deleting an unused constant and correcting two docblocks.

### Complex / Risky
- **`queueSequencing` is persisted config with a live UI.** It sits inside one JSON blob in the DB `config` table under `REMOTE_CONFIG_KEY`, and `src/webview/connections.js:234` reads it into a checkbox with `:267` writing it back from `#remote-queue-sequencing`. Removing a field from a shipped config blob must preserve every unknown and legacy key rather than rewriting the object.
- **Anyone who turned it on gets a behaviour change.** Their staging stops seating an orchestrator. That is the intended outcome, but it should be a visible removal rather than a silent one.

## Edge-Case & Dependency Audit

- The `onSequenceBatch` dep is optional (`onSequenceBatch?`) and absent in test harnesses, so removing it should not disturb tests — verify rather than assume.
- `RemoteConfig` normalisation runs in two places, `:305` on read and `:324` on write. Both must drop the field consistently, and neither may discard sibling keys.
- Removing the checkbox from `connections.js` is a webview/provider contract change — both sides in lockstep.
- `_stagedThisCycle` and `_stagedPlanIdsThisCycle` exist to feed this call. Confirm nothing else consumes them before deleting; if they are otherwise unused, they go too.
- Do **not** delete `startOrchestratorFromKanban` or its HTTP route. Only this caller.
- The stale docblocks are the deliverable, not a side note. Leaving them corrected-but-vague repeats the failure.

## Dependencies

- Independent of the other subtasks in this feature, though it should land first: the instructions-column plan establishes the *correct* orchestrator trigger, and removing the incorrect automatic one first keeps the two from being confused.
- **Resolved, not blocking.** The DISPATCH-to-STAGING change this clause was waiting on **has landed** (commit `52404992`: a real `STAGING` column replaced the `DISPATCH` display mode), and its stale successor `feature_plan_20260811103000_staging-flag-replaces-dispatch-column.md` has been retired and deleted. `stageForQueue` was **not** removed: it survives and now stages to `STAGING`, and its live non-UI caller `onStageForQueue` (`KanbanProvider:2593`, the remote staging dep) is intact. So there is no sequencing to negotiate and no verb to retarget — stage to `STAGING` and treat the verb as stable.

## Adversarial Synthesis

The tempting alternative is to keep the flag and rename it to describe what it does — "seat an orchestrator when cards stage." That preserves a trigger which contradicts the staging path's stated contract, and leaves a default-off flag nobody will find. If the orchestrator is optional and consultative, the honest surface is the button that already exists.

The second temptation is to correct the docblocks and stop. That leaves working code implementing a removed design, and the next reader has to re-derive that the flag does almost nothing.

## Proposed Changes

1. **Delete the `queueSequencing` call site** at `:727` and the `onSequenceBatch` dep, plus the `KanbanProvider:2639` implementation.
2. **Delete `SEQUENCING_BOUND_MS`** and the comment asserting an unenforced bound.
3. **Remove the field from `RemoteConfig`** and both normalisation sites, preserving all unknown and legacy keys in the stored blob.
4. **Remove the Connections-panel checkbox** in lockstep with the provider.
5. **Correct the docblocks at `:60-68` and `:148`** — or delete them with the code they describe.
6. **Delete `_stagedThisCycle` / `_stagedPlanIdsThisCycle`** if nothing else consumes them.

### Migration

Field removal from a shipped config blob. Read-and-ignore rather than reject, and never rewrite the object in a way that drops sibling keys — `integration-config.json` and this blob both have a history that makes naive rewrites dangerous. No user action required; the field simply stops being honoured.

## Verification Plan

1. **Staging wakes nobody.** Stage several cards via the remote path and confirm no Orchestrator terminal is created. `STAGING` is a real column at HEAD, which makes `mode: 'queue'` unnecessary — so stage by mapping a provider list to `STAGING` rather than by flipping a mode. (This was previously conditional on another plan landing; it has, so the conditional is removed.) The assertion is unchanged: staging is mechanical and must wake no agent.
2. **The queue still drains.** Confirm the head pulls staged cards via `queue/next` in `queue_position` order, unchanged.
3. **Both orchestrator entry points still work.** The AUTOMATION tab button, and `POST /kanban/orchestration/start`.
4. **Legacy config is tolerated.** Load a stored blob containing `queueSequencing: true` plus an unrecognised sibling key; confirm no crash, the field is ignored, and the sibling survives a subsequent write.
5. **No dead references.** Confirm `SEQUENCING_BOUND_MS`, `onSequenceBatch`, and the staged-ids fields have no remaining referents.
6. **Full suite green**, with attention to harnesses that omitted the optional dep.

## Outstanding Questions

None.
