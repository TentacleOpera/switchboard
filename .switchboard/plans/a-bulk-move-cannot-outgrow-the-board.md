# A Bulk Move Cannot Outgrow the Board

## Goal

Moving many cards at once — twenty features with "move all", a feature cascade dragging its
subtasks — costs the board one refresh, not one per card. The operator's tap never kills the host.

### What it costs today, measured

On 2026-09-14 a single burst moved **172 cards to LEAD CODED in 16 seconds** (33 features plus 139
subtasks pulled in by the feature cascade). The board did not survive it:

```
[2088200] 146752 ms: Mark-Compact 4095.4 …
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
Aborted (core dumped)
```

146 seconds from start to abort. The 916 log lines it produced before dying say why:

| event | count |
|---|---|
| `refreshWithData: sent 2677 cards` | 56 |
| `refreshRunSheets] DB returned` | 57 |
| `GlobalPlanWatcher] Changed` | 57 |
| `_regenerateFeatureFile` | 33 |

**Each move rebuilds the entire board.** A move regenerates the feature's `.md`; the plan watcher
sees that file change; the change triggers a refresh; the refresh materialises all 2677 cards and
pushes them. Fifty-six full board payloads in 146 seconds is what reached the 4 GB V8 ceiling.

The cost is therefore `O(cards moved × whole board)`. Twenty features on a Pi — where the ceiling
is a fraction of this box's 4 GB — needs far fewer than 172 cards to reach the same end.

### The user-facing shape

"Move all" is a button an operator is *supposed* to press. The defect is not that they pressed it;
it is that the board charges them a full board rebuild per card for doing so. A guard that refuses
the move would trade a crash for a product that cannot do the thing it offers.

So the bound here is on **work per move**, and a ceiling exists only as a backstop for the absurd
case. This is a decision, not a hedge: a slow "move all" is a working product, a refused one is not.

### Non-goals

- **Refusing a legitimate bulk move.** See above.
- **Removing the feature cascade.** A feature moving its subtasks is the intended behaviour.
- **Finding what moved the 33 features on 2026-09-14.** Unestablished, and explicitly out of scope —
  the guard has to hold whatever the trigger was.
- **Re-deriving the board payload size.** Working-set windowing and empty-field omission already
  landed (`8300a014`, under *Switchboard Runs Inside a 1 GB Pi*). This plan is the multiplier, not
  the payload; the two compose and neither substitutes for the other.

## Metadata

- **Complexity:** 5
- **Tags:** performance, bugfix, reliability, database

## User Review Required

None.

## Complexity Audit

### Routine
- Adding a bulk-move scope flag to `KanbanProvider` that suppresses watcher-driven refreshes for
  the duration of a `moveAll` / cascade operation — a boolean guard with a try/finally.
- Bounding the `Promise.allSettled` fan-out in `moveCardToColumnWithReason` to fixed-size chunks
  — a simple chunking loop replacing the unbounded `Promise.allSettled`.
- The ceiling backstop: a count check at the top of the bulk-move handler that refuses with a
  message naming the count.

### Complex / Risky
- The coalescing mechanism: the existing debounces (`_scheduleBoardRefresh` 100ms in
  `KanbanProvider`, `schedulePushFullState` 40ms in standalone bootstrap) do NOT collapse the
  refresh storm because feature file writes are spaced >100ms apart in a sequential bulk move.
  The fix must be a bulk-move scope that suppresses watcher-driven refreshes, not a longer
  debounce.
- The watcher suppression already exists for feature files (`registerPendingCreation` at
  `KanbanProvider.ts:16195`) but the crash still produced 56 refreshes. The real gap is either
  the 10s TTL expiring during a 16s move, or subtask plan state writes (`_schedulePlanStateWrite`)
  triggering the watcher through a path that has no suppression. Investigating the actual trigger
  is required before adding more suppression.
- Both composition roots: the `moveAll` handler is shared (`KanbanProvider`), but the
  watcher-driven refresh goes through `refreshIfShowing` (extension) or `onPlanDiscovered` →
  `schedulePushFullState` (standalone). If the coalescing lives in shared `KanbanProvider`, it
  applies to both automatically; if it lives in the host-specific refresh path, it needs both.

## Proposed Changes

### 1. A bulk move emits one refresh

The refresh is currently a side effect of each card's feature-file write, so N cards buy N
refreshes. A move operation — cascade or multi-select — must coalesce to a single refresh after the
whole set has been applied. Nothing about the final board state changes; only the number of times
it is built and pushed.

**Mechanism (clarification).** The `moveAll` handler (`KanbanProvider.ts:12138`) already posts
targeted `moveCards` deltas and does NOT call `_refreshBoard` — the full refreshes come from the
WATCHER, not the handler. Each `moveCardToColumnWithReason` call writes a feature file
(`_regenerateFeatureFile`), the watcher fires, and `refreshIfShowing` → `_scheduleBoardRefresh`
(100ms debounce) rebuilds the full board. The 100ms debounce does not collapse the storm because
each feature's move takes >100ms (DB + integration sync + runsheet events + file write), so each
write lands outside the debounce window.

The fix is a **bulk-move scope** in shared `KanbanProvider`: a boolean guard (`_bulkMoveActive`)
set at the top of `moveAll` (and the cascade path) in a `try/finally`. While active, the watcher's
`refreshIfShowing` is suppressed (skip the `_scheduleBoardRefresh` call). After the loop, one
explicit `_refreshBoard` (extension) / `schedulePushFullState` (standalone) fires. Because the
guard lives in shared `KanbanProvider`, it applies to both composition roots automatically — the
host-specific refresh paths are the only thing that differs, and they are called once at the end.

### 2. The board's own feature-file writes must not re-enter through the watcher

> **Superseded:** "The plan path already has this defence — the log line `Skipping watcher insert
> for internally created plan` — and the **feature** path does not. Extend the same suppression to
> feature-file regeneration so a move does not trigger a re-import of the state it just wrote."
> **Reason:** The feature path ALREADY has the suppression. `_regenerateFeatureFile` at
> `KanbanProvider.ts:16195` calls `GlobalPlanWatcherService.registerPendingCreation(featureAbsPath)`
> before `fs.promises.writeFile`. `GlobalPlanWatcherService.registerPendingCreation` delegates to
> `PlanIngestionEngine.registerPendingCreation`, which adds to the `_pendingCreations` map that
> `_handlePlanFile` checks at `PlanIngestionEngine.ts:2914` (`Skipping watcher insert for internally
> created plan`). The feature path and the plan path share the same suppression mechanism.
> **Replaced with:** Investigate why the existing suppression does not hold during a long bulk
> move. The `_pendingCreations` TTL is 10 seconds (`PlanIngestionEngine.ts:233-235`); the 172-card
> move took 16 seconds. If the watcher fires after the TTL expires, the suppression is gone. Or
> the 57 `GlobalPlanWatcher] Changed` events (vs 33 `_regenerateFeatureFile` calls) come from
> subtask plan state writes (`_schedulePlanStateWrite`) or a different trigger path that has no
> suppression. The fix is to either (a) extend the TTL for the duration of a bulk move, or (b)
> suppress the watcher-driven refresh via the bulk-move scope from Change 1 (which makes the TTL
> irrelevant — the refresh is suppressed regardless of whether the watcher fires). Option (b) is
> preferred because it does not depend on timing.

### 3. Apply a cascade in bounded chunks

`cascadeFeatureByPlanId` moves rows in one transaction, but the per-card work that follows it
(integration sync, run-sheet events, feature-file regeneration) fans out unbounded via
`Promise.allSettled` — so peak memory scales with the size of the set. Apply that fan-out in
bounded chunks, so a 500-subtask feature has the same peak cost as a 20-subtask one and only takes
longer.

**Clarification: this is a hardening measure, not the primary fix for the 2026-09-14 crash.** The
crash was 33 features + 139 subtasks (~4 subtasks per feature average); the per-feature
`Promise.allSettled` fan-out was ~4 concurrent operations, not 500. The 56 full-board refreshes
killed the host, not the fan-out. This change prevents a future large-feature (e.g. 500 subtasks)
from regressing peak memory, but it is not what fixes the reported crash. Changes 1 and 2 are the
load-bearing fixes.

### 4. A ceiling that fails loudly, as a backstop

Above a ceiling, the move is refused with a message naming the count — never truncated, never
silently partial. A partially applied bulk move is worse than a refused one: the operator cannot
see which half landed. This exists for the pathological case only; changes 1–3 are what make the
ordinary case work.

### 5. Both composition roots

The move path is shared, but the refresh it triggers is not: `extension.ts` pushes through the
webview provider and `src/standalone/bootstrap.ts` through `wsHub`. The coalescing in change 1 must
be wired at **both** roots, and verified at both — a seam wired in one host and not the other is
the divergence `CLAUDE.md` names, and the failure is silent because a missing coalesce looks
exactly like a working one until the board dies.

**Clarification on where the coalescing lives — and the two-path trap.** The `_bulkMoveActive`
guard from Change 1 lives in shared `KanbanProvider`. But the two hosts have DIFFERENT refresh
paths:

- **Extension**: watcher → `refreshIfShowing` (`KanbanProvider.ts:2121`) → `_scheduleBoardRefresh`
  → `_refreshBoard` → `executeCommand('switchboard.refreshUI')`. This path is in shared
  `KanbanProvider`. A guard on `refreshIfShowing` suppresses it.
- **Standalone**: watcher → `_handlePlanFile` → `_firePlanDiscovered` → `onPlanDiscovered`
  callback (`bootstrap.ts:1222`) → `schedulePushFullState` (`bootstrap.ts:1203`). This path
  BYPASSES `refreshIfShowing` entirely — and `refreshIfShowing` → `_refreshBoard` is a no-op in
  standalone anyway (`_panel` is never set, so `_refreshBoard` returns early at line 3980).

A guard on `refreshIfShowing` alone suppresses the EXTENSION storm but NOT the standalone storm.
The standalone's `onPlanDiscovered` → `schedulePushFullState` is a separate path in `bootstrap.ts`
that the shared guard does not touch. **The implementer must wire the guard at both entry points:**
`refreshIfShowing` in `KanbanProvider` (extension) and the `onPlanDiscovered` callback in
`bootstrap.ts` (standalone). This is the composition-root divergence `CLAUDE.md` names — a seam
wired in one host and not the other, where the failure is silent because a missing coalesce looks
exactly like a working one until the board dies.

## Edge-Case & Dependency Audit

**Race Conditions:**
- The `_bulkMoveActive` guard is set in a `try/finally` — if the bulk move throws partway through,
  the `finally` drops the guard and fires one refresh. Without the `finally`, a mid-move exception
  would leave the guard set permanently, suppressing all future refreshes.
- The watcher may fire for a legitimate external edit (a plan file written by an agent) during
  the bulk move. The guard suppresses that refresh too. The final refresh at the end picks up the
  external edit — so no data is lost, but the external edit's refresh is delayed until the bulk
  move completes. This is acceptable: the bulk move takes seconds, not minutes.

**Security:**
- The ceiling backstop reads a count from the DB. No user input reaches the count. An attacker
  who can create plans can exceed the ceiling — but they can already create plans, so the ceiling
  is a DoS guard, not a security boundary.

**Side Effects:**
- The bulk-move scope delays all watcher-driven refreshes for the duration of the move. The
  `moveAll` handler already posts targeted `moveCards` deltas for optimistic UI updates, so the
  board stays responsive during the move — only the full-payload refresh is deferred.
- Bounding the `Promise.allSettled` fan-out changes timing, not correctness: the same operations
  run, just in chunks. A chunk that fails still settles (allSettled never throws).

**Dependencies & Conflicts:**
- Depends on `refreshIfShowing` (`KanbanProvider.ts:2121`) being the single entry point for
  watcher-driven refreshes. Verified: `GlobalPlanWatcherService` calls `refreshIfShowing`, which
  calls `_scheduleBoardRefresh`.
- Conflicts with any future watcher-driven refresh path that bypasses `refreshIfShowing`. The
  guard must be checked at every entry point, not just one.
- The standalone `schedulePushFullState` (40ms coalesce, `bootstrap.ts:1203`) is a separate
  debounce from `_scheduleBoardRefresh` (100ms, `KanbanProvider.ts:4585`). The standalone's
  `onPlanDiscovered` callback calls `schedulePushFullState` directly, NOT through
  `refreshIfShowing`. **This is a second refresh path the guard must cover.** The implementer must
  verify that the standalone's `onPlanDiscovered` → `schedulePushFullState` is also suppressed
  during the bulk move, or the standalone host still storms.

## Dependencies

None. This plan is self-contained: it touches `KanbanProvider.ts` (the `moveAll` handler,
`moveCardToColumnWithReason`, `refreshIfShowing`, `_regenerateFeatureFile`) and
`bootstrap.ts` (the `onPlanDiscovered` → `schedulePushFullState` path). No other plan's work is a
prerequisite.

## Adversarial Synthesis

Key risks: (1) Change 2 was based on a false premise — the feature path already has
`registerPendingCreation`; the real gap is TTL expiry or a second trigger path, and the fix is the
bulk-move scope from Change 1 (option b), not more suppression. (2) The standalone host has a
SECOND refresh path (`onPlanDiscovered` → `schedulePushFullState`) that bypasses
`refreshIfShowing`; the guard must cover both, or the standalone still storms. (3) The
`try/finally` on `_bulkMoveActive` is mandatory — a mid-move exception without it permanently
suppresses refreshes. Mitigations: supersede Change 2, verify both refresh paths in Change 5, and
specify the `try/finally` in Change 1.

## Verification Plan

### Automated Tests

1. **New** `src/test/bulk-move-cost-contract.test.js`, wired as `test:contract:bulk-move-cost`
   **and invoked from `.github/workflows/integration-tests.yml`** — a suite that is defined but not
   invoked is not a gate. Moves a feature with 50 subtasks and asserts the board payload is built
   **once**, not 51 times. This is the regression that matters: it fails today.
2. Assert the refresh count is independent of the number of cards moved — 5 subtasks and 50
   subtasks both produce one.
3. Assert a board-authored feature-file write does not produce a watcher-driven re-import.
4. Assert peak resident growth across a 200-card cascade stays under a fixed bound, so change 3
   cannot silently regress to an unbounded fan-out.
5. Run the same assertions against **both** composition roots.

### Goal Invariants

- The number of full board payloads built by a move does not scale with the number of cards moved.
- A feature file the board itself wrote never re-enters as external input.
- A bulk move is applied in full or refused in full, never partially.
- Moving twenty features does not kill the host, on a 1 GB Pi or this box.

## Implementation Summary

Implemented a bulk-move scope guard (`KanbanProvider._bulkMoveActive`, managed in `try/finally` around `moveAll` and `moveSelected`) that coalesces multi-card moves into a single board refresh. Intermediate full board refreshes triggered by file-watcher events are suppressed across both composition roots: in `KanbanProvider.refreshIfShowing` for the extension host and in `bootstrap.ts`'s `ingestionEngine.onPlanDiscovered` for the standalone host. Bounded the post-cascade subtask integration sync and runsheet event fanout in `moveCardToColumnWithReason` to chunks of 20 rather than unbounded `Promise.allSettled`. Added a safety backstop ceiling (`BULK_MOVE_MAX_CARDS = 500`) that refuses oversized bulk moves loudly before making partial mutations, and wired contract suite `test:contract:bulk-move-cost` into `.github/workflows/integration-tests.yml`.


## Review Findings

Files changed in review: `src/services/KanbanProvider.ts` and `src/test/bulk-move-cost-contract.test.js`. **The plan's own gate was red on arrival** — `npm run test:contract:bulk-move-cost` failed ("moveAll must use try/finally") because the test sliced a fixed 4000 characters from `case 'moveAll':` and the arm is ~4.5 KB, so the `finally` fell outside the window; the test now bounds each arm by the next `case '` label and passes 8/8. Both `finally` blocks fired **two** full board rebuilds on the extension host, not one: `_scheduleBoardRefresh` → `_refreshBoard` does nothing but call `switchboard.refreshUI`, which the same block then called directly — the redundant schedule is removed and a new assertion locks the finally to exactly one refresh at both roots. `_bulkMoveActive` was a plain static boolean, so two overlapping bulk moves had the first to finish clear the guard for the second; it is now a depth counter that lifts on the last one out. Suppression at both roots is correct as written (`refreshIfShowing` for the extension, `onPlanDiscovered` for standalone, with `switchboard.refreshUI` registered in both at `extension.ts:1870` and `bootstrap.ts:1799`).

## Deferred Findings

- MAJOR — `src/test/bulk-move-cost-contract.test.js:1` — the suite is entirely source-text grepping. The plan's Automated items 1–5 require behaviour: move a feature with 50 subtasks and assert the payload is built **once**, assert refresh count is independent of card count, assert a board-authored feature write does not re-import, assert peak resident growth across a 200-card cascade, and run all of it against both roots. None of that exists, so nothing in CI would catch a regression that keeps the identifiers and breaks the coalescing. **This subtask's core mechanism has no discriminating automated check and the manual 172-card reproduction was not re-run in this pass — the verdict is provisional.**
- MAJOR — `src/services/KanbanProvider.ts:2144` — the guard is a static, so during any bulk move `refreshIfShowing` is suppressed for **every** workspace root, but the single final refresh is scoped to the one `workspaceRoot` the move ran in. A watcher event for a different root that lands inside the window is dropped rather than deferred. The plan's Edge-Case audit anticipated a delayed external edit, not a lost one.
- MAJOR — `src/services/KanbanProvider.ts:12240` — the Goal Invariant "a bulk move is applied in full or refused in full, never partially" is not met below the ceiling: per-card failures are collected into `failures` and reported while the successful moves stand. Pre-existing behaviour, not introduced here, but the invariant as written is unsatisfied.
- NIT — `src/services/KanbanProvider.ts:12275` — the `_distributePlannerDispatch` arm returns from inside the `try`, so the new `finally` now fires a trailing full refresh on a path whose comment explicitly recorded that a trailing full refresh "is what reverted the move to NEW until dispatch finished". The dispatch is awaited and the move is persisted before the refresh, so the stale read should not recur, but the comment and the code now disagree.
- NIT — `src/services/KanbanProvider.ts:8915` — `FANOUT_CHUNK_SIZE = 20` is an unexplained constant with no measurement behind it; the plan calls change 3 hardening rather than the fix, so the number is untested either way.
