# Autoban: Delete `multi-column` and `antigravity-batch`, Scope It to PLAN REVIEWED → CODED, Drive It From Completion Reports

## Goal

Cut autoban down to the one thing it is good at — advancing cards from **PLAN REVIEWED → CODED** — and make it wait for agents to report completion instead of guessing with a timer.

Three changes in one card because they are one state machine: delete the `multi-column` mode and the `antigravity-batch` ghost, fix the transition autoban operates on so it can no longer be pointed anywhere else, and replace the clash-avoidance interval with the turn-end signal the watcher already derives.

### Problem & background

**Autoban works, and it works in exactly one place.** Its value is the mechanical transition: a plan is reviewed, a coder picks it up, the work happens. The transitions on either side — *into* PLAN REVIEWED and *into* CODE REVIEWED — are judgement calls that need a human to look at the output, so automating them produces work nobody trusts. That is not a defect to engineer around; it is the correct boundary, and the supported path should enforce it rather than imply it.

**`multi-column` automates the transitions autoban should not be making.** Its own description in the UI (`kanban.html:10309`) reads *"Automates multiple column transitions with per-role terminal pools. Best for full pipeline automation."* — which is precisely the behaviour that produces unreviewed work.

**`antigravity-batch` is already dead — only the name survives.** `KanbanProvider.ts:11226` states the successor *"retires the standalone antigravity-batch mode"*; `:5449` describes the remaining code as *"this shim keeps existing antigravity-batch callers working"*. In the UI it is a pure alias: `kanban.html:8348` is `if (mode === 'antigravity-batch') return 'scheduler';`. It survives as two live lines, two array entries and several comments. `scheduler` is the real mode and is **not** touched by this plan — timed jobs are a different job from board progression.

**A configurable source column is multi-column wearing a different name.** `SingleColumnAutobanConfig.sourceColumn` (`autobanState.ts:31`, default `'PLAN REVIEWED'`) lets autoban be pointed at any column on the board, with `sourceColumnRole` resolved from it (`TaskViewerProvider.ts:10189`) and a synthetic rule built for whatever column was chosen (`:10206-10208`). Deleting the mode that automates judgement transitions while leaving a picker that aims the surviving mode at those same columns deletes the label, not the behaviour. **PLAN REVIEWED → CODED is the scope. It is fixed in code.**

**The timer is a workaround for a signal autoban never subscribed to.** Autoban dispatches on an interval because it has no idea whether the previous seat finished. The watcher does: `PlanIngestionEngine.ts:376-401` derives turn-end from pty output silence and resolves it to `clearWorkingState` (finished) or `setBlockedState` (stopped, waiting on a human). That signal is CLI-agnostic and already fires. Autoban advances on it instead of on a clock.

**The global session cap is a timer-era artifact and goes with the timer.** `globalSessionCap` (default 200, `autobanState.ts:15`) minus `sessionSendCount` gates every dispatch (`_getAutobanRemainingSessionCapacity`, `TaskViewerProvider.ts:9227`), and on reaching zero it does not skip a card — it calls `_stopAutobanForExhaustion` and shuts the engine down (`:11784-11785`, `:11818-11819`, `:11851-11852`, `:11916-11917`). That cap exists because a clock-driven dispatcher can pile up work regardless of whether anything finished, so its blast radius had to be bounded at some arbitrary N. Change 4 deletes the clock. Once dispatch is one-per-completion-report and idempotent per card, one-in-one-out is structural — autoban cannot run away, because nothing advances until something reports. What the cap becomes is a hidden counter that silently halts an unattended board after N cards for no reason connected to anything going wrong. It is deleted in the same change that removes the timer.

**No shim is needed for any of it.** `normalizeAutobanConfigState` (`autobanState.ts:307-309`) validates the persisted mode against a whitelist and falls back to `'single-column'`:

```ts
automationMode: ([...]).includes(state?.automationMode as any)
    ? state!.automationMode!
    : 'single-column',
```

Removing the two values from that array means any persisted value fails `.includes()` and lands on `single-column`. That is the whole migration. A persisted `sourceColumn` is likewise simply ignored once the field is gone. **No mapping table, no compatibility path, no upgrade notice, no remap of one dead mode onto another, no disarm-on-load guard.** A deleted mode is deleted.

---

## Metadata

**Complexity:** 5
**Tags:** refactor, backend, ui, reliability
**Feature:** 6f852a90-a408-4d45-a52f-25729b64c5ec

---

## User Review Required

**None.** Five decisions made here:

* **`single-column` is the supported autoban path**, and it operates on exactly one transition: PLAN REVIEWED → CODED.
* **The source column is hard-coded**, not defaulted. The picker and the config field go; persisted values are ignored.
* **`multi-column` is deleted, not deprecated.** No flag, no legacy mode, no "left for existing users".
* **`antigravity-batch` is deleted**, alias line included. It falls through the whitelist like any other unrecognised value.
* **The global session cap is deleted, not raised.** `globalSessionCap` / `sessionSendCount` bound a timer's blast radius; report-driven dispatch bounds itself. A cap that stops the engine mid-run is a silent halt, which is the failure this feature exists to remove.
* **`scheduler` and `orchestration` are untouched.** Scheduler runs timed jobs, a different concern; orchestration belongs to the sibling orchestrator plans.

---

## Complexity Audit

* **Score:** 5 / 10

### Routine

* Removing two strings from three arrays and one union type.
* Deleting a ~370-line UI branch and its dropdown option, description and mode checks.
* Deleting an alias line and several stale comments.
* Removing a config field, its picker and its normaliser.

### Complex / Risky

* **Swapping the tick source is a real behaviour change**, not a deletion. The timer currently provides both pacing *and* an implicit "give up and move on" — a completion-driven loop that only advances on a report stalls forever if a report never arrives.
* **The multi-column UI branch is large and neighbours code that is not multi-column's.** `kanban.html:11149-11257` is a pools section inside it, and there is a **second** pools section outside it at `:10766-10901` that belongs to the sibling pools plan. Deleting the branch must take the first and leave the second.
* **The session cap has a wide footprint and one shared exit path.** `_stopAutobanForExhaustion` is called for several distinct reasons — roles exhausted, no valid tickets remaining, cap reached. Only the cap-reached branches go; the function and its other callers stay. `_allEnabledAutobanRolesExhausted` (`:9295`) also early-returns on capacity, and that clause goes while the roles logic stays.
* **The source column is woven through the tick path.** It keys the synthetic rule (`:10206-10208`), gates which rules `_startAutobanEngine` installs timers for (`:11686-11689`), and resolves the prompt role (`:10189`). Hard-coding it is four coordinated edits, not one constant.

---

## Edge-Case & Dependency Audit

### Race Conditions

* **A report arriving while a tick is in flight.** `_enqueueAutobanTick` (`:11535`) already serialises through `_autobanTickQueue` (`:776`); the completion handler must enqueue through the same chain rather than dispatching directly, or two dispatches race for the same card.
* **A duplicate completion report** for one card must dispatch the next card once. The sibling endpoint is first-wins per child and emits once, but autoban must also be idempotent per card — the event is not the only way a card can be marked done.
* **A report for a card that has since moved** (dragged by the user, completed manually) must be ignored, not acted on.
* **A report arriving while the engine is stopped or paused** must not restart it.

### Security

* Not a security change. The completion endpoint is authenticated by the sibling plan.

### Side Effects

* Users on `multi-column` land on `single-column` at next load. Their board keeps working; the multi-column automation stops. That is the point of deleting it.
* Users on `antigravity-batch` land on `single-column` like any other unrecognised value.
* Anyone who had pointed autoban at a column other than PLAN REVIEWED now gets PLAN REVIEWED. That is the intended scope, applied uniformly.
* Removing the timer removes the implicit watchdog. See the stall guard below — this is the one thing that must not be dropped.
* Autoban no longer stops itself after 200 dispatches. It runs until the source column is empty, the user stops it, or a report says the lane is blocked. That is the intent: the only reasons to stop are real ones.

### Dependencies & Conflicts

* **`src/services/PlanIngestionEngine.ts:376-401`** — the silent-seat classification autoban subscribes to; `clearWorkingState`'s transition boolean is the single-fire gate. Shared with the sibling turn-end notification card, which hangs off the same gate — confirm it fires once and drives both, rather than each adding its own guard.
* **`src/services/autobanState.ts`** — `:107` (union type), `:307-309` (validation array), `SingleColumnAutobanConfig.sourceColumn` / `sourceColumnRole` (`:31-32`), the default (`:66-67`) and the normaliser (`:83-87`).
* **`src/services/TaskViewerProvider.ts`** — `:10174` (accepted-modes array), `:10186-10201` (the single-column branch reading `msg.sourceColumn`), `:10206-10208` (synthetic rules keyed by the source column), `:10227-10228` (comment + the `enabled` ternary) and the now-dead `if (enabled)` block below it (`:10239-10242`), `_startAutobanEngine`'s column filter (`:11686-11689`), `_enqueueAutobanTick` (`:11535`), `_autobanLastTickAt` (`:772`).
* **`src/webview/kanban.html`** — `:6844`, `:6857`, `:8341`, `:8348`, `:9513`, `:10222`, `:10284`, `:10309`, `:10320`, the branch at `:10905-11277`, and the source-column picker in the single-column panel.
* **`src/services/KanbanProvider.ts`** — `:5449`, `:5694`, `:11226` (antigravity-batch comments only; no `multi-column` references in this file).
* **Sibling plan — retire terminal pools.** This card lands **first** and takes the multi-column pools copy with the branch. It does not touch `terminalPoolsSectionSc` (`:10766-10901`) or the controls-strip pool button (`:6638`) — those are the pools plan's. Both cards edit `kanban.html`; per the project PRD's one-stream-per-file rule they serialise.

---

## Dependencies

* Changes 1-3: none, lands against HEAD.
* Change 4: none. The turn-end signal and its transition gate exist at HEAD.

---

## Adversarial Synthesis

Key risks: (1) **removing the timer removes the watchdog** — a completion-driven loop with no stall detection waits forever on an agent that crashed, and the symptom is a board that silently stops, which is exactly what the user leaves running unattended; (2) **the multi-column UI branch is ~370 lines and sits next to a pools section that belongs to a sibling card**, so a careless delete takes the wrong copy or orphans references; (3) **hard-coding the source column touches four sites** — the config shape, the synthetic rule, the engine's column filter and the role resolution — and missing one leaves autoban armed on a column it no longer has a rule for, or with a rule nothing installs a timer for; (4) **duplicate or stale completion reports** dispatching the wrong card. Mitigations: keep an explicit stall timeout as a *watchdog* rather than a *pacer*, surfacing a stuck card instead of dispatching the next one; grep every `multiColumnContainer` reference before deleting and confirm the single-column pools section is untouched; make the source column one exported constant and route all four sites through it; enqueue completion-driven dispatch through the existing `_autobanTickQueue`, make it idempotent per card, and ignore reports for cards that have moved.

---

## Proposed Changes

**Build order:** (1) delete `antigravity-batch` → (2) delete `multi-column` → (3) hard-code the transition → (4) completion-driven dispatch. Changes 1-3 are independent of the sibling endpoint and ship first.

### 1. Delete `antigravity-batch`

**Implementation:**
* `src/services/autobanState.ts:107` — remove from the union type; `:307` — remove from the validation array.
* `src/services/TaskViewerProvider.ts:10174` — remove from the accepted-modes array; `:10227` — drop it from the comment.
* `src/webview/kanban.html:8341` — remove the comment block; `:8348` — remove `if (mode === 'antigravity-batch') return 'scheduler';`, and delete `remapAutomationMode` entirely if nothing else calls it.
* `src/services/KanbanProvider.ts:5449`, `:5694`, `:11226` — remove the three stale comments.

**Logic:** the mode was retired long ago; only the name and an alias line remain. Out of the validation array, a persisted value lands on `single-column` through the existing fallback.

**Edge cases:** no tombstone comment. Do not leave a note explaining that the mode used to exist — git history is the record.

### 2. Delete `multi-column`

**Implementation — logic:**
* `src/services/autobanState.ts:107` — remove from the union type; `:307` — remove from the validation array. **That line is the migration.**
* `src/services/TaskViewerProvider.ts:10174` — remove from the accepted-modes array.
* `src/services/TaskViewerProvider.ts:10227-10228` — remove the comment and the `const enabled = newMode === 'multi-column' ? … : false;` ternary. **Collapse what it leaves:** that branch's `enabled` becomes unconditionally `false`, so the `if (enabled) { … _startAutobanEngine(); }` block at `:10239-10242` is dead and goes with it. Do not leave a constant-false conditional.

**Implementation — UI (`src/webview/kanban.html`):**
* `:10905-11277` — delete the entire multi-column branch: `multiColumnContainer` and everything appended to it — the column-rules section, the automation-rules section, **its** pools section (`:11149-11257`) and the reset row (`:11277`).
* `:10284` — remove `{ value: 'multi-column', label: 'Switchboard Multi Column' }` from the mode dropdown.
* `:10309` — remove the description string.
* `:10320` — remove from the `isContinuousMode` array.
* `:6844`, `:10222` — remove the `else if (currentAutomationMode === 'multi-column')` branches.
* `:9513` — remove the multi-column badge-filtering branch and its comment; `:6857` — update the comment naming both single and multi.

**Edge cases:** before deleting, grep every `multiColumnContainer` reference and every function it calls to confirm nothing outside the branch depends on them. **Do not touch `terminalPoolsSectionSc` (`:10766-10901`) or the controls-strip `addAutobanTerminal` (`:6638`)** — the sibling pools plan owns those, and removing them here would leave its state removal half-matched.

### 3. Hard-code the transition to PLAN REVIEWED → CODED

**Context:** the source column is currently user-chosen and threaded through four sites.

**Implementation:**
* `src/services/autobanState.ts` — remove `sourceColumn` and `sourceColumnRole` from `SingleColumnAutobanConfig` (`:31-32`), from `DEFAULT_SINGLE_COLUMN_CONFIG` (`:66-67`) and from `normalizeSingleColumnConfig` (`:83-87`). Export one constant — `AUTOBAN_SOURCE_COLUMN = 'PLAN REVIEWED'` — as the single definition.
* `src/services/TaskViewerProvider.ts:10186-10201` — stop reading `msg.sourceColumn`; resolve the prompt role from the constant.
* `:10206-10208` — key the synthetic rule on the constant.
* `:11686-11689` — `_startAutobanEngine`'s single-column filter compares against the constant.
* `src/webview/kanban.html` — remove the source-column picker from the single-column panel and stop sending `sourceColumn` in its payloads.

**Logic:** autoban's whole justification is that PLAN REVIEWED → CODED is mechanical and its input is already settled. A picker makes that a default rather than a guarantee, and lets the surviving mode automate exactly the judgement transitions this card deletes `multi-column` for.

**Edge cases:** persisted `sourceColumn` values are ignored, not migrated. All four sites read the one constant — a hard-coded string repeated in four places is the same bug with extra steps.

### 4. Drive dispatch from completion reports

**Context:** the completion signal already exists and is CLI-agnostic. `PlanIngestionEngine.ts:376-401` classifies a dispatched seat that has gone silent: plan file advanced since dispatch → `clearWorkingState` (finished), otherwise → `setBlockedState` (stopped, waiting on a human). `clearWorkingState` returns a true-transition boolean, which is the single-fire gate. **No new endpoint, and nothing the agent has to POST** — an agent-reported design was built and removed on 2026-08-08 because it worked for one CLI and silently degraded for the rest.

**Implementation:** subscribe to that transition. On a real non-NULL→NULL clear for a card autoban dispatched, enqueue the next step through the existing `_autobanTickQueue` rather than waiting for the interval.

Retain a **stall watchdog** — a timeout after which a card with no report is surfaced as stuck. It does **not** dispatch the next card; it reports. That distinction is the point: the timer stops being what decides work is finished and becomes what notices work never finished.

**Delete the global session cap in the same change.** Remove `globalSessionCap` and `sessionSendCount` (`autobanState.ts:95-96`, `:277-284`), `DEFAULT_AUTOBAN_GLOBAL_SESSION_CAP` (`:15`), `_getAutobanRemainingSessionCapacity` (`:9227`), the capacity clause in `_selectAutobanTerminal` (`:9236`) and its `remainingDispatches` term (`:9266`), the increment in `_recordAutobanDispatch` (`:9288`), the capacity early-return in `_allEnabledAutobanRolesExhausted` (`:9295`), the four cap-reached `_stopAutobanForExhaustion` reasons (`:11784-11785`, `:11818-11819`, `:11851-11852`, `:11916-11917`), the stop log at `:9343`, and the two fields in `implementation.html:1954-1955`.

By the time this change lands the pools card has already removed `sendCounts` and `poolCursor`, leaving `_resetAutobanSessionCounters` (`:8940`) holding only `sessionSendCount` — so this change deletes that function and its seven call sites (`:9344`, `:9730`, `:9823`, `:10035`, `:10223`, `:10240`, `:13394`) rather than leaving an empty reset.

**Logic:** the cap bounded a clock's blast radius. With the clock gone, dispatch is paced by completion and cannot outrun itself; the cap's only remaining effect is to stop an unattended board at an arbitrary number.

**Edge cases:** a clear for a card autoban did not dispatch is ignored. The transition boolean makes it fire once; do not add a second guard that could suppress a real one. **A `setBlockedState` does not advance the card** — the seat stopped without finishing, so that lane halts and surfaces rather than dispatching past it. A clear arriving while autoban is stopped or paused does not restart the engine.

---

## Verification Plan

Tests are skipped per session directive, and compilation is skipped per session directive.

### Automated Tests

* A persisted `automationMode: 'multi-column'` normalises to `'single-column'`; every other persisted key survives untouched.
* A persisted `automationMode: 'antigravity-batch'` normalises to `'single-column'`.
* `single-column`, `scheduler` and `orchestration` normalise to themselves — the deletion did not catch a neighbour.
* A persisted `singleColumnConfig.sourceColumn` of anything other than PLAN REVIEWED is ignored; the engine installs its timer on PLAN REVIEWED.
* Grepping `src/` for `multi-column`, `multiColumn`, `antigravity-batch`, `antigravityBatch` and `sourceColumn` returns **nothing**.
* A `clearWorkingState` transition for a dispatched card enqueues the next step exactly once across repeated sweeps.
* A `setBlockedState` does not advance the card.
* A clear for a card autoban did not dispatch is ignored.
* An event with `status:"error"` or `"blocked"` does not advance the card.
* An event for a card that has moved is ignored.
* The stall watchdog surfaces a stuck card without dispatching the next one.
* Autoban dispatches past 200 cards in one session without stopping itself.
* `_stopAutobanForExhaustion` still fires for its other reasons — roles exhausted and no valid tickets remaining — after the cap branches are removed.
* Grepping `src/` for `globalSessionCap`, `sessionSendCount`, `GLOBAL_SESSION_CAP` and `_resetAutobanSessionCounters` returns **nothing**.
* The single-column pools UI and the controls-strip pool button still render after the multi-column branch is deleted.

### Manual Verification

1. **Existing multi-column user:** set `multi-column`, reload, confirm the board comes up on `single-column` with no error.
2. **The dropdown** offers `single-column`, `scheduler` and `orchestration` only, and single-column's description names PLAN REVIEWED → CODED.
3. **No picker:** confirm the source column cannot be changed from the UI and autoban operates on PLAN REVIEWED.
4. **End to end:** with autoban on, put a card in PLAN REVIEWED, confirm a coder is dispatched, have the agent report completion, and confirm the next card is dispatched **on the report** rather than on the interval.
5. **Stall:** dispatch a card and never report. The card is surfaced as stuck; nothing else is dispatched.
6. **Scheduler untouched:** a scheduled job still runs on its interval.

---

## Recommendation

Complexity 5 → **Send to Coder.**

Land changes 1-3 first — they need nothing else, and they must precede the pools card so it works against one remaining pools UI instead of two. Change 4 needs nothing new either: the turn-end signal it subscribes to is already in the tree.

**The thing to get right:** removing the timer must not remove the watchdog. The interval stops being what *advances* work and becomes what *notices work stopped*. Without that, an agent that dies silently produces a board that quietly stops — the worst failure for something left running unattended.

**Migration:** none. Removing the two values from the whitelist array is the entire migration; `normalizeAutobanConfigState`'s existing fallback handles every affected install. Persisted source columns are ignored. No shim, no mapping table, no upgrade notice.

---

## Completion Report — Changes 1, 2, 3, 4 (2026-08-15)

Implemented Proposed Changes 1 (delete `antigravity-batch`), 2 (delete `multi-column`), 3 (hard-code the transition to PLAN REVIEWED → CODED), and 4 (completion-driven dispatch plus deletion of the global session cap).

**Files changed (Changes 1-3):**
- `src/services/autobanState.ts` — Removed `'multi-column'` and `'antigravity-batch'` from the `automationMode` union type and the `normalizeAutobanConfigState` validation array. Removed `sourceColumn` and `sourceColumnRole` from `SingleColumnAutobanConfig`, `DEFAULT_SINGLE_COLUMN_CONFIG`, and `normalizeSingleColumnConfig`. Exported new `AUTOBAN_SOURCE_COLUMN = 'PLAN REVIEWED'` constant.
- `src/services/TaskViewerProvider.ts` — Added `AUTOBAN_SOURCE_COLUMN` import. Removed both dead modes from the `setAutomationModeFromKanban` accepted-modes array. Collapsed the else branch's `enabled` ternary (now unconditionally `false`) and deleted the dead `if (enabled)` block. Stopped reading `msg.sourceColumn`/`sourceColumnRole`; the synthetic rule, `_persistAutobanState`, `_getEnabledAutobanSourceColumns`, and all three single-column filter sites in `_startAutobanEngine`/pause-resume now route through `AUTOBAN_SOURCE_COLUMN`.
- `src/services/KanbanProvider.ts` — Removed three stale `antigravity-batch` comments (no code changes).
- `src/webview/kanban.html` — Deleted the `remapAutomationMode` function and its comment block; the `updateAutobanConfig` handler now assigns `automationMode` directly. Removed the `multi-column` dropdown option, description string, and `isContinuousMode` entry. Deleted both `else if (currentAutomationMode === 'multi-column')` branches (watch-count and hasWatchActive). Deleted the entire ~370-line multi-column UI panel branch (column rules, automation rules, its pools section, reset row). Removed the source-column picker from the single-column panel. Stopped sending `sourceColumn` in all single-column `postKanbanMessage` payloads. Updated both badge-filtering sites to use `'PLAN REVIEWED'` directly. Updated the `singleColumnConfig` default to drop `sourceColumn`/`sourceColumnRole`. Updated one stale comment referencing the remap. Rewrote the single-column mode description to name the PLAN REVIEWED → CODED transition (Manual Verification item 2). Collapsed dead constant-condition code introduced by hard-coding `scSourceCol`: removed the 8-entry `scColumnRoleMap` (always yielded `'lead'`), replaced the `resolvedRole` computation with `const resolvedRole = 'lead';`, collapsed the `scTargetLabel` if/else to the single reachable branch (removed the unreachable `!resolvedRole` and trailing `else` branches and the `custom_agent_` fallback), and removed the constant-false `if (scSourceCol !== 'PLAN REVIEWED')` conditional on the routing row. Left `scSourceCol` and `resolvedRole` as plain bindings because the sibling pools card's `terminalPoolsSectionSc` block reads them. The sibling pools card's `terminalPoolsSectionSc` block and the controls-strip `addAutobanTerminal` post were left untouched.

**Files changed (Change 4 — completion-driven dispatch + session cap deletion):**
- `src/services/autobanState.ts` — Deleted `DEFAULT_AUTOBAN_GLOBAL_SESSION_CAP` constant, `globalSessionCap` and `sessionSendCount` fields from `AutobanConfigState`, and their normalization in `normalizeAutobanConfigState`.
- `src/services/TaskViewerProvider.ts` — Deleted `_getAutobanRemainingSessionCapacity`, `_stopAutobanForExhaustion`, `_recordAutobanDispatch`, and `_resetAutobanSessionCounters` (function + all 5 call sites at `setAutobanEnabledFromKanban`, orchestration start, `setAutomationModeFromKanban`, kanban state-sync handler, and `_deregisterAllTerminals`). Removed `DEFAULT_AUTOBAN_GLOBAL_SESSION_CAP` from imports. Removed `remainingDispatches` from `AutobanTerminalSelection` and `'session-cap'` from `AutobanTerminalSelectionFailure`. Removed the session-cap early return from `_selectAutobanTerminal`. Collapsed the reason ternary at both `_selectAutobanTerminal` call sites to the no-target message alone (replaced `_stopAutobanForExhaustion` with `_stopAutobanWithMessage`). Removed the cap-reached check at the top of `_autobanTickColumn`. Removed the `_recordAutobanDispatch` call from `dispatchWithAutobanTerminal`. Added `_autobanDispatchedPlanFiles` (planFile → cardId) and `_autobanStallWatchdogs` (cardId → timeout) tracking maps. Added `handleAutobanTurnEnd` public method: on 'completed', clears the stall watchdog, removes tracking, and enqueues the next tick via `_enqueueAutobanTick(AUTOBAN_SOURCE_COLUMN, batchSize)`; on 'blocked', clears tracking but does NOT advance. Guards: ignores cards autoban didn't dispatch (`_autobanDispatchedPlanFiles`), ignores moved cards (`_activeDispatchSessions.has(cardId)`), never restarts a stopped/paused engine, only operates in single-column mode. Added `_armAutobanStallWatchdog` (3x interval timeout, surfaces stuck card via notification without dispatching) and `_clearAutobanStallWatchdog`. Updated `_stopAutobanEngine` to clear both new maps. Updated `_releaseSettledDispatchLocks` to clear stall watchdogs and dispatched-planFile entries for moved cards. Added `planFile` to the `dispatchWithAutobanTerminal` parameter type, `_selectAutobanPlanReviewedCards` return type, and `routedSessions` type so the tracking maps can be populated. Updated stale comment in `_deregisterAllTerminals`. **Removed the recurring `setInterval`** from `_startAutobanEngine`, `resetAutobanTimersFromKanban`, and the pause/resume path — the clock no longer dispatches. The chain is: prime once on start (the immediate `_enqueueAutobanTick`), then each completed turn-end enqueues the next, and the 60s empty-column sweep stops the engine when the column drains. The orchestration wake timer was left untouched (sibling card's territory).
- `src/extension.ts` — Added `taskViewerProvider.handleAutobanTurnEnd(info)` as a second consumer INSIDE the existing `setTurnEndNotifier` closure (not by re-calling the single-slot setter).
- `src/standalone/bootstrap.ts` — Added `taskViewerProvider.handleAutobanTurnEnd(info)` as a second consumer INSIDE the existing `setTurnEndNotifier` closure.
- `src/webview/implementation.html` — Removed `globalSessionCap` and `sessionSendCount` from the default `autobanState` object.
- `src/test/autoban-state-regression.test.js` — Removed assertions for deleted `globalSessionCap`/`sessionSendCount` fields.

**Stall watchdog:** the timer stops being what decides work finished and becomes what notices work never finished. On dispatch, a 3x-interval timeout is armed. If it fires before a completion/blocked turn-end, the card is surfaced as stuck via a temporary notification — nothing is dispatched, the engine is not stopped. The watchdog is cleared on completion, blocked, card-moved, or engine stop.

**Could not do:** Compilation and tests were skipped per session directive.

---

## Review Findings (reviewer pass, 2026-08-15)

Changes 1-3 verified clean — every acceptance grep (`multi-column`, `antigravity-batch`, `sourceColumn`/`sourceColumnRole`, `globalSessionCap`, `sessionSendCount`, `_resetAutobanSessionCounters`) is at zero in `src/`, `resetAutobanTimers` and `_stopAutobanForNoValidTickets` survive, and `AUTOBAN_SOURCE_COLUMN` is the single definition all four sites read. **Change 4 shipped dead in three independent ways**, each producing the identical symptom — autoban dispatches one card and the board silently stops, the exact failure this feature exists to remove: (1) the tracking map keyed dispatch on the **absolute** `planFile` while turn-end supplies the DB's **relative** `plan_file`, so the lookup could never match; (2) `_releaseSettledDispatchLocks` purged the tracking map and the stall watchdog, and that lock is released *inside the same tick as the dispatch* (`handleKanbanBatchTrigger` moves the card out of PLAN REVIEWED before the prompt is sent, then `_stopAutobanIfNoValidTicketsRemain` re-reads the column) — so both were cleared milliseconds after being armed; (3) `dispatchWithAutobanTerminal` called `_stopAutobanWithMessage` on no-target, which killed the engine on the first missing role *and* let the intern→coder→lead fallback keep dispatching after `_stopAutobanEngine()` had cleared every tracking map. Fixed in `src/services/TaskViewerProvider.ts`: added `_autobanPlanFileKey` (workspace-relative POSIX) and keyed both ends plus the watchdog through it, removed the completion tracking from `_releaseSettledDispatchLocks` and the `_activeDispatchSessions` gate/mutation from `handleAutobanTurnEnd`, and moved the loud no-target stop to after the fallback chain is exhausted; also regenerated `protocol-catalog.json`/`verbAllowlist.ts` (the CI gate `npm run catalog:check` was **red** — the checked-in catalog still listed three deleted orchestrator routes). Validation: `tsc --noEmit` clean bar 5 pre-existing TS2835 errors; `catalog:check`, `mirror:check`, `verb-returns:check` and `lint` green; `src/test/autoban-state-regression.test.js` fixed (3 stale `triggerMode` assertions, red at HEAD), given regression guards for all three defects above, and **wired into CI for the first time** (`test:contract:autoban-state`, plus `test:contract:autoban-no-valid-tickets`) — it had no npm script and no CI step, so every assertion in it was decorative. Remaining risk: the end-to-end pacing (manual verification 4-5) is still unexercised on a live fleet, and a no-target on the final fallback role now stops the engine rather than halting one lane.

---

## Review Findings (reviewer pass 2, 2026-08-16)

**Changes 1–3 remain clean** (every acceptance grep at zero, `AUTOBAN_SOURCE_COLUMN` the single definition), but **changes 3 and 4 have been deliberately superseded in the working tree since the 2026-08-15 pass**: `src/` now runs a two-step run sheet (`DEFAULT_AUTOBAN_RUN_SHEET` — CREATED → planner team, then PLAN REVIEWED → coder team) on a restored recurring `setInterval`, with completion pacing demoted to an opt-in `triggerMode: 'completion'` ("ON DONE"). That is intentional, not drift — `autoban-state-regression.test.js` now CI-asserts the interval **must** exist ("the clock is autoban's default pacing") — so it was left in place, but this plan's "PLAN REVIEWED → CODED is fixed in code" and "the clock no longer dispatches" no longer describe the shipped behaviour and no plan file records the run sheet. Layering the run sheet on top broke two invariants, both fixed in `src/services/TaskViewerProvider.ts`: **(1)** `_stopAutobanIfNoValidTicketsRemain` killed the engine the moment every enabled column emptied, so dispatching the last CREATED card stopped autoban while the planner was still running and its output landed in PLAN REVIEWED with the engine off — the silent stop this feature exists to remove; in-flight dispatches now veto the sweep, tracking is recorded in every trigger mode (not just `completion`), and the stall watchdog retires a record whose seat never reports so a dead agent cannot wedge the veto open. **(2)** a turn-end enqueued a pass over *every* run-sheet step, so one completion in the planner lane also dispatched into the coder lane and the in-flight count compounded each generation — directly contradicting the "report-paced dispatch is one-in-one-out and cannot outrun itself" argument used to delete `globalSessionCap`; a new `_autobanLaneInFlight` check now skips a step whose lane still has a card out. Also fixed: `kanban.html:10273` still advertised the mode as "Automates the PLAN REVIEWED → CODED transition" — false since the run sheet added an unattended planner lane the description never mentioned — and the ON DONE tooltip's "exactly one card is ever in flight"; both rewritten, and five regression guards for the above were added to the CI-wired `test:contract:autoban-state`. Verification was run, not skipped: `tsc --noEmit` clean bar 5 pre-existing TS2835 errors, `catalog:check`/`mirror:check`/`verb-returns:check`/`lint` green, 92 CI-wired suites executed with 7 failures, all reproduced red at HEAD in a detached baseline worktree; end-to-end pacing (manual verification 4–5) is still unexercised on a live fleet.
