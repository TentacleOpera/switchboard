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
- [ ] [`switchboard stop` releases the port but the host process never exits](../plans/standalone-host-never-exits-on-stop.md) — **CREATED** — ID: cfe404c0-9265-4ea9-86dd-22898f73ee02
- [ ] [The Antigravity plan-scanner preset recursively watches the entire brain tree](../plans/antigravity-preset-watches-whole-brain-tree.md) — **CREATED** — ID: 8fd2a41c-c690-43e5-9b70-a7900243f29d
- [ ] [The `.switchboard` recursive watch arms one inotify watch per file, including logs it ignores](../plans/switchboard-dir-watch-arms-one-inotify-watch-per-file.md) — **CREATED** — ID: 69c0f9ba-d612-4e48-a39d-faed15a8a7a9
- [ ] [Establish a resident-memory budget for the standalone host, and find the retention that has no owner yet](../plans/resident-memory-budget-for-low-memory-hosts.md) — **CREATED** — ID: bfc3bfc7-54ab-4df7-8375-b95acc5fb53a
<!-- END SUBTASKS -->

## Dependencies & sequencing

The two watcher subtasks share a root cause and should be read together, but neither blocks the other: the Antigravity preset and the `.switchboard` plan watcher both arm an unbounded recursive watch and then discard most of what it reports, and each fix lands in a different call site. The Antigravity one is the larger win on a Pi (17,196 descriptors versus 3,133) and the `.switchboard` one is the cheaper change.

The shutdown subtask is independent of both and can be executed in parallel. It is the highest-severity item on a constrained device — it is the only one that can lose data, by allowing two hosts to write the same board — so it should go first if the four are executed sequentially.

The memory-budget subtask has a real ordering constraint: its baseline and regression gate must be measured **after** the other three have landed, or the published budget will encode the defects rather than the fixed state. Its investigation half — resolving the unowned 1.19 GB retention — has no such constraint and can begin at any time.

One dependency lies outside this feature. The single largest contributor, the 1.2 GB `sql.js` WASM arena, is already fixed by the storage layer overhaul (commit 8258ce4b, currently in CODE REVIEWED). Every measurement in these four plans was taken against the rebuilt `better-sqlite3` host except where explicitly labelled as the old engine. If that work is reverted, this feature's budget is void.

