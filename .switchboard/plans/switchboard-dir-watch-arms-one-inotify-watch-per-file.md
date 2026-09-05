# The `.switchboard` recursive watch arms one inotify watch per file, including logs it ignores

## Goal

Scope the standalone plan watcher to the two directories whose events it actually acts on —
`.switchboard/plans/` and `.switchboard/features/` — so the kernel watch count tracks the number
of plans rather than the number of files Switchboard has ever written. On a 4 GB Pi with an
8,192 watch budget, the current design consumes it during normal operation.

### The problem

Measured on 2026-09-05 against a freshly restarted standalone host:

```
inotify watch descriptors held by the host : 3,133
files under .switchboard/                  : 3,132
directories under .switchboard/            :    15
```

One descriptor per **file**. Node's recursive `fs.watch` on Linux does not watch directories and
infer children — it registers a watch for every entry in the tree.

Of those 3,132 files, the ones the watcher acts on are the 2,244 plans and 311 features. The
remaining ~577 are ignored on arrival, and the largest ignored group is the one that grows
fastest and forever:

```
.switchboard/logs/            172 files   (one per terminal session, unbounded)
.switchboard/mission-control/ 254 files
.switchboard/dbbackup/          4 files
```

### Root cause — the watch root is `.switchboard`, the filter is `plans/` and `features/`

`planIngestionHost.ts:215-217` arms `fs.watch(watchPath, { recursive: true })` on the `.switchboard`
root:

```ts
watchFolder(folder, onEvent) {
    const switchboardDir = path.join(folder, '.switchboard');
    const watchPath = fs.existsSync(switchboardDir) ? switchboardDir : folder;
    return attachFolderWatcher(folder, watchPath, onEvent, log);
},
```

Every event it produces is then passed through `isPlanOrFeatureFile()`
(`src/standalone/planIngestionHost.ts:37-41`), which resolves the plans and features directories
and returns false for everything else. The code already knows, at arm time, exactly which two
subtrees matter — it just does not use that knowledge to choose what to watch.

This is the same defect class as the Antigravity preset plan: selectivity applied on the read
side of a watcher that was armed unbounded.

### What the fix reduces but does not eliminate

Narrowing the watch root from `.switchboard` to `plans/` + `features/` eliminates the ~577
wasted watches on `logs/`, `mission-control/`, and `dbbackup/`. The remaining ~2,555 watches
are still one-per-file under `plans/` and `features/`, because Node's recursive `fs.watch` on
Linux registers a descriptor per entry, not per directory. This is a reduction from 3,133 to
~2,555 — it removes the unbounded-growth group (`logs/`) and the static waste, but the per-file
watch model remains. On a Pi with 8,192 watches, 2,555 is 31% of the budget for one watcher.
The non-recursive fallback path (`planIngestionHost.ts:177-187`) already watches `plans/` and
`features/` separately and uses per-directory watches (tracking directory count, not file count)
— it is the more budget-efficient design for this workspace shape, but the recursive path is the
primary and the fallback only fires on platforms where recursive `fs.watch` is unsupported.

### Why this blocks a Pi specifically

Raspberry Pi OS defaults `fs.inotify.max_user_watches` to **8,192**. This workspace is at 3,133
today and every terminal session appends a log file, every plan adds a file, and nothing prunes.
A workspace with ~7,000 plan files — or one running alongside the Antigravity preset — exceeds
the budget, at which point `inotify_add_watch` returns `ENOSPC` for the whole machine and file
watching stops working with no error surfaced to the user.

There is a second cost: each watch is a kernel object (~1 KB of unswappable kernel memory on
64-bit), so 8,192 watches is ~8 MB of kernel memory that a 4 GB device does not get back.

### Resolved Assumptions

- **Does the standalone host arm the plan watcher at all?** Yes. `bootstrap.ts:1243` constructs
  `TaskViewerProvider`, whose constructor-init deferred path calls `_refreshConfiguredPlanWatcher()`
  (`TaskViewerProvider.ts:5285`), which arms the `.switchboard` plan watcher. The 3,133-descriptor
  measurement was taken against a freshly restarted standalone host, confirming arming.

## Proposed changes

1. Arm the recursive watch on `.switchboard/plans` and `.switchboard/features` rather than on
   `.switchboard`. Create them if absent — the current code already tolerates a missing root.
   This means two recursive watches instead of one, each scoped to the subtree the filter
   already names.
2. Keep `isPlanOrFeatureFile` as a guard. Narrowing the watch root is the fix; removing the
   filter would make the watcher depend on the root being right forever.
3. Exclude `logs/`, `dbbackup/`, and `mission-control/` explicitly in the non-recursive fallback
   path's `EXCLUDED_DIR_NAMES` (`planIngestionHost.ts:35`), which today lists only source-tree
   names (`.git`, `node_modules`, `dist`, `out`, `build`, `.next`, `.cache`) and would happily
   walk into the log directory on any platform that takes the fallback.
4. Log the armed watch count once at startup, so a workspace that is about to exhaust the budget
   is visible before it does.

**Both hosts.** The extension arms the equivalent watch through `hostSeams.watchFolder` /
`GlobalPlanWatcherService` over the same `.switchboard` root; narrowing one root and not the
other leaves the extension paying the full cost and hides the fix from every VS Code user. Both
composition roots (`src/extension.ts`, `src/standalone/bootstrap.ts`) are diffed by hand for the
watcher seams each wires.

## Metadata

**Complexity:** 3
**Tags:** backend, reliability, standalone, memory, watchers
**Project:** Browser Switchboard

## User Review Required

None — the approach is fully specified.

## Complexity Audit

### Routine
- Changing `watchPath` in `planIngestionHost.ts:216` from `.switchboard` to two separate
  watches on `.switchboard/plans` and `.switchboard/features`.
- Adding `logs`, `dbbackup`, `mission-control` to `EXCLUDED_DIR_NAMES` (`planIngestionHost.ts:35`).
- Adding the startup watch-count log line.

### Complex / Risky
- The recursive `fs.watch` on Linux registers one descriptor per file, not per directory.
  Narrowing the root reduces the count from 3,133 to ~2,555 but does not change the per-file
  model. On a Pi, 2,555 is still 31% of the 8,192 budget. This is a pragmatic reduction, not a
  fundamental fix for the per-file watch model.
- The fallback path (`planIngestionHost.ts:177-187`) already watches `plans/` and `features/`
  separately with per-directory watches — the more budget-efficient design. If the per-file
  count remains a Pi-scale concern after this fix, switching the primary path to the fallback's
  per-directory model is the next step (out of scope for this plan).

## Edge-Case & Dependency Audit

- **Race Conditions:** A plan file created in `.switchboard/plans/` before the watch is armed
  could be missed on startup. The existing `rescanRoot` logic (`planIngestionHost.ts:169-175`)
  handles this — it scans `plans/` and `features/` on arming.
- **Security:** No security surface — this is a watcher-budget fix.
- **Side Effects:** Eliminating the `logs/` watches removes the unbounded-growth group: every
  terminal session appends a log file, and the old design armed a watch for each one. The
  fixed design watches zero log files.
- **Dependencies & Conflicts:** The Antigravity preset subtask (separate plan) addresses a
  different watcher in the same host. Both fixes reduce the total inotify budget consumption.
  No conflict — different call sites, different watch roots.

## Dependencies

- No hard dependencies on other subtasks. The `.switchboard` watcher fix is independent of the
  Antigravity watcher fix and the shutdown fix.

## Adversarial Synthesis

Key risks: (1) narrowing the root reduces but does not eliminate the per-file watch cost —
2,555 watches is still 31% of a Pi's budget; (2) the non-recursive fallback is the more
budget-efficient design but is not the primary path on Linux; (3) the `EXCLUDED_DIR_NAMES` fix
only matters in the fallback path, which the plan is not switching to. Mitigations: this plan
is a pragmatic first step that removes the unbounded-growth group and the static waste; the
per-file model is acknowledged as a remaining concern, not claimed as solved.

## Verification Plan

1. Start the host on this workspace and assert the inotify descriptor count is within a few of
   the count of files under `plans/` + `features/` (≈2,555), not the count under `.switchboard`
   (3,132). Measure with `grep -c '^inotify' /proc/<pid>/fdinfo/<fd>`.
2. Write a new plan file and assert it is imported — narrowing must not break ingestion.
3. Write 200 files into `.switchboard/logs/` while the host runs and assert the watch count does
   not move.
4. Delete `.switchboard/features/` before start and assert the host starts and still watches
   `plans/`.
5. Force the non-recursive fallback (stub the recursive arm to throw) and assert it does not
   descend into `logs/`, `dbbackup/` or `mission-control/`.
6. Extension host: same count assertion against the extension-host process.

### Goal Invariants

- Assert the inotify descriptor count is within a few of the file count under `plans/` +
  `features/`, not under `.switchboard` — the watch root is narrowed.
- Assert writing 200 files into `.switchboard/logs/` does not move the watch count — the
  unbounded-growth group is excluded.
- Assert `EXCLUDED_DIR_NAMES` in `planIngestionHost.ts:35` contains `logs`, `dbbackup`, and
  `mission-control` — the fallback path does not descend into them.
- Assert a new plan file under `.switchboard/plans/` is imported after the fix — narrowing
  does not break ingestion.

## Recommendation

Complexity 3 → **Send to Intern**.

## Implementation Summary

Scoped directory watchers in both `src/standalone/planIngestionHost.ts` and `src/services/GlobalPlanWatcherService.ts` to `.switchboard/plans` and `.switchboard/features` rather than the parent `.switchboard` root, preventing inotify watch accumulation on unbounded log and state directories. Added `logs`, `dbbackup`, and `mission-control` to `EXCLUDED_DIR_NAMES` to protect the non-recursive fallback walk from scanning transient directories. Ensured parity between the standalone and extension hosts by maintaining identical subtree watching logic across both composition roots. Added inotify watch count logging on Linux at startup for visibility into descriptor budgets.
