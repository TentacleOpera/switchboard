# The Plan Watcher Becomes a Setting, Because a Paired Board Does Not Own the Plans Tree

kanbanColumn: BACKLOG

## Goal

An operator running the board on one machine and the agents on another can turn the plan watcher off, or narrow what it sweeps, without losing the board.

### Problem analysis

This settles the open question recorded in *An app that pairs two machines* (line 174):

> *"Should the remote run the plan scanner against repositories it can see, or is scanning strictly client-side? This decides whether the remote needs access to code at all."*

**Answer: it must be optional, because on a paired setup the board host frequently has no good access to the tree.**

The concrete case, measured 2026-09-05. A Raspberry Pi is the only machine that can be cabled to the modem, so it is the natural board host; the tower has the CPU and holds the repository. Between them:

| | |
| :--- | :--- |
| plan files | **2,247** |
| feature files | 312 |
| `.switchboard/plans/` on disk | 49 MB |
| tower ↔ Pi over wifi | 4.7 / **47.8** / 94.2 ms, jitter 25.9 |
| tower ↔ Pi over the direct cable | 0.27 / **0.28** / 0.30 ms, jitter 0.008 |

A network mount of that directory is the wrong shape at either latency. The watcher sweeps on an interval — every 10 s by default — and a sweep over 2,247 files is thousands of round trips. At 48 ms that is minutes per pass, permanently. Even at 0.28 ms it is a poor use of a link the agents also need.

**Today there is no way to say no.** The watcher is unconditional: a board host scans whatever plans directory it is pointed at, forever. So a paired setup has only bad options — mount the tree and accept a watcher that never finishes a pass, or leave the board with no plans at all.

**This is not the same as the board being read-only.** Plans still reach the board; they simply arrive by a route that does not require the board host to own a filesystem. `POST /kanban/plans` already exists, and the agent host can post as it writes.

## Metadata

- **Complexity:** 3
- **Feature:** Two Machines, One Board - the Paired App and Its Command Loop
- **Tags:** paired-hosts, watcher, settings

## User Review Required

None.

## Proposed Changes

### 1. The watcher can be turned off

A setting that stops the plan sweep entirely. The board still serves, still renders, still dispatches — it simply stops treating a directory as an input.

State plainly in the setting's description what turns off with it: plans no longer appear by being written to disk. That is the whole contract of the watcher and an operator disabling it must know they are trading it away.

### 2. And it can be narrowed instead of disabled

Off is too blunt for a board host that *does* hold some of the tree. Offer the middle: a longer interval, or a scoped subdirectory, so a host that can afford one sweep a minute over one folder is not forced to choose between minutes-per-pass and nothing.

Prefer the interval control if only one ships — it is the one that turns an unusable sweep into a tolerable one without changing what the board can see.

### 3. Say which route plans are arriving by

With the watcher off, a plan that does not appear looks like a bug. The board should state its input mode where an operator will see it — watching a directory, or accepting posts — so an absent plan is diagnosable rather than mysterious.

This is the config-read rule: a board that silently stopped watching is indistinguishable from a board whose watcher is broken.

### 4. Record the answer on the parent plan

Line 174 asks whether the remote scans or scanning is client-side. The answer this card establishes is *neither, by default — it is the operator's choice, and the default depends on which machine holds the tree*. Write that into the parent so the question is closed rather than re-asked.

## Edge-Case & Dependency Audit

1. **A single-machine install must be unaffected.** The default stays "watch", and an operator who never opens this setting sees no change. This is an opt-out for a topology most users do not have.
2. **Disabling the watcher must not disable the importer.** `POST /kanban/plans` and the feature-file path are separate inputs and must keep working — that is what makes disabling survivable.
3. **Do not make this a mount recommendation.** The measurement here argues *against* mounting the plans tree; the setting exists so that mounting is unnecessary, not so that a slow mount becomes tolerable.
4. **Both hosts.** The watcher runs in the extension host and in standalone; a setting honoured by one is the divergence trap.
5. **Interacts with `eb2456e0`.** A standalone board that never scaffolds and never watches is a board with no inputs at all. Confirm the two settings compose into something usable rather than an empty board.
6. **The board database is already machine-local** since the storage overhaul (`~/.switchboard/boards/<id>.db`), so nothing here touches where state lives — only where *plans* are read from.

## Verification Plan

1. With the watcher disabled, the board serves and dispatches, and a plan written to disk does not appear.
2. With the watcher disabled, a plan posted to `POST /kanban/plans` does appear.
3. With an interval set, the sweep runs at that interval and not more often.
4. With a scoped directory set, only that directory is swept.
5. The board states its current input mode somewhere an operator reads.
6. A default single-machine install behaves exactly as it does today.
7. Both hosts honour the setting identically.
