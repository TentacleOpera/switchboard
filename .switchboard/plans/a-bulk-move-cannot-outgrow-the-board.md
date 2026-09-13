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

- **Complexity:** 3
- **Tags:** kanban, performance, pi, bugfix

## User Review Required

None.

## Proposed Changes

### 1. A bulk move emits one refresh

The refresh is currently a side effect of each card's feature-file write, so N cards buy N
refreshes. A move operation — cascade or multi-select — must coalesce to a single refresh after the
whole set has been applied. Nothing about the final board state changes; only the number of times
it is built and pushed.

### 2. The board's own feature-file writes must not re-enter through the watcher

`_regenerateFeatureFile` writes a file the board just produced from its own DB, and the watcher
then treats that write as external input. The plan path already has this defence — the log line
`Skipping watcher insert for internally created plan` — and the **feature** path does not. Extend
the same suppression to feature-file regeneration so a move does not trigger a re-import of the
state it just wrote.

### 3. Apply a cascade in bounded chunks

`cascadeFeatureByPlanId` moves rows in one transaction, but the per-card work that follows it
(integration sync, run-sheet events, feature-file regeneration) fans out unbounded via
`Promise.allSettled` — so peak memory scales with the size of the set. Apply that fan-out in
bounded chunks, so a 500-subtask feature has the same peak cost as a 20-subtask one and only takes
longer.

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
