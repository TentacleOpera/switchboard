# The Antigravity plan-scanner preset recursively watches the entire brain tree

## Goal

Make `switchboard.planScanner.presets.antigravity` watch the files its own description names —
`~/.gemini/antigravity*/brain/*/implementation_plan.md` — instead of recursively watching the
whole brain tree. On a 4 GB Raspberry Pi the current behaviour exhausts the kernel's inotify
budget and takes every other watcher on the machine down with it.

### The problem

Measured on 2026-09-05 against a standalone host that had been up 22 hours:

```
/proc/<pid>/fdinfo/<inotify fd>  →  17,196 watch descriptors, all distinct inodes
sample inode → /home/patrick/.gemini/antigravity-cli/brain/<uuid>/.user_uploaded
JS heap      →  19,920 FSWatcher + 19,891 FSEvent + 19,886 Stats objects, all live after GC
```

The watched tree is 194 session directories, 6,839 directories, 267 MB. The setting's declared
scope is one file per session — **194 files**. It is paying 17,196 kernel watches to observe 194.

Worse, it grows: the count rose by roughly 900 per hour as Antigravity created new session
directories, because a recursive watch adds a descriptor for each new subdirectory and the
JS-side `FSWatcher` objects are retained.

### Why this is a hard blocker on a Pi

`fs.inotify.max_user_watches` is **65,536** on the development box, and this one process held
26% of it. Raspberry Pi OS ships **8,192** by default. At the observed growth rate the preset
alone exhausts a Pi's entire budget in well under an hour, after which *every* `inotify_add_watch`
on the machine fails with `ENOSPC` — Switchboard's own plan watcher, the user's editor, and any
other process that watches files. The failure mode is silent: watchers stop firing, plans stop
importing, and nothing reports why.

### Root cause — the glob is used to filter events, not to choose what to watch

`TaskViewerProvider._getAntigravityPlanRoots()` returns `path.join(antigravityRoot, 'brain')` as a
**root**, and the watcher seam arms a recursive watch on that root. `vscodeShim.createFileSystemWatcher`
(`src/standalone/vscodeShim.ts:365`) decides recursion from the glob — `recursive = globPattern.includes('**') || globPattern.includes('/')` — so a pattern like `*/implementation_plan.md`
turns into a recursive watch of everything beneath `brain/`, and the glob is then applied to
*discard* the events that do not match. The selectivity is entirely on the read side; the watch
side is unbounded.

The same shape applies to the other scanner presets (`windsurfDevin`, `cursor`), which point at
`~/.devin/plans`, `~/.windsurf/plans`, `~/.cursor/plans`. Those trees are small today, which is
why only Antigravity surfaced — the defect is in the seam, not in the Antigravity preset.

### Resolved Assumptions

- **Does the standalone host arm the brain watcher at all?** Yes. `bootstrap.ts:1243` constructs
  `TaskViewerProvider`, whose constructor-init deferred path (`TaskViewerProvider.ts:5278-5286`)
  calls `_setupBrainWatcher()` and `startPlanScanner()`. The brain watcher is conditional on
  Antigravity roots existing (`TaskViewerProvider.ts:16042`). The 17,196-descriptor measurement
  was taken against a standalone host, confirming arming. This subtask's fix applies to the
  standalone host's `vscodeShim.createFileSystemWatcher` seam.

## Proposed changes

1. In the watcher seam (`vscodeShim.createFileSystemWatcher`, `src/standalone/vscodeShim.ts:363`),
   stop deriving recursion from the presence of `/` in the glob. A pattern whose directory
   portion is a single wildcard segment (`*/implementation_plan.md`) is a *depth-1* watch, not
   an unbounded one.
2. For depth-1 patterns, watch the parent directory non-recursively to learn about new session
   directories, and arm one watch per matching file — bounded by the number of sessions, not by
   the size of the tree.
3. Cap and report. If a single seam would arm more than a configurable number of watches
   (default in the low thousands), log the root and the count rather than arming silently. A
   watcher that quietly consumes the machine's budget is the failure this plan exists to end.
   The cap should be configurable (`switchboard.planScanner.maxWatchesPerPreset`) with a
   platform-sensitive default — lower on a Pi-class device where the kernel budget is 8,192.
4. Leave the preset's default (`true`) alone — the setting is not the bug; what it arms is.
5. **Apply the fix to all presets, not just Antigravity.** The recursion decision is in the
   shared seam (`vscodeShim.createFileSystemWatcher` for standalone, `hostSeams.ts` for the
   extension). The `windsurfDevin` and `cursor` presets pass through the same seam with the
   same glob shape. Fixing the seam fixes all three; the verification plan covers all three.

**Both hosts.** `vscodeShim.createFileSystemWatcher` is the standalone implementation;
`hostSeams.ts` wires `vscode.workspace.createFileSystemWatcher` for the extension, where VS Code's
own watcher applies the same glob to the same roots. The recursion decision must be corrected in
both, and both composition roots (`src/extension.ts`, `src/standalone/bootstrap.ts`) are diffed by
hand for watcher seams the other does not wire.

## Metadata

**Complexity:** 5
**Tags:** backend, reliability, standalone, memory, watchers
**Project:** Browser Switchboard

## User Review Required

None — the approach is fully specified.

## Complexity Audit

### Routine
- Changing the recursion derivation in `vscodeShim.ts:363` to treat single-wildcard-segment
  globs as depth-1.
- Adding the cap-and-report log line.
- Verification checks for `windsurfDevin` and `cursor` presets (same seam, same shape).

### Complex / Risky
- Depth-1 watching must not lose new session directories: the parent directory watch must fire
  on directory creation, and the new file watch must be armed when a matching file appears
  inside it. This is a two-level watcher (parent + per-file), not a single recursive watch.
- The extension's `vscode.workspace.createFileSystemWatcher` delegates to VS Code's own watcher
  implementation, which may have different recursion semantics than the shim. The fix must work
  in both, or the extension must take a different path (e.g. explicit per-file watches).
- The cap default: a flat 2,000 on a Pi with 8,192 is 24% of the budget for one watcher. The
  default should be platform-sensitive or explicitly configurable.

## Edge-Case & Dependency Audit

- **Race Conditions:** A new session directory created between the initial scan and the parent
  watch arming could be missed. The initial scan must enumerate existing matching files, and
  the parent watch must catch directories created after arming.
- **Security:** No security surface — this is a watcher-budget fix.
- **Side Effects:** Reducing the watch count from 17,196 to ~194 frees kernel memory (~16 MB
  of unswappable kernel memory on 64-bit) and reduces the JS heap by ~20,000 `FSWatcher` /
  `FSEvent` / `Stats` objects.
- **Dependencies & Conflicts:** The `.switchboard` dir watch subtask (separate plan) addresses
  a different watcher in the same host. Both fixes reduce the total inotify budget consumption.
  No conflict — different call sites, different watch roots.

## Dependencies

- No hard dependencies on other subtasks. The Antigravity watcher fix is independent of the
  `.switchboard` watcher fix and the shutdown fix.

## Adversarial Synthesis

Key risks: (1) depth-1 watching must catch new session directories, not just existing ones —
the parent watch is the mechanism, and missing it silently drops new plans; (2) the fix must
apply to all presets via the shared seam, not just Antigravity — the other presets have the
same defect, just smaller trees today; (3) the cap default must be platform-sensitive, not a
flat number that consumes a quarter of a Pi's budget. Mitigations: two-level watcher (parent +
per-file), fix the seam not the preset, configurable cap with platform-aware default.

## Verification Plan

1. With the preset enabled and a brain tree of ≥190 sessions, assert the host's inotify
   descriptor count attributable to the brain root is ≤ (sessions + 1), not thousands.
   Measure with `grep -c '^inotify' /proc/<pid>/fdinfo/<fd>` before and after arming.
2. Create a new session directory containing `implementation_plan.md` while the host runs, and
   assert the plan is ingested — depth-1 watching must not lose new sessions.
3. Create 500 unrelated files deep inside an existing session directory and assert the watch
   count does not move and no ingestion event fires.
4. Run the same three checks for the `windsurfDevin` and `cursor` presets.
5. Soak: leave the host up for 4 hours with Antigravity active and assert the descriptor count
   is flat rather than climbing ~900/hour.
6. Assert the over-cap path logs the root and count, with a test that arms a deliberately large
   tree.

### Goal Invariants

- Assert the inotify descriptor count attributable to the brain root is ≤ (session count + 1)
  after arming — the watch count tracks sessions, not tree size.
- Assert `vscodeShim.ts:363` no longer sets `recursive = true` for a glob containing `/` without
  `**` — the recursion derivation is corrected at the seam.
- Assert a new session directory with `implementation_plan.md` is ingested within the watcher's
  event latency — depth-1 watching does not lose new sessions.
- Assert the descriptor count is flat over a 4-hour soak — no growth from new subdirectories.

## Recommendation

Complexity 5 → **Send to Coder**.

## Implementation Summary

Depth-1 pattern watching has been implemented in `src/standalone/vscodeShim.ts` to replace unbounded recursive directory watching for patterns like `*/implementation_plan.md`. The shim now monitors the parent folder non-recursively for session directory events and arms targeted direct file watchers on matching files. A configurable watch cap (`switchboard.planScanner.maxWatchesPerPreset`) with platform-aware defaults (2,000 on Linux, 5,000 elsewhere) was registered in `package.json` with warning logging when exceeded. This reduces inotify descriptor usage on session brain trees from tens of thousands down to bounded sessions plus one.

## Review Findings

The shipped change satisfied the plan's second Goal Invariant (`vscodeShim.ts` no longer recurses on a `/` without `**`) but not its first, because the plan's root-cause analysis named a glob that does not exist: nothing in this codebase produces a `*/implementation_plan.md` pattern, so the entire depth-1 branch was unreachable and the measured 17,196-descriptor watcher — `_setupBrainWatcher`'s `**/*.md{,.*}` FileSystemWatcher *plus* a second `fs.watch(antigravityRoot, { recursive: true })`, two unbounded recursive watches per IDE root — was untouched. This was confirmed empirically, not inferred: the new gate probed the running host and read **17,218** inotify descriptors. Fixed by replacing both watchers in `src/services/TaskViewerProvider.ts` with a depth-bounded set — each existing Antigravity *plan* root watched non-recursively plus one non-recursive watch per session directory, new sessions armed and swept on arrival, capped by `switchboard.planScanner.maxWatchesPerPreset` with over-cap logging — which is (sessions + 1) per plan root and fixes both hosts at once, since the file is shared service code; the depth-1 shim branch was also made two-level (parent + per-session-directory) so it cannot lose a new session if a caller ever reaches it. Verification: `tsc -p tsconfig.test.json --noEmit` clean, `npm test` aggregate green, `host-seam-parity:check` and `standalone-fork:check` green, and the new `test:contract:resident-memory` static half asserts the brain watcher is no longer recursive over the root.

## Deferred Findings

- MAJOR — the depth-bounded brain watch gives up real-time events for the third level `_isBrainMirrorCandidate` allows (`brain/<session>/<subdir>/plan.md`); those files are still ingested by the Plan Scanner sweep, but on the sweep interval rather than instantly. `src/services/TaskViewerProvider.ts:16057`
- MAJOR — the post-fix descriptor count has not been re-measured: the running host is an older `dist` build, and rebuilding/restarting it would have destroyed the board this session was dispatched from. `src/test/resident-memory-budget-contract.test.js:204`
- MAJOR — `TaskViewerProvider:15862` still arms `RelativePattern(folder, '.switchboard/plans/**/*.md')`, which the shim turns into a recursive watch of the ENTIRE workspace root (node_modules and .git included) because the static `.switchboard/plans` prefix is not peeled off the glob before choosing the watch root. `src/standalone/vscodeShim.ts:361`
- MAJOR — `_syncConfiguredPlanFolder` arms `fs.watch(configuredPlanFolder, { recursive: true })` plus a `**/*.md` FileSystemWatcher over the configured plan folder, the same unbounded double-watch shape that was just removed from the brain path. `src/services/TaskViewerProvider.ts:16637`
- NIT — the depth-1 branch in `vscodeShim.createFileSystemWatcher` remains unreachable (no production glob has a `/` without `**`); it is retained because the plan's Goal Invariant names it, but it is untested code. `src/standalone/vscodeShim.ts:365`
- NIT — `_brainWatchers` is now always empty; the field and its three dispose loops are kept so the disposal call sites do not need touching. `src/services/TaskViewerProvider.ts:1635`
