# Terminal logs publish to the board state repo — a searchable record, and live status

## Goal

Publish terminal logs to the private board state repo alongside `board.json`, so
the work the fleet has done becomes a searchable store, and so a cloud agent can
answer *"what is happening on this card right now"* by reading a repo it already
clones.

### Problem Analysis

**Two different questions, one mechanism.** A completed log is a record: what was
attempted, by which CLI, against which plan. An in-flight log is a status signal:
is the coder moving, stuck, or looping. Both are already on disk in
`.switchboard/logs/`; neither is reachable from a cloud session, because that
directory is gitignored and the machine is behind loopback.

**The state repo is already the channel for exactly this.**
`board-state-moves-to-a-private-repo.md` establishes a private repo whose sole
writer is the user's machine, carrying `board.json` and the control channel's
receipts, cloned read-only by cloud agents. Logs belong in the same place: same
audience, same trust boundary, same clone the agent already has.

**A cloud agent currently has no way to check on work it dispatched.** It files a
dispatch, reads a receipt saying the instruction was applied, and then goes blind.
`board.json` tells it which column a card sits in — which changes at the end of a
stage, not during one. For a long coding run, "still in CODER CODED" and "wedged
for forty minutes" look identical.

**The blocking problem is not plumbing — it is that pty output contains
secrets.** Terminal output routinely carries tokens printed by a CLI, `.env`
contents, connection strings, and customer data pulled into a test fixture. The
writer strips ANSI and collapses CR redraws; it redacts nothing. Publishing that
into a git repository makes it permanent in a way a local file is not: **a secret
pushed once stays in history even after the file is deleted.** That single property
is why this cannot be on by default and cannot be silent.

**And volume is a real cost, not a rounding error.** Logs cap at 10 MiB per session
file (`LOG_CAP_BYTES`), a fleet produces many per day, and git history never
shrinks. Publishing whole in-flight files on a timer would push megabytes per cycle
to answer a question a few kilobytes can answer.

### Root Cause

The logs were designed as local diagnostics for someone sitting at the machine. The
remote and unattended workflows this codebase now supports have no equivalent, so
the information exists and the people and agents who need it cannot reach it.

### Non-goals

- **Naming.** `terminal-logs-are-named-for-what-they-record.md` — and it is a hard
  dependency: an opaque filename published remotely is no more searchable than an
  opaque filename locally.
- **Un-ignoring `.switchboard/logs/`.** Logs never enter the code repo. This
  publishes *copies* to a different repository.
- **Local retention and pruning policy** — `retention-and-archive-for-unbounded-growth.md`
  owns that. This plan bounds only what it publishes.
- **A second repo for logs.** They go in the state repo, as asked. If history
  growth ever forces a split, that is a later decision with a migration.
- **Parsing or summarising log content.** Publishing is verbatim (after redaction).
  An agent reads what happened; nothing here interprets it.
- **On by default.**
- **Confirm gates.** Per project rule, none.

## Metadata

**Complexity:** 6
**Tags:** feature, backend, devops, security, infrastructure
**Feature:** 2440474a-cbe2-4876-b65d-3ccffd000aa3

## Dependencies

- `board-state-moves-to-a-private-repo.md` — the repo, the clone cache, and the
  serialized `withStateRepo` write path.
- `terminal-logs-are-named-for-what-they-record.md` — meaningful filenames.

## Proposed Changes

### 1. Opt-in, with the disclosure stated at the switch

`boardState.publishLogs`, default **off**, independent of the snapshot's own
opt-in. Turning it on must show the consequence in plain words, next to the toggle:

> This publishes your terminals' output to the state repository. Terminal output
> can contain API keys, `.env` contents, and customer data, and git history keeps
> whatever is pushed even after the file is deleted. Turn this on only for a repo
> whose readers you would show your terminal to.

Redaction (below) reduces the risk and does not remove it, so the warning does not
soften on account of it.

### 2. Two publish modes, matched to the two questions

**On session close — the full log.** A closed session is a finished unit of work
and the thing worth keeping. Published once, at `logs/<filename>.md`, using the
name from the naming plan.

**While in flight — a bounded tail.** On a timer (default 5 minutes), publish the
last N KB (default 64) of each active log to `logs/live/<filename>.tail.md`. This is
what answers the status question, and it answers it at kilobytes rather than
megabytes. The tail file is deleted from the tip when the session closes and its
full log lands — one canonical copy per session in the tree.

Never publish per flush. The gateway's flush interval drives every terminal
(`terminalLogWriter.ts:11-14`); pushing on it would put a git operation on a shared
timer.

### 3. `logs/index.json` — the thing that makes it searchable

One file listing every published log, so a reader answers "what happened on plan X"
with a single fetch rather than by listing and parsing a tree:

```json
{ "schema": 1, "updatedAt": "…",
  "logs": [
    { "planId": "a3f19c2b…", "planSlug": "milestones-tab-in-the-kanban-panel",
      "terminal": "coder-1", "cli": "claude", "sessionId": "s7k2m",
      "status": "closed", "bytes": 184320, "startedAt": "…", "endedAt": "…",
      "path": "logs/coder-1-claude-milestones-tab-…-s7k2m.md" },
    { "planId": "b81f…", "status": "live", "path": "logs/live/…tail.md", "…": "…" }
  ] }
```

Indexed by `planId` **and** `planSlug` for the same reason the filename carries
both: exactness for an agent, readability for a human. `status` distinguishes a
live tail from a closed record, so an agent knows whether it is reading current
activity or a finished run.

### 4. Redaction, before anything leaves the machine

A pass over the published copy — never over the local file, which stays intact for
the person at the machine:

- common credential shapes: `AKIA…`, `ghp_`/`gho_`/`github_pat_`, `sk-`-prefixed
  keys, `xox[baprs]-`, bearer tokens, PEM blocks, JWT-shaped triples;
- `KEY=`/`TOKEN=`/`SECRET=`/`PASSWORD=` assignments, value replaced;
- any line matching the workspace's own `.env` **values** where readable — the
  highest-value redaction available, because it catches secrets whose shape is not
  guessable.

Each redaction leaves a visible marker so a reader knows something was removed
rather than silently seeing altered output.

**Documented as best-effort, in the same words as the toggle warning.** A
pattern-matching redactor cannot catch an arbitrary secret in arbitrary output, and
describing it as protection rather than as reduction is how someone ends up
publishing a private-repo log to a wider audience believing it is clean.

### 5. Where the publisher lives

`BoardLogPublisher`, constructed alongside `BoardSnapshotPublisher` inside
`KanbanDatabase` creation (`KanbanDatabase.ts:1319`) — the reason the snapshot
publisher has never diverged between hosts. **No new composition-root seam.**

It **reads log files from disk**; it does not subscribe to the writer. Two reasons,
both structural: the writer runs in the pty child (`ptyHost.ts:53`) which has no git
credentials and no business acquiring them; and reading from disk keeps the
publisher indifferent to which host produced the files, so the naming plan's
promise of identical output across hosts carries through.

All writes go through the state-repo plan's serialized `withStateRepo` helper. With
snapshot, receipts, and now logs, three components on the machine write one repo —
one lock, or a corrupted clone in a cache directory nobody inspects.

### 6. Bounding what the tree carries

- Live tails: one per active session, capped, deleted on close.
- Closed logs: prune from the **tip** beyond a configurable count (default 200) or
  age (default 60 days), oldest first. History retains them; the working tree stays
  clonable.
- `index.json` is rewritten whole each publish — it is small, and a merge-based
  index is a conflict waiting for a repo that is supposed to have one writer.

**Say the honest thing in the docs:** git history grows monotonically, so a repo
accumulating logs gets large over months. Mitigation, offered as a documented
maintenance action rather than automated: re-initialise the state repo (fresh
history, current tip). Never rewrite history automatically — an agent force-pushing
a rewritten history over someone's audit record is worse than a large repo.

### Migration

New state: one config key, one index file, one directory in the state repo. Nothing
existing is reinterpreted, no local file is modified, and `.switchboard/logs/` stays
gitignored. Off by default, so an upgraded install publishes nothing until asked.

## Verification Plan

1. **Off by default** — no log file is read and no git command runs until the key
   is set (spy on both).
2. **Session close publishes once** — the full log lands at the expected path with
   the naming plan's filename; a second cycle does not re-push unchanged content.
3. **Live tail is bounded and current** — an active 5 MiB log publishes ≤64 KB, and
   the tail contains the *end* of the file. Assert the push size, not just
   correctness.
4. **Tail is cleaned up** — closing the session removes `logs/live/…tail.md` from
   the tip in the same commit that adds the full log; assert exactly one copy of
   that session in the tree.
5. **Redaction** — a log seeded with each pattern publishes with every one removed
   and a marker present. Assert the **local file is unchanged** — redacting the
   user's own diagnostics would be a real regression. Include one negative case: a
   secret of unguessable shape survives, proving the documented limit is real
   rather than aspirational.
6. **Index** — lookup by `planId` and by `planSlug` both resolve; `status`
   distinguishes live from closed; a plan with three sessions lists three entries.
7. **Serialization** — a snapshot publish, a receipt write, and a log publish
   triggered concurrently produce one clone operation at a time and all three
   results land.
8. **Pruning** — exceed the count and age limits; assert the oldest are dropped from
   the tip, that history still contains them, and that `index.json` no longer lists
   what the tree no longer carries.
9. **Code repo untouched** — run publishes with the user's checkout dirty; assert
   branch, index, and files unchanged, and that the logs gitignore contract test
   still passes.
10. **Cloud-agent status check, end to end** — dispatch a card, then from a clone
    with no extension: read `index.json`, find the live entry for that plan, read the
    tail, and see current output. This is the acceptance test for the second use
    case.
11. **Both hosts** — publish under the extension host and the standalone host and
    assert identical paths and index entries.

### Goal Invariants

- Nothing is published until a user turns it on, having been told what publishing
  means.
- A published log is findable by plan, terminal, or CLI without opening it.
- A cloud agent can distinguish current activity from a finished run, and read
  current output at kilobyte cost.
- The local log files are never modified by publishing.
- Logs never enter the code repository.
- The state repo has one writer and one canonical copy per session.
- Redaction is described as reduction, never as protection.
