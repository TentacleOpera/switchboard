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

`planIngestionHost.ts:91` arms `fs.watch(watchPath, { recursive: true })` on the `.switchboard`
root. Every event it produces is then passed through `isPlanOrFeatureFile()`
(`src/standalone/planIngestionHost.ts:37-41`), which resolves the plans and features directories
and returns false for everything else. The code already knows, at arm time, exactly which two
subtrees matter — it just does not use that knowledge to choose what to watch.

This is the same defect class as the Antigravity preset plan: selectivity applied on the read
side of a watcher that was armed unbounded.

### Why this blocks a Pi specifically

Raspberry Pi OS defaults `fs.inotify.max_user_watches` to **8,192**. This workspace is at 3,133
today and every terminal session appends a log file, every plan adds a file, and nothing prunes.
A workspace with ~7,000 plan files — or one running alongside the Antigravity preset — exceeds
the budget, at which point `inotify_add_watch` returns `ENOSPC` for the whole machine and file
watching stops working with no error surfaced to the user.

There is a second cost: each watch is a kernel object (~1 KB of unswappable kernel memory on
64-bit), so 8,192 watches is ~8 MB of kernel memory that a 4 GB device does not get back.

## Proposed changes

1. Arm the recursive watch on `.switchboard/plans` and `.switchboard/features` rather than on
   `.switchboard`. Create them if absent — the current code already tolerates a missing root.
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

## User Review Required

None — the approach is fully specified.

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
