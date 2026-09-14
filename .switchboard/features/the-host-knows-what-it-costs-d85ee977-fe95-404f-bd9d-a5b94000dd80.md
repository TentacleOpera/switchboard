# The Host Knows What It Costs

**Complexity:** 5

## Goal

Consolidated 2026-09-10: measured on a Pi 400 — the host grows +256 MB RSS and +547 inotify watches over a day and gives none of it back; CPU is unattributed; hardware is undetected; the log file cannot be turned off. The feature makes the host aware of what it costs to run itself: where the CPU goes, what hardware it is on, what it is leaking, and what it writes to disk — so an operator on a small box is told before the box runs out, not after.

## How the Subtasks Achieve This

- **Attribute Switchboard's CPU before optimising it, and catch the wedge in the act**: makes CPU cost attributable per process and per terminal, and makes a blocked event loop dump where it is blocked. Gives "Switchboard is at 90%" a named decomposition and a diagnostic for the next wedge. (Measure-first; the one no-measurement fix is a client-filter hoist.)
- **Switchboard Does Not Know What Hardware It Is On, So Nothing Warns Before a Small Box Runs Out**: reads host capability (memory, cores, cgroup limit) once at startup with a tagged source, reports a ceiling at dispatch without blocking, and injects a constrained-host directive to agents on a small box. Closes the fallback-rule gap where "no capability read" is indistinguishable from "infinite capability."
- **The Host Accumulates Heap and inotify Watches Over a Day's Use**: stops the standalone host drifting from its published budget — adds a heap-snapshot hook, a periodic drift sampler, a drift assertion to the live contract test, and fixes the watch leak and (after a snapshot) the heap retention.
- **The Standalone Host Writes a Log File on Every Start, and Nothing Can Turn It Off**: deletes the unconditional `setupFileLogging` and every `logs/` creator, so the host no longer writes a synchronous per-line log file the operator cannot turn off.
- **The Heap Ceiling Is Set by the Launcher, So the npx Install Never Gets It**: `--max-old-space-size` is applied only at the two Go handoff sites, so a board installed via npm/npx — the documented route, and how this Pi runs — gets no ceiling at all. Adds a one-shot re-exec from the standalone entry, derives the default from `budget - measured_non_heap - offset` instead of the placeholder `512`, and logs which path supplied the value. Same theme as the hardware-capability subtask: a limit that is silently absent is indistinguishable from one that is set.
- **A Bulk Move Cannot Outgrow the Board**: 172 cards moved in 16 seconds OOM'd the host (`Mark-Compact 4095.4`) because a bulk move costs one full board refresh *per card*. Makes the burst cost one refresh. This is the concrete failure the other subtasks measure in the abstract — the heap ceiling governs the limit it hit, and the drift sampler is what would have shown it coming.

## Dependencies & sequencing

- Subtasks are **independent in their file regions** and can land in any order; there is no shared-file merge order where one must land first to avoid a conflict. Two **design coordinations** (not ordering gates) span subtasks:
  - **Signal-handler choice**: the CPU-attribution subtask's event-loop lag detector and the heap/inotify subtask's heap-snapshot hook may both want a signal (`SIGUSR2`/`SIGUSR1`). The two coders must agree on which signal each claims, or one clobbers the other's handler. Recorded in both plans' Edge-Case audits.
  - **The terminalLogWriter was deliberately removed** (commit `e26ac375`, 2026-09-07, "Go where
    it pays: static launcher, PTY host, and CLI client verbs") — cut as useless and memory-hungry
    during the Go PTY host migration. It is dead code by intent. Subtask 1 drops the log-writer
    hypothesis (not conditional — no sibling revives it); subtask 4 treats it as out-of-scope. The
    leftover `terminalLogWriter.ts` file and the stale contract test
    (`test:contract:terminal-session-log`, which asserts the removed `new TerminalLogWriter(`
    wiring) are separate cleanup, not blocking this feature.
- **Internal to the heap/inotify subtask**: the heap-snapshot hook (change 1) MUST land before the heap-retention fix (change 5), because the retainer cannot be named without a snapshot.
- No prerequisites or guards outside this feature's subtasks.

- **Added 2026-09-14 (two subtasks).** Both are host-cost failures and neither blocks the original
  four. Ordering that matters: *The Heap Ceiling* should land **before** *A Bulk Move*, because the
  bulk-move OOM was hit against V8's default ceiling on a 16 GB box — re-measuring the burst under a
  deliberately set ceiling is what tells you whether the refresh fix is sufficient or merely moves the
  cliff. *Attribute Switchboard's CPU* and the drift sampler are the instruments for both; run them
  first if the bulk-move cause is not already understood.

## Reconciliation outcome (2026-09-11)

- **Overlap (terminalLogWriter.ts)**: subtasks 1 and 4 both referenced the writer. Resolved in-place: both now record it as deliberately removed dead code (commit `e26ac375`, 2026-09-07 — cut as useless and memory-hungry); subtask 1's "prime suspect" hypothesis is Superseded to dropped (not conditional — no sibling revives it), subtask 4's "must keep working" constraint is Superseded to out-of-scope. No merge needed.
- **No contradictions remain.** The original contradiction (writer is the prime suspect AND must be preserved) rested on a shared false premise (writer is wired); both corrected against the removal commit.
- **Bonus finding:** the contract test `terminal-session-log-contract.test.js` (line 525) still asserts `new TerminalLogWriter(` wiring that `e26ac375` removed — it is stale and would fail if run. Flagged for separate cleanup; not a gate this feature must keep green.
- **No subtask is superseded, obsolete, or oversized.** No merge, delete, or split warranted. The four subtasks address four distinct symptoms grouped under one feature; the in-place corrections are the restructure.

## Team Dispatch Instructions

### The Standalone Host Writes a Log File on Every Start, and Nothing Can Turn It Off
- **Seat:** Intern (Complexity 2 — pure removal, no new logic).
- **Acceptance:**
  - Starting the standalone host (foreground and detached) creates no `.switchboard/logs/server.log` and no `.switchboard/logs/` directory from the host's own file logging.
  - `grep -rn "setupFileLogging\|LOG_CAP_BYTES" src/` returns nothing; `grep -rn "mkdirSync.*logs" src/standalone/cli.ts` returns nothing (covers both `:4432` and `:4515`).
  - The `switchboard logs` subcommand no longer tails a never-written file (removed or rewritten to say so).
  - No `console.*` call performs a synchronous filesystem write.
- **Must not touch:** `terminalLogWriter.ts` (deliberately removed dead code — out of scope), and the per-terminal session-log read endpoints in `LocalApiServer.ts` (they tolerate an absent dir). The stale contract test `test:contract:terminal-session-log` is out of scope (flagged for separate cleanup).

### Switchboard Does Not Know What Hardware It Is On, So Nothing Warns Before a Small Box Runs Out
- **Seat:** Coder (Complexity 5 — two-root wiring is the load-bearing risk).
- **Acceptance:**
  - On the Pi, `hostCapability` reports 4 cores / ~3.7 GB with `source: 'os'`; on a failed read, `source: 'unavailable'` and no directive/ceiling (no plausible substitute).
  - Inside a container with a memory limit, the reported total is the cgroup limit and the source says `'cgroup'`.
  - Starting a seat past measured headroom emits a report naming seats/used/total/estimate AND the seat still starts — no dialog at any point.
  - The per-seat estimate tracks observed RSS (not a constant); `CONSTRAINED_HOST_DIRECTIVE` contains machine figures and no command/script/build-system name.
  - The service is constructed in BOTH `extension.ts` and `bootstrap.ts`, and the dispatch report fires in BOTH `bootstrap.ts` and `TaskViewerProvider.ts` — verified by reading both roots, not by a verb check.
- **Must not touch:** `SKIP_COMPILATION_DIRECTIVE` (operator-controlled; do not re-point at hardware). Do not build a scheduler/admission-control — this plan reports and proceeds.

### The Host Accumulates Heap and inotify Watches Over a Day's Use
- **Seat:** Coder (Complexity 5 — the watch-leak hunt and the snapshot guard are the risky parts).
- **Acceptance:**
  - The heap-snapshot hook (`v8.writeHeapSnapshot()` via verb or `SIGUSR2`) is not reachable without explicit invocation; a snapshot file is produced on demand and is not world-readable.
  - A drift assertion in the live contract half dispatches N cards, releases them, re-probes, and asserts `rss` and `inotifyDescriptors` return to within noise of the pre-cycle reading (does NOT duplicate the existing fresh-host idle assertion).
  - `inotifyDescriptors` after a dispatch cycle equals the count before it (the watch-leak fix).
  - The periodic sampler's series is bounded and rotates; a failed probe does not poison the series.
- **Must not touch:** the existing fresh-host idle assertion in `resident-memory-budget-contract.test.js` (add beside it, do not duplicate). Coordinate the `SIGUSR2` choice with the CPU-attribution subtask's lag detector.

### Attribute Switchboard's CPU before optimising it, and catch the wedge in the act
- **Seat:** Coder (Complexity 5 — the attribution sampler and the out-of-loop lag detector are the risky parts).
- **Acceptance:**
  - With 4-8 seats, the attribution surface accounts for the machine's CPU (board, pty host, each named CLI seat, browser) and the sum is consistent with what the OS reports; the sampler's own cost is negligible at 8 seats.
  - An induced busy loop produces a stack dump on disk naming the loop, written WHILE the loop is still spinning, and the dump path works when `/health` is already failing.
  - The client-filter hoist (`terminalWsGateway.ts:838-839`) means a terminal with zero attached clients no longer encodes a frame; one with clients is byte-identical to before.
  - The log-writer `stripAnsi`/`collapseCarriageReturns` decomposition is NOT asserted — the writer was deliberately removed (e26ac375) and is dead code; the volume counters attribute the spike without it.
- **Must not touch:** the `stop`-gate region of `cli.ts` (the wedged-board survivability plan owns ungate work; this plan only notes it). Coordinate any signal-handler choice with the heap/inotify subtask's snapshot hook.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Attribute Switchboard's CPU before optimising it, and catch the wedge in the act](../plans/attribute-switchboards-cpu-before-optimising-it.md) — **LEAD CODED** — ID: 1023d997-626c-445b-9637-24a6088dafba
- [ ] [Switchboard Does Not Know What Hardware It Is On, So Nothing Warns Before a Small Box Runs Out](../plans/host-does-not-know-what-hardware-it-is-on.md) — **LEAD CODED** — ID: 1f191a51-71d2-4694-9f3a-533b082b277f
- [ ] [The Host Accumulates Heap and inotify Watches Over a Day's Use](../plans/the-host-accumulates-heap-and-inotify-watches-over-a-days-use.md) — **LEAD CODED** — ID: 209ce349-00ca-413f-9742-ccf6bc9ee8c2
- [ ] [The Standalone Host Writes a Log File on Every Start, and Nothing Can Turn It Off](../plans/the-standalone-host-writes-a-log-file-and-nothing-can-turn-it-off.md) — **LEAD CODED** — ID: ba9a9807-da23-4d01-a7cc-b506ab0cdf71
- [ ] [A Bulk Move Cannot Outgrow the Board](../plans/a-bulk-move-cannot-outgrow-the-board.md) — **LEAD CODED** — ID: 40fb3702-2280-4508-b918-06842c9a1f33
- [ ] [The Heap Ceiling Is Set by the Launcher, So the npx Install Never Gets It](../plans/the-heap-ceiling-is-set-by-the-launcher-so-the-npx-install-never-gets-it.md) — **LEAD CODED** — ID: 072a002b-6fc8-4aa6-98ff-1468b2c93354
<!-- END SUBTASKS -->

## Completion Summary

All six subtasks landed and verified. The host now attributes CPU per process (board, PTY host, each seat, browser) with OS-total cross-check, residual, and sampler self-cost on `/health` and the terminals panel; an out-of-loop worker-plus-gdb watchdog writes a stack dump naming a blocked loop while it is still spinning, surviving the `/health`-failing condition. Hardware capability (memory, cores, cgroup limit) is read once at startup with tagged sources, reported at dispatch without blocking, and injected as a constrained-host directive only when measured constrained — no plausible substitute on unread values. The heap ceiling is derived (310 MB from 800 MB budget − 300 MB measured non-heap − 190 MB offset) across the cli re-exec, npm shim, and Go launcher, with source logging and env override; a guarded loopback-only heap-snapshot hook and a bounded rotating drift sampler catch what the ceiling governs. The inotify watch leak in `KanbanProvider._movesFsWatchers` is fixed (array → folder-keyed Map), bulk moves cost one refresh not one-per-card, and the unconditional standalone log file is gone. Contract tests cover the watchdog dump, drift bounds, and frame-encoding parity; compile is clean (only pre-existing TS2835 import-extension errors in unmodified files).

