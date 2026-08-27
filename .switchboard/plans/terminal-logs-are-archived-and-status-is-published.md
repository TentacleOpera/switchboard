# Terminal logs go to the Archive store; a Runtime-safe status goes to the board destination

## Goal

Make the work the fleet has done searchable, and let a remote agent tell whether a
card is moving or wedged — without inventing a storage location and without
publishing machine-local detail that the storage topology says never leaves the
machine.

Two needs, two destinations, both already defined by existing plans:

- **searchable record of work done** → the **Archive** store;
- **is this card moving** → a small status payload at whatever destination
  `boardStateExport` already points to.

### Problem Analysis

**The information exists and is unreachable.** `TerminalLogWriter` writes
`.switchboard/logs/`, gitignored by a contract test
(`terminal-session-log-contract.test.js:438-449`), on a machine behind loopback. A
remote agent that dispatched work has `board.json`, which reports the column a card
sits in — and a column changes at the *end* of a stage. For a long coding run,
"still in CODER CODED" and "wedged for forty minutes" are the same reading.

**The Archive store is exactly log-shaped, and it is already specified.**
`storage-topology-one-choice-three-stores.md` defines three stores from one
operator choice, and its table gives Archive as *"past the window | derived from the
target, separate database | no — queried on demand"*, append-only. Large, durable,
rarely read, discardable, placement inherited rather than chosen. That is the
description of a log archive.

**Everything else I considered is worse for a specific reason.**

- **A dedicated logs repo.** An eleventh answer to "where does my data live",
  which the topology plan exists to prevent — it enumerates ten and argues storage
  must be a topology the product owns rather than a setting a user types.
- **The DuckDB archive.** Demoted. Topology decision 2: *"demote to an opt-in
  analytics export that is never load-bearing — never a store the product depends
  on."* It also needs a CLI binary the extension cannot install for ~4,000 users,
  and `switchboard.archive.dbPath` defaults to empty, so it is disabled out of the
  box.
- **Object storage (S3/R2/GCS).** The best technical fit — lifecycle rules do
  retention for free, range requests make tail reads genuinely cheap — and the
  worst product fit, because it means a write credential on the user's machine and
  a read credential for every agent. The escape hatch if volume ever demands it,
  not the default.

**This plan is blocked on an open decision, and it is worth naming rather than
picking.** Topology decision 2 (demote DuckDB) is unresolved, and two live plans
assume opposite answers: `retention-and-archive-for-unbounded-growth.md` lists
*"Changing what the archive is (DuckDB stays)"* as a non-goal and recommends the
archived-history UI be *"served from the DuckDB archive"*. Logs make the tension
concrete rather than theoretical: **a searchable log archive is load-bearing by
definition**, so if Archive is DuckDB then logs cannot go there under the topology
rule, and if logs go there the rule is broken. Recommendation, offered as evidence
for that decision: Archive is the SQLite/libSQL store the topology plan derives
from the target, and DuckDB stays as the opt-in analytics export it was demoted to.

**And the status payload, as I first designed it, would break a stated privacy
invariant.** The topology plan says of the Runtime store: *"Runtime holds
filesystem paths and terminal names, and it is the store that never leaves the
machine. Stating that as an invariant is a privacy improvement worth naming: a
shared board never learns anyone's directory layout."* `git-carried-shared-board-state.md`
enforces the same line with a contract test asserting no local-tier field appears
in `board.json`.

Terminal names are Runtime tier. Log tails are full of filesystem paths. So a
status payload carrying "terminal `coder-1` last wrote at…, here are 64 KB of its
output" is Runtime-tier data leaving the machine — into a destination that, under
`git-carried-shared-board-state.md`, may be a **shared team repo**. That is not a
detail to handle later; it decides the payload's shape.

### Root Cause

Logs were designed as local diagnostics for someone at the machine. Making them
remotely useful is not a transport problem — it is a question of which tier the
information belongs to, and the answer is different for "is it moving" than for
"what happened".

### Non-goals

- **Naming.** `terminal-logs-are-named-for-what-they-record.md` — a hard
  dependency: an unaddressable filename is no more searchable in an archive than on
  disk.
- **Retention windows and rotation values** — `retention-and-archive-for-unbounded-growth.md`
  owns them. This plan adds a target to that policy and sets no numbers.
- **Choosing where Archive lives.** Derived from the topology target.
- **A new repo, ref, or destination of any kind.**
- **Un-ignoring `.switchboard/logs/`.** Local files are untouched; these are
  copies.
- **Parsing or summarising log content.** Verbatim after redaction.
- **On by default**, for either half.
- **Confirm gates.** Per project rule, none.

## Metadata

**Complexity:** 5
**Tags:** feature, backend, database, security, infrastructure
**Feature:** 2440474a-cbe2-4876-b65d-3ccffd000aa3

## Dependencies

- **Hard prerequisites:** `terminal-logs-are-named-for-what-they-record.md`;
  `storage-topology-one-choice-three-stores.md` for the Archive store's existence
  and placement.
- **Blocked on** topology decision 2 (what Archive is). See above — this plan is
  evidence for it, not a workaround around it.
- **Extends** `retention-and-archive-for-unbounded-growth.md` with a fifth growth
  target.

## Proposed Changes

### 1. Logs land in the Archive store

A `terminal_logs` table in Archive: one row per log file, keyed by `plan_id`,
`terminal`, `cli`, `session_id`, with `started_at`, `ended_at`, `bytes`, and the
content. Written **on session close** — a closed session is a finished unit; an
in-flight one is answered by §2.

Append-only and on-demand, matching Archive's stated character. Nothing on a board
render path reads it, which is what keeps it from becoming the thing topology
decision 2 forbids for DuckDB.

Searchable in the way the naming plan's filenames are not: by plan, CLI, terminal,
time range, **and content**, in SQL. That is the difference between a directory you
grep and a record you query.

### 2. Retention — a fifth append-only target

`retention-and-archive-for-unbounded-growth.md` identifies four unbounded tables:
`plan_events` / `plan_events_v20`, `activity_log`, `job_runs`,
`board_move_requests`. Terminal logs are a fifth, and the largest by orders of
magnitude — a 10 MiB cap per session file against rows that are mostly integers.

Two things that plan needs told:

- **Log rows need their own window**, shorter than the event window, because a
  180-day event row is kilobytes and a 180-day log corpus is gigabytes.
- **Its own guidance applies here first:** *"Growth measurement has to precede
  policy."* Ship the size-reporting surface with logs included before setting any
  number.

Rotation out of Archive is deletion, not a move to a further store — and that is
the point of putting them here: Archive is the layer that is allowed to be
discardable.

### 3. Status: two payloads, because they are two tiers

**Tier-safe status, published with the mirror content.** A `status.json` sibling to
`board.json` at whatever `boardStateExport` resolves to, carrying **no
Runtime-tier identifiers**:

```json
{ "schema": 1, "updatedAt": "…",
  "cards": [ { "planId": "abc-123", "state": "active",
               "lastActivityAt": "…", "idleSeconds": 45 } ] }
```

No terminal name, no path, no output, no CLI. It answers the question that
actually gets asked — *is this moving, or has it been silent for forty minutes* —
and it breaks no invariant, so it needs no exception and no opt-in beyond the
destination already being configured.

It is a **sibling file, never a field in `board.json`**: that snapshot is the
shared tier and `git-carried-shared-board-state.md`'s contract test asserts no
local-tier field appears in it.

**The output tail is a separate, explicit opt-in.** `boardState.publishLogTails`,
default off, publishing a bounded tail (default 64 KB) per active session to
`logs/live/`. Documented as what it is: **a deliberate exception to
"Runtime never leaves the machine"**, because a tail carries terminal names,
filesystem paths, and whatever the CLI printed. The toggle says so:

> This publishes your terminals' output to the board destination. Terminal output
> can contain API keys, `.env` contents, filesystem paths, and customer data, and a
> git destination keeps whatever is pushed even after the file is deleted. If the
> destination is shared with a team, they will see it.

Never published per flush — the gateway's flush interval drives every terminal
(`terminalLogWriter.ts:11-14`), so a git operation on it would sit on a shared
timer. Debounced to the destination's own outbound cadence, which
mirror-channels §3 already floors at the poll interval.

### 4. Redaction, on the published copy only

Applied to tails and to Archive content when the target is remote; never to the
local file, which stays intact for the person at the machine.

Common credential shapes (`AKIA…`, `ghp_`/`github_pat_`, `sk-`, `xox[baprs]-`,
bearer tokens, PEM blocks, JWT triples), `KEY=`/`TOKEN=`/`SECRET=`/`PASSWORD=`
assignments, and — the highest-value one, because its shape is not guessable — any
line containing a value read from the workspace's own `.env`. Each redaction leaves
a visible marker.

**Described as reduction, never as protection.** A pattern matcher cannot catch an
arbitrary secret in arbitrary output, and calling it protection is how someone
publishes a log to a wider audience believing it is clean.

### 5. Where the publisher lives

Alongside `BoardSnapshotPublisher`, constructed inside `KanbanDatabase` creation
(`KanbanDatabase.ts:1319`) — the reason that publisher has never diverged between
hosts. **No new composition-root seam.**

It **reads log files from disk** rather than subscribing to the writer: the writer
runs in the pty child (`ptyHost.ts:53`), which has no git credentials, no database,
and no business acquiring either — and keeping it a pure sink is what makes both
hosts produce identical files.

Writes go through the destination's existing serialized outbound path, not a second
one. With mirror content, receipts, and now status and tails, one lock.

### Migration

Two config keys, one Archive table. `.switchboard/logs/` stays gitignored, local
files unmodified, both halves off until configured. Nothing shipped is
reinterpreted.

## Verification Plan

1. **Off by default** — no log file read and no write to any destination until
   configured (spy on both).
2. **Archive on close** — a closed session lands one row with plan, terminal, CLI,
   session, byte count and content; an in-flight session lands none.
3. **Query, not grep** — assert retrieval by plan id, by CLI, by time range, and by
   a content substring. This is the claim that distinguishes this from a directory.
4. **No board read path touches Archive** — assert by source text, so the
   load-bearing rule topology decision 2 turns on stays true.
5. **Tier safety of `status.json`** — assert it contains **no** terminal name, CLI
   name, filesystem path, or output, and that it is a sibling file rather than a
   field in `board.json`. Run `git-carried-shared-board-state.md`'s tier-leakage
   contract test and assert it still passes with status publishing on. This is the
   invariant this plan came closest to breaking.
6. **Status answers the question** — an idle session reports rising
   `idleSeconds`; an active one reports recent `lastActivityAt`. A remote reader
   distinguishes moving from wedged using only `status.json`.
7. **Tails are opt-in and bounded** — off by default; on, a 5 MiB log publishes
   ≤64 KB containing the *end* of the file. Assert the published size.
8. **Redaction** — every pattern removed with a marker present; the **local file
   unchanged**; and one negative case where an unguessable secret survives, so the
   documented limit is demonstrated rather than claimed.
9. **Cadence** — nothing publishes on the flush interval; publishing is debounced
   to the destination's outbound cadence.
10. **Retention** — log rows rotate on their own window, independently of the event
    tables' window, and the size-reporting surface includes them.
11. **Code repo untouched** — run with the checkout dirty; branch, index and files
    unchanged, and the logs gitignore contract test still passes.
12. **Cloud-agent status check, end to end** — dispatch a card, then from a clone
    with no extension: read `status.json`, see the card active, watch
    `idleSeconds` climb when the agent stalls. Then with tails enabled, read the
    tail and see current output.
13. **Both hosts** — publish under the extension host and the standalone host;
    assert identical rows and identical payloads.

### Goal Invariants

- Logs live in the store whose stated character matches them, at a location
  derived from the one operator choice — no new placement exists.
- What happened is queryable by plan, CLI, terminal, time and content.
- Whether a card is moving is answerable without any Runtime-tier data leaving the
  machine.
- Runtime-tier data leaves only behind an explicit opt-in that names itself as an
  exception.
- The local log files are never modified by publishing.
- Redaction is described as reduction, never as protection.
- No board render path depends on Archive.
