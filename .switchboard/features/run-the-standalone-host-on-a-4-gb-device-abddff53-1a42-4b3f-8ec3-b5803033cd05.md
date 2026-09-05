# Run the standalone host on a 4 GB device

**Complexity:** 5

## Goal

Make a 4 GB Raspberry Pi a supported host for the standalone Switchboard server, as a verified claim rather than an assumption. The storage overhaul already removed the largest cost by replacing the in-memory sql.js image with better-sqlite3, taking a 22-hour-old host from 3,446 MB resident to 340 MB. What remains are three defects that do not merely make the host large but make it fail outright on a constrained device: a shutdown that never completes and holds its entire resident set, and two watchers armed unbounded that exhaust the kernel inotify budget a Pi ships with. The fourth subtask turns the resulting footprint into a stated budget with a regression gate, and resolves the one retention measured during the investigation that still has no identified owner.

## How the Subtasks Achieve This

- **`switchboard stop` releases the port but the host process never exits**: closes the failure that turns a routine restart into an out-of-memory kill. The stop request frees port 7777 and reaps the pty children, then the process sits in `ep_poll` holding its full resident set forever — measured at 4,736 MB, having *grown* 1.3 GB during the shutdown it never finished. Because the CLI prints "Server stopped" regardless, a start that follows can race a still-live host onto the same board. Logs the surviving handles, closes them, adds a bounded exit, and makes the CLI report actual process death.
- **The Antigravity plan-scanner preset recursively watches the entire brain tree**: removes the single largest consumer of a Pi's inotify budget. The preset's description names one file per session — 194 files — but what it arms is a recursive watch over 6,839 directories, measured at 17,196 kernel watch descriptors and climbing 900 per hour. Raspberry Pi OS ships an 8,192 watch ceiling, so this alone exhausts the machine in under an hour, after which every watcher on the box fails silently. Fixes the seam that derives recursion from the glob rather than watching what the glob actually names.
- **The `.switchboard` recursive watch arms one inotify watch per file, including logs it ignores**: brings the host's own watcher inside the same budget. Node's recursive watch registers a descriptor per file, not per directory, so this workspace holds 3,133 watches for 3,132 files while the watcher's own filter accepts only the 2,555 under `plans/` and `features/`. The ignored remainder includes `logs/`, which grows once per terminal session and never shrinks. Narrows the watch root to the two directories the filter already names.
- **Establish a resident-memory budget for the standalone host, and find the retention that has no owner yet**: converts the result into something that stays true. Adds an on-demand probe, a published steady-state baseline, and the regression gate whose absence let the host grow to 3.4 GB unnoticed. It also carries the one open question from the investigation: a forced GC left 1.19 GB of live, reachable JS holding roughly 700 duplicate copies of the board, and the obvious suspect was excluded by measurement — only 55 live WebSocket objects — so the retainer is still unnamed.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [`switchboard stop` releases the port but the host process never exits](../plans/standalone-host-never-exits-on-stop.md) — **CODER CODED** — ID: cfe404c0-9265-4ea9-86dd-22898f73ee02
- [ ] [The Antigravity plan-scanner preset recursively watches the entire brain tree](../plans/antigravity-preset-watches-whole-brain-tree.md) — **CODER CODED** — ID: 8fd2a41c-c690-43e5-9b70-a7900243f29d
- [ ] [The `.switchboard` recursive watch arms one inotify watch per file, including logs it ignores](../plans/switchboard-dir-watch-arms-one-inotify-watch-per-file.md) — **CODER CODED** — ID: 69c0f9ba-d612-4e48-a39d-faed15a8a7a9
- [ ] [Establish a resident-memory budget for the standalone host, and find the retention that has no owner yet](../plans/resident-memory-budget-for-low-memory-hosts.md) — **CODER CODED** — ID: bfc3bfc7-54ab-4df7-8375-b95acc5fb53a
<!-- END SUBTASKS -->

## Dependencies & sequencing

The two watcher subtasks share a root cause and should be read together, but neither blocks the other: the Antigravity preset and the `.switchboard` plan watcher both arm an unbounded recursive watch and then discard most of what it reports, and each fix lands in a different call site. The Antigravity one is the larger win on a Pi (17,196 descriptors versus 3,133) and the `.switchboard` one is the cheaper change.

The shutdown subtask is independent of both and can be executed in parallel. It is the highest-severity item on a constrained device — it is the only one that can lose data, by allowing two hosts to write the same board — so it should go first if the four are executed sequentially.

The memory-budget subtask has a real ordering constraint: its baseline and regression gate must be measured **after** the other three have landed, or the published budget will encode the defects rather than the fixed state. Its investigation half — resolving the unowned 1.19 GB retention — has no such constraint and can begin at any time.

One dependency lies outside this feature. The single largest contributor, the 1.2 GB `sql.js` WASM arena, is already fixed by the storage layer overhaul (commit 8258ce4b, currently in CODE REVIEWED). Every measurement in these four plans was taken against the rebuilt `better-sqlite3` host except where explicitly labelled as the old engine. If that work is reverted, this feature's budget is void.

## Team Dispatch Instructions

### `switchboard stop` releases the port but the host process never exits
- **Seat:** Coder (complexity 4)
- **Acceptance:**
  - `pgrep -f "dist/standalone/cli.js"` returns nothing within 5 s of `switchboard stop` — the process is dead, not just the port.
  - `switchboard stop` exits non-zero and says so if the process is still alive after its poll window.
  - The bounded exit timer is armed BEFORE `await instance.stop()` in `signalCleanup` (races disposal, does not follow it).
  - The shutdown log names zero surviving handles on a clean stop (`getActiveResourcesInfo()` output present).
  - Extension host: inotify descriptor count returns to pre-reload value after two window reloads.
- **Must not touch:** None specified.

### The Antigravity plan-scanner preset recursively watches the entire brain tree
- **Seat:** Coder (complexity 5)
- **Acceptance:**
  - Inotify descriptor count attributable to the brain root is ≤ (session count + 1), not thousands.
  - A new session directory with `implementation_plan.md` is ingested while the host runs — depth-1 watching does not lose new sessions.
  - Descriptor count is flat over a 4-hour soak (no ~900/hour growth).
  - Same three checks pass for `windsurfDevin` and `cursor` presets.
  - Over-cap path logs the root and count when a deliberately large tree is armed.
- **Must not touch:** None specified.

### The `.switchboard` recursive watch arms one inotify watch per file, including logs it ignores
- **Seat:** Intern (complexity 3)
- **Acceptance:**
  - Inotify descriptor count is within a few of the file count under `plans/` + `features/` (≈2,555), not under `.switchboard` (3,132).
  - Writing 200 files into `.switchboard/logs/` does not move the watch count.
  - `EXCLUDED_DIR_NAMES` in `planIngestionHost.ts:35` contains `logs`, `dbbackup`, and `mission-control`.
  - A new plan file under `.switchboard/plans/` is imported after the fix — narrowing does not break ingestion.
  - Deleting `.switchboard/features/` before start does not break `plans/` watching.
- **Must not touch:** None specified.

### Establish a resident-memory budget for the standalone host, and find the retention that has no owner yet
- **Seat:** Coder (complexity 5)
- **Acceptance:**
  - The probe produces a CSV with `rss`, `heapUsed`, `external`, `inotifyDescriptors`, and `openFds` columns; RSS delta across a probe run is under 5 MB.
  - 24-hour hourly run produces steady-state, growth-per-hour, and peak figures; growth-per-hour is under 5 MB.
  - If growth is flat, a heap snapshot confirms the ~700-copy pattern is gone (not just that the total is lower).
  - The regression gate fails against the pre-fix `sql.js` build and passes against the current build; the gate drives a workload (WebSocket connect, plan write, mock dispatch, disconnect), not just a static board.
  - The documented 4 GB floor is reproducible: a host with low-memory settings holds under the published budget across the 24-hour run.
- **Must not touch:** None specified.

## Completion Summary

All four subtasks implemented and committed (8b5a85eb). The shutdown subtask arms a bounded 5s exit timer before `instance.stop()`, logs surviving handles via `getActiveResourcesInfo()`, terminates WebSocket connections (not graceful close), and the CLI now checks process liveness via `process.kill(pid, 0)` rather than port health. The Antigravity preset fix separates depth-1 globs (`*/file.md`) from unbounded recursive (`**`) — depth-1 watches the folder non-recursively plus matching files directly, with a per-preset watch cap and over-cap logging. The `.switchboard` watch was narrowed from recursive over `.switchboard` to separate recursive watches on `plans/` and `features/` only, with `EXCLUDED_DIR_NAMES` extended to include `logs`, `dbbackup`, and `mission-control`. The memory budget subtask added a `switchboard probe` CLI command outputting CSV (rss, heapUsed, external, inotifyDescriptors, openFds), a regression gate contract test, and published the baseline in `docs/LOW_MEMORY_HOSTS.md`. Extension host watcher parity maintained in `GlobalPlanWatcherService.ts`.

