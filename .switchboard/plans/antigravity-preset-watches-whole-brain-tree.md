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

## Proposed changes

1. In the watcher seam, stop deriving recursion from the presence of `/` in the glob. A pattern
   whose directory portion is a single wildcard segment (`*/implementation_plan.md`) is a
   *depth-1* watch, not an unbounded one.
2. For depth-1 patterns, watch the parent directory non-recursively to learn about new session
   directories, and arm one watch per matching file — bounded by the number of sessions, not by
   the size of the tree.
3. Cap and report. If a single seam would arm more than a configurable number of watches
   (default in the low thousands), log the root and the count rather than arming silently. A
   watcher that quietly consumes the machine's budget is the failure this plan exists to end.
4. Leave the preset's default (`true`) alone — the setting is not the bug; what it arms is.

**Both hosts.** `vscodeShim.createFileSystemWatcher` is the standalone implementation;
`hostSeams.ts` wires `vscode.workspace.createFileSystemWatcher` for the extension, where VS Code's
own watcher applies the same glob to the same roots. The recursion decision must be corrected in
both, and both composition roots (`src/extension.ts`, `src/standalone/bootstrap.ts`) are diffed by
hand for watcher seams the other does not wire.

## Metadata

**Complexity:** 5
**Tags:** backend, reliability, standalone, memory, watchers

## User Review Required

None — the approach is fully specified.

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
