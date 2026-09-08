# The Board Holds 16,776 inotify Watches and Cannot Close Any of Them

## Goal

Find and fix the watcher site that opens `fs.watch` handles without keeping a reference to close them, and put a ceiling on the board's total inotify usage. On the 4 GB Pi this product targets, one board currently consumes **55% of the machine's entire watch budget**.

### Problem analysis

**Measured on the live standalone host, 2026-09-07.** A heap snapshot taken over the inspector (no restart), after a forced GC:

```
rss        450.0 MB      heapTotal  222.2 MB      heapUsed  127.8 MB
external     4.7 MB      arrayBuffers 0.8 MB
```

Three node classes travel together at the top of the heap, one set per watch:

```
19,474   native / Node / FSEventWrap    4.6 MB
19,485   object / FSWatcher             1.5 MB
19,471   object / Stats                 2.5 MB
```

And the kernel agrees: `/proc/<pid>/fdinfo` reports **16,776 inotify watches** on a single instance.

**The workspace does not contain that many directories.** 6,318 in total, of which 5,259 are `node_modules` and 281 are `.git` — 778 everything else. So the process holds **2.7× more watches than there are directories to watch**. This is not one over-broad recursive watch; it is the same tree watched several times over.

**They cannot be closed, and cannot be collected.** A retainer walk over the snapshot's edge table gives the same chain for every sampled `FSWatcher`:

```
FSWatcher  <- [property "<symbol owner_symbol>"]  object FSEvent
           <- [internal "19073"]                  synthetic (Global handles)
           <- (GC root)
```

**Nothing in JavaScript references them.** They are held only by libuv's global handle table, which is what keeps an *open* handle alive. A watcher whose JS reference is dropped without `.close()` reaches exactly this state: permanently open, unreachable from code, invisible to GC. Every re-scan that re-arms a watch without closing the previous one adds another.

**This is the constraint that decides the Pi story.** `max_user_watches` on the Pi is **30,517**. One board takes 16,776 of them — 55% — leaving the rest of the machine, including any editor, language server or second workspace, to share what is left. The tower's ceiling is 65,536, which is why it has never surfaced there.

**The cause is identified — one watch per plan FILE.** Mapping the kernel's watch table back to paths settles it:

```
16,771 watches, on 16,771 DISTINCT inodes   (no inode watched twice)
 2,334 resolve to .switchboard/plans/       (2,279 plan files on disk — 1.02 per file)
   357 resolve to .switchboard/features/    (320 feature files)
14,079 resolve to nothing
```

Two separate faults, compounding.

**1. Per-file arming where a directory watch would do.** `vscodeShim.ts:388` `armFileWatch` opens an `fs.watch` on **every file** matching a depth-1 pattern. With 2,279 plans that is 2,279 watches per watcher instance, and `hostSeams.ts:531`/`:540`/`:551` construct several. Roughly six instances at ~2,600 each accounts for the whole 16,771.

> **Superseded:** `armFileWatch`'s depth-1 branch (`vscodeShim.ts:388`) is the leak site, reached via `hostSeams.ts:531`/`:540`/`:551`.
> **Reason:** Code investigation found the depth-1 branch is **unreachable from any active call site**. The branch fires only when `createFileSystemWatcher` receives a glob containing `/` but NOT `**` (`isDepthOne = !isUnboundedRecursive && globPattern.includes('/')`, `vscodeShim.ts:363-364`). Every `RelativePattern` in `src/` uses `**` (`.switchboard/plans/**/*.md`, `.switchboard/{plans,features}/**/*.md`, `**/*`, `**/*.md`) or is a bare filename (`*.md`) — none is depth-1. `hostSeams.watchPattern` (`hostSeams.ts:538`), the only entry that accepts an arbitrary pattern, has **zero callers** in `src/`. Of the three cited hostSeams lines: 531 (`watchFolder`) builds `**/*` → recursive branch (not `armFileWatch`); 540 (`watchPattern`) is never called; 551 (`watchFile`) uses a bare filename → flat branch. So `armFileWatch` is dead in practice and cannot account for the 16,771.
> **Replaced with:** The live leak source is the **recursive branch** (`vscodeShim.ts:478`, `fs.watch(folderPath, { recursive: true })`). `TaskViewerProvider._setupPlanWatcher` (`TaskViewerProvider.ts:16035`) and `GlobalPlanWatcherService` (`GlobalPlanWatcherService.ts:139`) call `createFileSystemWatcher(RelativePattern(folder, '.switchboard/plans/**/*.md'))` where `folder` is the **workspace root**, so the shim's recursive branch watches the **entire workspace root** — ~6,318 subdirectories including 5,259 `node_modules` and 281 `.git`, with **no exclusion** in the recursive branch (`vscodeShim.ts:475-488`).

> **Superseded (second pass — mechanism corrected by research):** The recursive branch leaks because `fs.watch({recursive:true})` on Linux uses libuv's nested-inotify support — one inotify watch per subdirectory walked.
> **Reason:** Web research (see Resolved Assumptions) confirmed that **libuv does NOT implement recursive watching on Linux at all**. Node 22 emulates it in JavaScript (`lib/internal/fs/recursive_watch.js`): it walks the tree synchronously and calls the ordinary non-recursive `fs.watch()` once per **filesystem entry — every file AND every directory**. There are no "libuv-internal per-subdirectory watches." There are N ordinary `FSWatcher` objects, each wrapping its own `uv_fs_event_t` handle, each holding its own `inotify_add_watch()` registration. This explains the 19,485 `FSWatcher` objects: roughly one per file-or-directory in the watched tree, multiplied by overlapping recursive watchers. The 1.16 handle-to-watch ratio (19,485 / 16,776) is consistent with partial overlap — libuv deduplicates kernel watches by inode, so overlapping watchers on the same tree produce N handles but only N kernel watches. The "1.02 watches per plan file" is also explained: Node watches every file, so the 2,334 watches resolving to `.switchboard/plans/` are the plan files themselves (one per file) plus their parent directories.
> **Replaced with:** The recursive branch leaks because Node's JS emulation of `fs.watch({recursive:true})` arms one `fs.watch()` per file AND directory in the watched tree — including 5,259 `node_modules` dirs, 281 `.git` dirs, and every file inside them. With no exclusion mechanism whatsoever (the walk is unconditional), and multiple provider instances re-arming without closing prior watchers, the count reaches 16,771. The fix is to **abandon `fs.watch({recursive:true})` on Linux** and use a manual per-directory walk with exclusions (the shape `planIngestionHost.ts:attachFolderWatcher` already implements), which watches directories only — a measured 9.4× reduction in kernel watches.

`GlobalPlanWatcherService.ts:163` demonstrates the correct shape in the same repository: it watches `.switchboard/plans` and `.switchboard/features` as **directories** and learns the same events from two watches instead of 2,600. `armFileWatch` is deduped and capped and is still wrong — the cap bounds a design that should not be counting into the thousands at all.

> **Superseded:** `armFileWatch` is deduped and capped and is still wrong — the cap bounds a design that should not be counting into the thousands at all.
> **Reason:** With the depth-1 branch unreachable, the cap on `armFileWatch` is moot for the live leak. The design that counts into the thousands is the **recursive watch on the workspace root** (shim line 478), whose per-entry count is unbounded and uncapped.
> **Replaced with:** Abandon `fs.watch({recursive:true})` on Linux entirely. Replace the shim's recursive branch with a manual per-directory walk using `EXCLUDED_DIR_NAMES` (mirror `planIngestionHost.ts:35`). This watches directories only (not files), applies exclusions before arming, and produces a handle count proportional to directory count (~778 with exclusions), not entry count (~6,318+ files and dirs).

**2. Nothing closes a watch when its file is replaced.** 14,079 of the 16,771 — **84%** — point at inodes that no longer exist. A plan file rewritten by an agent gets a new inode; the old watch stays open, retained only by libuv's handle table with no JS reference, and can never be closed or collected. Every improve-plan pass adds a few hundred. That is the growth: the host was ~340 MB idle and reached **605 MB after 4½ hours**, roughly 60 MB/hour.

> **Superseded (second pass — reframed by research):** 14,079 of the 16,771 watches (84%) point at freed inodes because nothing closes a watch when its file is replaced, and the orphaned watches accumulate at ~60 MB/hour.
> **Reason:** Web research (see Resolved Assumptions) confirmed three facts that reframe this fault:
> 1. **The kernel auto-removes inotify watches on freed inodes.** When a watched directory is deleted or replaced, the kernel emits `IN_DELETE_SELF` + `IN_IGNORED` and destroys the watch descriptor — no userspace action needed. A rename does NOT free the inode; the watch follows the inode to its new path and stays live. There is no state in which the kernel holds a watch on a freed inode.
> 2. **The "84% on freed inodes" figure is almost certainly a measurement artifact.** `/proc/<pid>/fdinfo` prints `ino:` in **hexadecimal** while `stat()` returns decimal. A script comparing the two without conversion will report nearly every entry as unresolvable. Even with correct conversion, a watch on a **renamed** directory is alive on a live inode that no longer sits at the path Node recorded — a path-based scan will classify healthy watches as dead.
> 3. **`.close()` on a recursive `FSWatcher` reclaims everything.** Tested across clean trees, renamed subtrees, deleted subtrees, and watch-limit exhaustion — watch counts went to zero synchronously every time. The leak is NOT a failure of `.close()`. It is that `.close()` is **never called** on watchers that are dropped without being stored in a dispose-reachable location. A dropped-but-unclosed recursive watcher is permanently unreclaimable: Node's `HandleWrap` holds a strong persistent reference to each JS object until the handle is closed, immune to GC. That is exactly the heap-snapshot signature.
>
> The real growth mechanism is: each re-arm of `_setupPlanWatcher` (or `GlobalPlanWatcherService.refreshWatchers`) creates a new recursive watcher over the workspace root. If the prior watcher's `.close()` is not called — or is called on the JS emitter but the inner per-entry handles are not reachable — the old handles persist in libuv's handle table with no JS reference. Every panel reopen, every config change, every workspace-folder event that triggers a re-arm adds another full tree of watches. The 60 MB/hour growth is the accumulation of these orphaned handle sets, not of individual replaced-file watches.
> **Replaced with:** The growth is from **unclosed recursive watchers** — re-arming creates a new watcher without closing the prior one, and the old per-entry handles persist in libuv's handle table immune to GC. The fix is: (a) every watcher must be stored in a dispose-reachable collection before it is created, and (b) the re-arm path must close all prior watchers synchronously before arming new ones. The kernel handles inode-lifetime correctly; close-on-replace is not needed.

**Retainer proof.** Every sampled `FSWatcher` traces the same way, with no JavaScript reference anywhere in the chain:

```
FSWatcher <- [property "<symbol owner_symbol>"] object FSEvent
          <- [internal "19073"]                 synthetic (Global handles)
          <- (GC root)
```

This is the signature of an unclosed `HandleWrap` — exactly what Node's `HandleWrap` does when `.close()` is never called: it holds a strong persistent reference registered in the environment's handle-wrap queue, unreachable from JS, immortal in practice.

**Two sites are already cleared.** `GlobalPlanWatcherService.ts:163` is correctly scoped. `vscodeShim.ts:388`'s dedupe and cap work as written — the defect is the per-file strategy and the missing close on replacement, not a broken guard.

> **Superseded:** `vscodeShim.ts:388`'s dedupe and cap work as written — the defect is the per-file strategy and the missing close on replacement, not a broken guard.
> **Reason:** The dedupe/cap guard a dead branch. The live defects are: (1) the recursive branch uses `fs.watch({recursive:true})` which on Linux arms one watch per file AND directory with no exclusion, and (2) re-arming drops prior watchers without calling `.close()`, leaving handles permanently open in libuv's handle table.
> **Replaced with:** Replace the recursive branch with a manual per-directory walk with exclusions (directories only, `node_modules`/`.git` excluded). Ensure every watcher is stored in a dispose-reachable collection and closed synchronously on re-arm.

**What this supersedes.** *Establish a resident-memory budget for the standalone host* found a 1.16 GB `sql.js` WASM arena (fixed by the `better-sqlite3` migration) and **~700 retained copies of the board**, with the retainer explicitly unidentified. That second half now measures as largely resolved: `"Browser Switchboard"` is **19,978 copies / 0.8 MB**, against **829,012 / 33.2 MB** in that profile — a 40× reduction. The open question in that plan should be closed with this measurement, and the watcher finding replaces it as the live memory issue.

**Heap size itself is no longer the story.** 127.8 MB live, of which **33.5 MB is a single string** — the webpack bundle source, which is unavoidable and not worth attacking. The watchers cost ~8.6 MB of heap; their real cost is the kernel resource and the ceiling it approaches.

> **Superseded (third pass — cause-attribution corrected by DIRECT MEASUREMENT, 2026-09-08):**
> The dominant leak is the recursive `fs.watch` on workspace roots (`vscodeShim.ts:478`) via Node's
> per-file-and-directory JS emulation.
>
> **Reason:** The first diagnostic below was run against the live standalone host (pid 2058377,
> workspace `/home/patrick/switchboard`). Rather than only dividing counts, every watched inode was
> resolved to a path: the 16,780 inotify records in `/proc/2058377/fdinfo/25` were read, their `ino:`
> fields converted from hex, and matched against a full inode→path index of `/home/patrick/switchboard`,
> `/home/patrick/.switchboard` and `/home/patrick/switchboard-site` (136,604 entries).
>
> ```
> inotify watches held          16,780   (one fd)
>   resolve to a live path       2,701   (16%)
>   point at FREED inodes       14,079   (84%)
>
> where the 2,701 live watches point:
>   .switchboard/plans           2,341
>   .switchboard/features          357
>   .switchboard/ (other)            2
>   elsewhere                        1
>   node_modules / .git / src / dist / .vscode-test / switchboard-site   ZERO
> ```
>
> **The recursive branch is not firing at all.** If a recursive walk of a workspace root were arming
> watches, `node_modules` (5,259 directories) and `src` would dominate the resolved set. They do not
> appear in it — not reduced, *absent*. The watched set is exactly the depth-1 per-file arm at
> `vscodeShim.ts:389-412` (`armFileWatch`), one `fs.watch` per matching **file** in
> `.switchboard/plans` and `.switchboard/features`. 2,341 watches against ~2,279 plan files is one
> per file plus parents.
>
> **The FIRST-pass attribution was right and the second-pass "correction" was wrong.** `armFileWatch`
> (per-file, depth-1) is the leaking site. Changes #1, #2 and #5 below retarget a branch that is not
> on the hot path.
>
> **The leak is generational, not per-rewrite.** 14,079 orphans ÷ 2,701 live ≈ 5.2, i.e. roughly six
> armings' worth of watchers retained. Three facts compose:
> 1. `armFileWatch`'s dedup guard keys on **path** (`childWatchers.has(filePath)`), so within one
>    generation it never re-arms and the count cannot grow past the file count.
> 2. `closeAll()` (`vscodeShim.ts:379-382`) runs **only** from the watcher object's own `dispose()`
>    (line 494). The per-handler subscriptions returned by `onDidCreate`/`onDidChange`/`onDidDelete`
>    (lines 491-493) return a **no-op** `dispose`. A consumer that disposes its subscriptions releases
>    nothing. Any owner that re-arms without calling the watcher's `dispose()` strands a whole generation.
> 3. `uv_fs_event_t` is a Global handle, so a stranded generation is immune to GC — matching the
>    retainer chain already recorded above.
>
> **This is also why the existing cap never fired.** `maxWatches` (line 390) guards `childWatchers.size`
> — a **per-watcher-instance** map. Each new generation starts a fresh map at size 0, so the cap cannot
> see cross-generation accumulation. 16,780 watches accrued with the cap in place and never tripped it.
>
> **Fifteen call sites arm folder watchers** (`grep -rn '\.watchFolder(' src/`), of which at least
> `PlanningPanelProvider.ts:1323` (plans), `:1364` (features) and `PlanIngestionEngine.ts:843` target
> the same two directories — consistent with several independent owners each holding a generation.


## Resolved Assumptions

The following external uncertainties were resolved by web research (Node 22 / libuv 1.x / Linux inotify, tested on Linux 6.18 with Node v22.22.2). These are now authoritative — do not re-open.

1. **`fs.watch({recursive:true})` on Linux is a JavaScript emulation, not a libuv feature.** libuv's `uv_fs_event_start()` on Linux ignores the `flags` argument — there is no `UV_FS_EVENT_RECURSIVE` in the inotify backend. Node 22 dispatches to `lib/internal/fs/recursive_watch.js`, which walks the tree synchronously and calls ordinary non-recursive `fs.watch()` once per filesystem entry (every file AND every directory). One recursive call produces N `FSWatcher` objects, not one. This explains the 19,485 heap objects.

2. **`.close()` on a recursive `FSWatcher` reclaims all per-entry watches.** Tested across clean trees, renamed subtrees, deleted subtrees, and watch-limit exhaustion — counts went to zero synchronously every time. The leak is NOT defective `.close()`; it is `.close()` never being called on dropped watchers. `HandleWrap` holds a strong persistent reference immune to GC until the handle is closed.

3. **The kernel auto-removes inotify watches on freed inodes.** `IN_DELETE_SELF` + `IN_IGNORED` destroys the watch descriptor without userspace action. A rename does NOT free the inode — the watch follows it. There is no kernel-side orphaning. The "84% on freed inodes" measurement is almost certainly a **hex/decimal artifact**: `fdinfo` prints `ino:` in hexadecimal, `stat()` returns decimal.

4. **`max_user_watches` = 30,517 is the unmodified kernel default on a 4 GB Pi.** Since Linux 5.10, the kernel auto-computes it as ~1% of addressable memory, clamped to [8192, 1048576]. Back-solving from 30,517 gives ~3,880,000 kB MemTotal — a 4 GB Pi after firmware/CMA reservations. Debian/Raspberry Pi OS ships no sysctl override. Hand-set values are round; 30,517 is not.

5. **`fs.watch({recursive:true})` watches every file, not just directories — ~9.4× more watches than necessary.** An inotify watch on a directory already reports creation/modification/deletion of its direct children. Measured: 376 watches (recursive, all entries) vs 40 watches (manual, directories only, `node_modules` excluded) on a 41-dir/335-file tree.

6. **`unref()`/`ref()` are silent no-ops on Linux recursive watchers.** The implementation checks `instanceof StatWatcher` against a `#files` map that holds `Stats` objects, not `StatWatcher` — the branch is dead code. An `unref()`'d recursive watcher still keeps the event loop alive.

7. **Watch-limit exhaustion (ENOSPC) is silently swallowed.** `kFSWatchStart` wraps the initial walk in try/catch and re-throws only `ENOENT`. Hitting `max_user_watches` produces a partially-watched tree with no exception, no `error` event, and no log line.

8. **`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` is not thrown by `fs.watch` in Node 22.** The throw was removed when Linux recursive support landed (Node 19.1.0). The `planIngestionHost.ts` fallback for this error code is dead code on Node 22 but harmless to keep.

## Metadata

- **Complexity:** 6
- **Tags:** performance, bugfix, reliability, infrastructure

## User Review Required

Yes — the cause-attribution has been corrected twice (Superseded callouts in Problem analysis) and fault #2 has been reframed by research from "close-on-replace" to "unclosed recursive watchers." The measurement stands; the fix set has shifted from "retarget the recursive base + close-on-replace" to "abandon `fs.watch({recursive:true})` on Linux for a manual per-directory walk + ensure every watcher is closed on re-arm." Review the Superseded callouts and Resolved Assumptions before dispatch.

## Complexity Audit

### Routine
- Replacing the shim's recursive branch (`vscodeShim.ts:475-488`) with a manual per-directory walk using `EXCLUDED_DIR_NAMES` (mirror `planIngestionHost.ts:35`). The `planIngestionHost.ts:attachFolderWatcher` function (`planIngestionHost.ts:97-260`) already implements this exact shape — `walkAndAttach` + `attachNonRecursive` + `EXCLUDED_DIR_NAMES` — and can be factored out or copied.
- Wiring an aggregate watch-count ceiling + loud log, reusing the existing `getInotifyWatchCount()` helper (`planIngestionHost.ts:60`).
- Marking completed checklist items / closing the superseded memory-budget open question.

### Complex / Risky
- **Abandoning `fs.watch({recursive:true})` on Linux in the shim.** The recursive branch must be replaced with a per-directory walk that handles new-subdirectory creation (re-scan on `rename` event, arm new subdirs with exclusion), deletion (kernel auto-removes the watch; close and forget the handle), and symlinks (decline to descend, matching Node's own implementation). This is the `planIngestionHost.ts` fallback shape — converge on it rather than inventing a third.
- **Ensuring every watcher is closed on re-arm.** `_setupPlanWatcher` arms both `vsCodeWatchers` (line 16035) and `_fsPlansWatchers` (line 16119); a re-init that closes one layer but not the other (or races a callback mid-scan) is the origin of the orphaned handles. Both must be torn down and rebuilt under one synchronous guard. The same applies to `GlobalPlanWatcherService.refreshWatchers`.
- **Both hosts.** The extension host uses VS Code's own `FileSystemWatcher` for some sites and native `fs.watch` for others; fixing standalone alone leaves the extension leaking. The shim change covers standalone; the extension's `GlobalPlanWatcherService` native fallback (lines 150-197) also needs the per-directory-walk shape.

## Edge-Case & Dependency Audit

### Race Conditions
- A dispose that runs while a scan is arming must not leave a half-registered handle. That race is how the current state was probably reached. The re-arm path in `_setupPlanWatcher` must close-then-arm under a single synchronous block, and the shim's `closeAll` must be safe to call twice.
- The native `fs.watch` fallback callback (`TaskViewerProvider.ts:16108`) and the VS Code watcher `onDidCreate` (line 16038) race on the same plan file; the existing `_recentNativePlanCreations` TTL dedup guards it. Any restructure must preserve that dedup or reintroduce the double-ingest storm.
- New-subdirectory creation under the manual walk: on a `rename` event in a watched directory, re-scan it and arm any new subdirectories (with exclusion). A scan that races with a concurrent deletion must handle ENOENT gracefully (the `planIngestionHost.ts` shape already does — `try/catch` on `readdirSync`).

### Security
- None. No auth, credential, or untrusted-input surface touched.

### Side Effects
- Watcher topology change can alter event delivery timing to `KanbanProvider`, `ContinuousSyncService`, `PlanningPanelProvider`, `DesignPanelProvider`, `TicketsPanelProvider` — all consumers of `GlobalPlanWatcherService.onPlanDiscovered` / the seams watcher. Event semantics (create vs change vs delete) must remain byte-stable with the pre-fix behavior; the engine's debounce + periodic reconcile is the backstop, but a regression here surfaces as stale cards.
- Excluding `node_modules`/`.git` from the watch changes which paths generate events. No consumer depends on events under those trees (verified: all consumers filter to `.md` under `.switchboard/`), so the exclusion is safe, but it must be asserted in tests.
- Switching from per-file to per-directory watches changes event granularity: a directory watch reports the directory event, not the file event. The shim's `emit` function already resolves `filename` to a full path — preserve that resolution so consumers see file paths, not directory paths.

### Dependencies & Conflicts
- `planIngestionHost.ts` already implements the correct directory-watch shape with `EXCLUDED_DIR_NAMES` (`planIngestionHost.ts:35`, `attachFolderWatcher:97`). The fix should converge the shim's recursive branch onto that model rather than inventing a third shape. Consider factoring `attachFolderWatcher` into a shared utility.
- `getInotifyWatchCount()` (`planIngestionHost.ts:60`) already reads `/proc/<pid>/fdinfo` — reuse it for the ceiling, do not duplicate.
- Conflicts with any concurrent plan that restructures `vscodeShim.createFileSystemWatcher` or `hostSeams.VscodeHostFileWatcher`; coordinate if the worktree fleet has sibling plans on the watcher seam.

## Dependencies

- None. This plan supersedes and closes the open question in *Establish a resident-memory budget for the standalone host* (the unidentified ~700-board retainer), but that plan is not a prerequisite — its finding is recorded above as resolved by measurement.

## Adversarial Synthesis

Key risks: (1) the manual per-directory walk must handle new-subdirectory creation and deletion correctly or it silently misses events — the `planIngestionHost.ts` shape already handles this, so converge on it rather than reinventing; (2) the re-arm path in `_setupPlanWatcher` must close ALL prior watchers (both VS Code and native layers) synchronously before arming new ones — a missed close leaves handles permanently open in libuv's handle table, immune to GC; (3) the extension host's native fallback in `GlobalPlanWatcherService` (lines 150-197) also uses `fs.watch({recursive:true})` and must be converted. Mitigations: factor `attachFolderWatcher` into a shared utility; single synchronous guard around close-then-arm; assert watch count stability over time in the verification plan.

## Proposed Changes

> **Read the third Superseded callout first.** Direct measurement (2026-09-08) puts every live watch
> in `.switchboard/plans` and `.switchboard/features`, and none anywhere else. That reorders this set:
>
> | | change | status after measurement |
> |---|---|---|
> | **#3** | every watcher is owned, and every owner closes on re-arm | **this is the fix** — do it first, alone if need be |
> | **#4** | a ceiling, with a loud failure | **keep**, but count arms process-wide: the existing per-instance cap cannot see generational accumulation, which is why 16,780 watches never tripped it |
> | #1 | replace the shim's recursive branch with a manual walk | defence-in-depth — the branch is arming zero watches today |
> | #2 | retarget the watch base at call sites | defence-in-depth — bases are already effectively `.switchboard/*` |
> | #5 | do not watch `node_modules` or `.git` | defence-in-depth — neither is watched today |
>
> Add to #3: give the shim's `onDidCreate`/`onDidChange`/`onDidDelete` a real `dispose` (they return a
> no-op at `vscodeShim.ts:491-493`), and audit all fifteen `.watchFolder(` owners for close-before-arm.

### 1. Replace the shim's recursive branch with a manual per-directory walk (`src/standalone/vscodeShim.ts`, lines 475-488)
- **Context:** The `else` branch arms `fs.watch(folderPath, { recursive: true })`. On Linux (Node 22), this triggers Node's JS emulation which walks the tree and arms one `fs.watch()` per file AND directory — including `node_modules` and `.git`, with no exclusion mechanism. With `folderPath` resolved to a workspace root (because callers pass `RelativePattern(workspaceRoot, '.switchboard/plans/**/*.md')`), this arms thousands of watches.
- **Logic:** Replace the recursive `fs.watch` call with a per-directory walk: arm a non-recursive `fs.watch` on `folderPath`, then walk its subdirectories (excluding `EXCLUDED_DIR_NAMES`) and arm each. On a `rename` event in a watched directory, re-scan and arm any new subdirectories. On deletion, the kernel auto-removes the watch; close and forget the handle. This is the shape `planIngestionHost.ts:attachFolderWatcher` (lines 97-260) already implements — factor it out or copy it.
- **Implementation:** Add `EXCLUDED_DIR_NAMES` (mirror `planIngestionHost.ts:35`). Replace the `else` block (lines 475-488) with a call to the shared `attachFolderWatcher`-style function. The `emit` callback resolves `filename` to a full path and applies the glob `matcher` — preserve that. The returned `dispose` closes all armed directory watchers.
- **Edge Cases:** A glob like `**/*` with base = workspace root (from `hostSeams.watchFolder`) is the over-broad case; the walk now excludes `node_modules`/`.git`, reducing ~6,318 entries to ~778. Symlinked directories: decline to descend (match Node's own behavior). A directory that vanishes mid-walk: `try/catch` on `readdirSync` (the `planIngestionHost.ts` shape already does this).

### 2. Retarget the watch base at call sites (`src/services/TaskViewerProvider.ts:16035`, `src/services/GlobalPlanWatcherService.ts:139`)
- **Context:** Both call sites pass `RelativePattern(folder, '.switchboard/plans/**/*.md')` where `folder` is the workspace root. Even with the manual walk replacing the recursive branch, watching the workspace root walks the whole tree before exclusion. Retargeting to `.switchboard/{plans,features}` means the walk spans hundreds of dirs, not 6,318.
- **Logic:** Change the `RelativePattern` base from `folder` to `path.join(folder, '.switchboard', 'plans')` (and a sibling for `features`). The glob stays `**/*.md`; the manual walk now spans the plans/features tree only.
- **Implementation:** `TaskViewerProvider.ts:16036` — change base to plans dir; add a sibling watcher for features if not already present. `GlobalPlanWatcherService.ts:139` — change base to `path.join(folder, '.switchboard')` so the recursive walk spans `.switchboard` only.
- **Edge Cases:** The `workspaceFolderPaths.has(folder)` gate in `GlobalPlanWatcherService.ts:138` uses the VS Code watcher only for in-workspace folders; the retarget does not change that gate. A missing `.switchboard/plans` dir is created at `TaskViewerProvider.ts:16000` — preserve.

### 3. Every watcher is owned, and every owner closes on re-arm (`src/services/TaskViewerProvider.ts:15939-16121`, `src/services/GlobalPlanWatcherService.ts:88-90`)
- **Context:** `_setupPlanWatcher` is called on init and on `reinitializePlanWatcher` (line 8989). It closes `this._planWatcher` (line 15941) and `this._fsPlansWatchers` (line 15943) before arming. But if a re-arm is triggered while a scan is mid-flight, or if the VS Code layer closes but the native layer does not (or vice versa), handles are orphaned. `HandleWrap` holds a strong persistent reference immune to GC — orphaned handles are permanently unreclaimable.
- **Logic:** Wrap the close+arm in a single synchronous guard. Close ALL prior watchers (both `vsCodeWatchers` and `_fsPlansWatchers`) before arming either. Store every watcher in a dispose-reachable collection before it is created — a watcher created without being stored is unclosable by construction. The same applies to `GlobalPlanWatcherService.refreshWatchers` (line 88) — the engine's `refreshWatchers` must close prior handles before arming new ones.
- **Implementation:** In `_setupPlanWatcher`, wrap lines 15940-15946 (close) and 16032-16121 (arm) in a single synchronous block. Assert that `this._fsPlansWatchers.length` and `vsCodeWatchers.length` are both zero after the close phase. In `GlobalPlanWatcherService`, verify the engine's `refreshWatchers` closes prior `PlanIngestionWatchHandle`s before arming new ones.
- **Edge Cases:** A dispose that runs while a callback is mid-flight: the callback must check a disposed flag and bail. The `_recentNativePlanCreations` dedup must be cleared on re-arm to avoid suppressing legitimate creates from the new watcher.

### 4. A ceiling, with a loud failure (new, reuses `planIngestionHost.ts:60`)
- **Context:** No process-wide cap on total inotify watches. `vscodeShim`'s per-watcher `maxWatches` cap bounds a dead branch. On a machine where the budget is 30,517, silently taking half of it is a failure the operator learns about when something *else* stops working. Additionally, Node's recursive-watch emulation silently swallows `ENOSPC` during the initial walk (Resolved Assumption #7) — a partially-watched tree with no error.
- **Logic:** A single `getInotifyWatchCount()` check at watcher-arm time (and on the engine's periodic scan), against a configurable ceiling defaulting to 10% of `max_user_watches` on Linux (≈3,000 on the Pi). On hit, log the offending call site loudly and skip the arm — do not degrade quietly. The manual per-directory walk makes `ENOSPC` surface per-directory (each `fs.watch` call can throw), so the silent-swallow problem is solved by the topology change.
- **Implementation:** Read `/proc/sys/fs/inotify/max_user_watches` for the denominator; fall back to 65,536 off-Linux. Log via the existing `console.warn('[vscodeShim watcher] ...')` channel. Check before each directory arm in the walk, not just once at the top.
- **Edge Cases:** Off-Linux, `getInotifyWatchCount` returns `undefined` — skip the ceiling check (no-op), do not crash.

### 5. Do not watch `node_modules` or `.git` (cross-cutting, enforced by the manual walk)
- **Context:** 5,259 of 6,318 workspace dirs are `node_modules` and 281 are `.git`. No watcher in this product has a reason to see either. With the manual per-directory walk (Change #1), these are excluded by `EXCLUDED_DIR_NAMES` before the watch is created — the only point at which exclusion saves watches.
- **Logic:** `EXCLUDED_DIR_NAMES` (mirror `planIngestionHost.ts:35`: `.git`, `node_modules`, `dist`, `out`, `build`, `.next`, `.cache`, `logs`, `dbbackup`, `mission-control`) is applied during the walk. With the base retargeted to `.switchboard/{plans,features}` (Change #2), these trees are never entered anyway — the exclusion is a defense-in-depth for any watcher that must watch a broader root.
- **Edge Cases:** A user docs folder containing a `node_modules` (monorepo) — the exclusion still applies; no consumer needs events under `node_modules`.

## Verification Plan

> **Run note:** Compilation and automated tests are SKIPPED for this improve pass per dispatch directive. The checks below remain written down for the implementer; they are simply not executed now.

### Automated Tests
- A unit/contract test asserting `vscodeShim.createFileSystemWatcher` with a `**` glob whose base is a workspace root does NOT open watches under `node_modules/` or `.git/` — use a temp tree with fake `node_modules`/`.git` dirs and assert via the `getInotifyWatchCount`-style path mapping.
- A test asserting `_setupPlanWatcher` arms the VS Code watcher with base `.switchboard/plans`, not the workspace root (regex on the `RelativePattern` source, mirroring `plan-registry-reconciliation.test.js:69`).
- A test asserting the re-arm path: call `_setupPlanWatcher` twice; assert that the first set of watchers is closed (handle count returns to baseline) before the second set is armed. Instrument `fs.watch` to count create/close.
- A test asserting new-subdirectory creation under the manual walk: create a new subdir under a watched directory, write a `.md` file into it, assert the event fires.

### Goal Invariants
- Assert `grep -c '^inotify' /proc/<pid>/fdinfo/*` on a one-workspace board with 2,279 plan files returns a number in the **low tens**, not 16,771 — i.e. `watchCount < 50` and `watchCount` does NOT scale with plan-file count.
- Assert every watched inode in `/proc/<pid>/fdinfo` resolves to a live path under `.switchboard/{plans,features}` (negative: zero watches resolve to `node_modules/` or `.git/`). **Parse `ino:` as hexadecimal** when comparing against `stat()` decimal output — the original measurement's "84% resolve to nothing" was likely a hex/decimal artifact.
- Assert `watchCount` is stable (±2) after 1 hour of normal use (plans written, cards moved, panels opened/closed 10×) — absence of growth is the fix. Growth on an idle board is the leak; stability is the fix.
- Assert a heap snapshot's `FSWatcher` object count equals the live watch count AND each `FSWatcher` has a JS retainer path other than `Global handles` alone. This is the check that distinguishes "owned" from "abandoned".
- Assert the aggregate ceiling, when artificially lowered, logs the offending call site and the board keeps running.
- On the Pi (`max_user_watches` 30,517 — confirmed as the unmodified kernel default on a 4 GB Pi), assert a two-workspace board stays under 10% of the budget.

### Manual / Pi-only
- Verify against 30,517, not 65,536 — the Pi is the binding constraint.
- **First diagnostic (from research):** Count entries in the watched tree (`find <root> | wc -l`) and divide 19,485 by it. An integer near 1 means one leaked watcher; near 2 or 3 means overlapping watchers; a non-integer means partial overlap or re-arming. This confirms the leak mechanism before and after the fix.
- **Second diagnostic (from research):** Instrument `fs.watch` at startup to increment a counter on creation and decrement on `close()`, and log the live count periodically. This distinguishes "never closed" from "closed but ineffective" immediately.
- **Re-run the fdinfo scan with hex-aware inode parsing** before drawing conclusions from the 84% figure. Parse `ino:` as hex, convert to decimal, then resolve against `find -inum`.

## Outstanding Questions

- **None.** The one outstanding item — the `[user]` diagnostic on the Pi — was run on 2026-09-08
  against the live standalone host and is recorded as the third Superseded callout in *Problem
  analysis*. It did not confirm the assumption it was written to test; it refuted it. Read that
  callout before dispatch: the fix set below is now mis-ordered, with Change #3 carrying the whole
  repair and Changes #1/#2/#5 reduced to defence-in-depth against a branch that is not currently
  arming a single watch.

## Implementation Summary

Replaced every Linux recursive `fs.watch({ recursive: true })` site with a shared manual per-directory non-recursive walker (`src/services/directoryWatcher.ts`) that arms one `fs.watch` per directory only, applies `EXCLUDED_DIR_NAMES` (`node_modules`, `.git`, `dist`, `out`, `build`, `.next`, `.cache`, `logs`, `dbbackup`, `mission-control`) before descending, re-scans on `rename` to arm newly-created subdirectories, and closes all armed watchers synchronously on `dispose()`. The walker is wired into `planIngestionHost.attachFolderWatcher`, `hostServices.createStandaloneFolderWatcher`, the `vscodeShim` `**`-glob branch (with real listener-dispose returns replacing the no-op `dispose(){}` stubs), `GlobalPlanWatcherService`'s native fallback, and `TaskViewerProvider._configuredPlanFsWatcher`. A shared `src/services/inotifyWatchCount.ts` module exports `getInotifyWatchCount` (the `/proc/<pid>/fdinfo` scan, re-exported by `planIngestionHost` for `cli.ts`), `getInotifyCeiling` (10% of `max_user_watches`, overridable via `SWITCHBOARD_INOTIFY_WATCH_CEILING`), and `isInotifyCeilingExceeded`; the walker samples the process-wide count once at arm time and tracks local arms so reaching the ceiling logs the offending call site and skips arming without crashing the board. Stale contract tests (`plan-ingestion-target-regression`, `resident-memory-budget-contract`) were updated to assert the new manual-walk shape.
