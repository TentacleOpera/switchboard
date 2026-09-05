# The Watcher Scans an Intake Folder, Not the Whole Archive

kanbanColumn: BACKLOG

## Goal

New plans arrive through a small intake directory the watcher sweeps. The accumulated archive is not scanned, so a board host that reaches its plans over a network path pays for the plans arriving, not the plans that already arrived.

### Problem analysis

This settles the open question recorded in *An app that pairs two machines* (line 174):

> *"Should the remote run the plan scanner against repositories it can see, or is scanning strictly client-side? This decides whether the remote needs access to code at all."*

**Answer: it scans, but it scans a bounded directory rather than the accumulated archive.**

**What a sweep actually costs.** The scanner is already incremental — it does not re-read every plan:

```js
:637  readdir(dir, { withFileTypes: true })
:693  const stats = await fs.promises.stat(entryPath);
:694  if (stats.mtimeMs < lastScan) { continue; }   // unchanged → skipped
:695  if (now - stats.mtimeMs < 500) { continue; }  // too fresh → skipped
```

One `readdir` plus one `stat` per file, and a `readFile` only where the mtime advanced. Locally that is microseconds and no problem at all — **this card is not about local installs.**

**The cost is the file count, and only when the directory is remote.** Measured 2026-09-05:

| | |
| :--- | :--- |
| plan files | **2,247** |
| feature files | 312 |
| tower ↔ Pi over wifi | 4.7 / **47.8** / 94.2 ms, jitter 25.9 |
| tower ↔ Pi over the direct cable | 0.27 / **0.28** / 0.30 ms, jitter 0.008 |

On a paired setup — a Pi cabled to the modem holding the board, a tower holding the repo — those 2,247 stats become 2,247 round trips every sweep, at a default interval of 10 seconds, forever. Nothing about that work is useful: the archive does not change.

**The number only grows.** 2,247 today, and every plan ever written stays. A design that scans the archive gets slower for the rest of the product's life, on every host.

**Why not simply disable the watcher.** An earlier draft of this card proposed an off switch. That is the wrong shape: a board that silently stops accepting plans written to disk is indistinguishable from a broken one, and it takes away the mechanism rather than fixing its cost.

**Why not mirror the archive.** Also considered and rejected: syncing 49 MB to both machines needs sync machinery and two copies kept honest, to avoid scanning files nobody reads. Bounding the scan is strictly less work than replicating the thing being scanned.

## Metadata

- **Complexity:** 4
- **Feature:** Two Machines, One Board - the Paired App and Its Command Loop
- **Tags:** paired-hosts, watcher, performance

## User Review Required

Change 2 carries one decision: where an imported plan comes to rest.

## Proposed Changes

### 1. The watcher sweeps an intake directory

Point the scan at a directory that holds only plans that have not yet been imported. A handful of files is cheap to stat at any latency, and stays cheap as the archive grows.

The interval and the incremental mtime check stay exactly as they are. This changes *what* is swept, not how.

### 2. Decide where an imported plan comes to rest **[decision]**

Two shapes work and they differ in what the board holds:

- **Intake as a staging drop.** A plan is imported, then moved to the archive directory; the database records the final path. The board keeps the full history and the watcher never looks at it again.
- **Intake as the board's whole plans directory.** The archive lives elsewhere entirely and the board simply does not hold 2,247 files.

Prefer the first unless the paired case makes the archive genuinely unreachable — it keeps a single-machine install visibly unchanged.

**The move must not race the watcher.** `:695` already skips files younger than 500 ms, which reads as a scar from exactly this class of race. Whatever performs the move has to be ordered against the import, not merely delayed.

### 3. An existing install migrates without losing plans

There are 2,247 plan files in this workspace and the same shape in every other install. The archive is not re-imported and not moved wholesale on upgrade; existing rows keep their recorded paths, and only new arrivals use intake.

Per the repository's migration rule: a plan file that exists in a released version is migrated, never dropped, and never assumed to have been handled by a prior pass.

### 4. Say which directory is being watched

A plan that does not appear should be diagnosable. The board states the directory it sweeps somewhere an operator reads, so "I wrote a plan and nothing happened" resolves to "you wrote it to the archive, not the intake" instead of a hunt.

## Edge-Case & Dependency Audit

1. **A single-machine install must see no behavioural change.** The scan gets cheaper; nothing else moves. If change 2 lands as the staging drop, plan files end up exactly where they do today.
2. **Agents write plans by path.** Skills, prompts and the `create-plan` paths all name a plans directory. Every writer has to target intake, or the watcher will not see what they produce — this is the change most likely to be missed, because a plan written to the old path simply never appears.
3. **The importer is not the only reader.** `POST /kanban/plans` and the feature-file path also create plans; they are unaffected and must stay so.
4. **Both hosts run the watcher.** A directory honoured by one host and not the other is the divergence trap.
5. **Do not use this to justify mounting the archive.** The measurement argues against mounting the plans tree at either latency; the intake folder exists so that mounting is unnecessary.
6. **Interacts with `eb2456e0`** — a standalone board that never scaffolds may have no intake directory to watch. Confirm the two compose.

## Verification Plan

1. A sweep stats the intake directory only, and its cost does not grow with the archive.
2. A plan written to intake imports as it does today.
3. An imported plan comes to rest per the change-2 decision, and the database records where.
4. A plan written while a move is in flight is imported exactly once.
5. An existing install with 2,247 archived plans upgrades without re-importing or losing any.
6. Every writer that creates a plan file targets intake.
7. The board states which directory it watches.
8. Both hosts sweep the same directory.
