# Agents Write to an Intake Folder, and the Scanner Watches Only That

kanbanColumn: BACKLOG

## Goal

New plans are written to `.switchboard/plans/intake/`. The scanner watches that folder and nothing else. On import the file moves into `.switchboard/plans/` and the database records where it landed.

### Problem analysis

**The scanner stats the whole archive to find the few files that changed.** It is already incremental about *reading* — one `readdir`, one `stat` per file, and a `readFile` only where the mtime advanced:

```js
:637  readdir(dir, { withFileTypes: true })
:693  const stats = await fs.promises.stat(entryPath);
:694  if (stats.mtimeMs < lastScan) { continue; }   // unchanged → skipped
:695  if (now - stats.mtimeMs < 500) { continue; }  // too fresh → skipped
```

But it must still stat every file to learn that. In this workspace that is **2,247 plan files** every sweep, at a default interval of 10 seconds, to discover the nought-to-two that are new.

**And the cost only grows.** Every plan ever written stays in the folder. The sweep gets slower for the life of the product, on every install, and nothing about the archive changes between sweeps.

**An inbox makes the scan proportional to arrivals rather than to history.** The scanner watches a folder holding only plans that have not been imported yet — a handful of files, forever, regardless of how large the archive becomes.

**This is one machine and one tree.** Plans still come to rest in `.switchboard/plans/`, the board still reads any plan from there, and nothing about how a plan is read changes. Only the swept directory is different.

That matters because the board reads plan files on demand, not just at import — `_handleGetPlan` (`LocalApiServer.ts:8489-8503`) resolves `record.planFile` and reads it from disk on every fetch. A design that left files in a separate inbox, or moved them without recording where, would break that. This one does not: the recorded path is the final path.

## Metadata

- **Complexity:** 4
- **Tags:** watcher, performance, plans

## User Review Required

None.

## Proposed Changes

### 1. The scanner watches `plans/intake/`

Point the sweep at the inbox. The interval and the incremental mtime check are unchanged — this changes *what* is swept, not how often or how.

### 2. On import, the file moves to `plans/` and the record names its destination

The importer reads from intake, writes the row, and the file comes to rest in the archive. `plan_file` records where it ended up, not where it was found, so every later read resolves.

**The move must be ordered against the import, not merely delayed.** The `500 ms` freshness skip at `:695` reads as a scar from this class of race; a move that fires on a timer will reopen it. Read, insert, move, in that order, with the row carrying the destination path.

### 3. Every writer of plan files targets intake

This is the change most likely to be missed, and its failure is silent: a plan written to the old path is never scanned, never imported, and produces no error anywhere.

The writers include the plan-authoring skills and prompts, the memo and notes scheduled jobs, `create-plan` paths, and anything in `.agents/` that tells an agent where to put a plan. All of them move together, or the ones left behind stop working.

### 4. Existing plans stay where they are

2,247 files in this workspace, and the same shape everywhere. They are not re-imported, not moved, and not re-scanned. Existing rows keep their recorded paths; only new arrivals pass through intake.

Per the repository's migration rule: state that has shipped is migrated, never dropped, and never assumed to have been handled by a previous pass.

## Edge-Case & Dependency Audit

1. **A plan written directly to `plans/` is invisible.** That is the intended behaviour and the main hazard — an operator or agent using the old path gets silence. Worth a one-line note wherever the plans directory is documented.
2. **The board must still read from the archive.** `_handleGetPlan` reads `record.planFile` on every fetch; the archive is not cold storage and must stay readable.
3. **A crash between read and move** must not lose the file or double-import it. Either the row exists and the file is in the archive, or neither.
4. **Feature files are a separate directory** and out of scope unless they share the scan.
5. **Both hosts run the watcher** and must sweep the same directory.
6. **It also helps the paired case**, where a board host reaches the tree over a network path — but that is a consequence, not the reason. This is worth doing on a single machine.

## Verification Plan

1. A sweep stats the intake folder only, and its cost does not grow with the archive.
2. A plan written to intake is imported and appears on the board.
3. After import the file is in `.switchboard/plans/`, and the record's `plan_file` points there.
4. Opening that plan on the board returns its content.
5. A plan written directly to `.switchboard/plans/` is not imported.
6. Every plan-writing path targets intake.
7. An install with 2,247 archived plans upgrades without re-importing, moving or losing any.
8. A crash between read and move leaves either both the row and the moved file, or neither.
