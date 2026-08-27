# Terminal logs live in the logs sibling, with an index; status publishes with the board

## Goal

Put terminal logs in the `-logs` sibling with an index that makes them findable,
and publish a small Runtime-safe status alongside board state so a remote agent can
tell whether a card is moving.

### Problem Analysis

**The canonical layout answers the storage question, and simplifies it.**
`canonical-control-plane-layout-with-sibling-repos.md` gives logs a home:
`<controlPlaneRoot>/<repo>-logs`, *"a plain folder, or a repo"*. Two consequences
fall straight out, and both remove work this plan previously carried:

- **The Archive-store question no longer applies to logs.** An earlier draft put
  them in the topology plan's Archive store and was therefore blocked on its open
  DuckDB decision. Logs are files. A folder holds them, and the naming plan makes
  each one addressable. **That blocker is gone.**
- **Retention becomes deleting files.** A plain folder has no history, so long
  retention costs disk and nothing else, and pruning is `rm`. The earlier draft
  made logs a fifth append-only growth target for
  `retention-and-archive-for-unbounded-growth.md`; as files they are not one. That
  plan needs no amendment unless the user makes `-logs` a repo, where history is
  monotonic and its guidance does apply.

**Searchable does not require a database here.** With
`terminal-logs-are-named-for-what-they-record.md`, a filename carries terminal,
CLI, plan slug and short plan id. Glob and grep answer "the log for plan X" and
"everything the reviewer CLI did". What files cannot do is answer without a scan —
so a small index earns its place, and nothing more does. If SQL-grade querying is
wanted later, the Archive store is still available; it is not needed for this.

**Status and logs are different tiers, and the layout separates them for free.**
The storage topology plan says Runtime *"holds filesystem paths and terminal names,
and it is the store that never leaves the machine"*, and
`git-carried-shared-board-state.md` enforces it with a contract test asserting no
local-tier field appears in `board.json`.

Terminal names are Runtime tier. Log tails are full of paths. So:

- a **tier-safe status** — plan id, state, idle seconds — publishes with board
  state in `-plans`, breaking no invariant and needing no exception;
- **log tails** live in `-logs`, which is a **plain local folder by default**. They
  are readable remotely only if the user makes `-logs` a repo with a remote — which
  is an explicit act, not a config flag, so the opt-in is the layout decision
  itself.

That is a better opt-in than the one the earlier draft invented: the default
discloses nothing because the default has nowhere to disclose to.

### Root Cause

Logs were local diagnostics for someone at the machine, and the remote workflows
this codebase now supports have no equivalent. The information existed and had
nowhere to be that a remote reader could reach.

### Non-goals

- **Naming** — `terminal-logs-are-named-for-what-they-record.md`, a hard
  dependency: an unaddressable filename is no more findable in a sibling than in
  `.switchboard/logs/`.
- **The layout, the derived paths, or the setup flow** —
  `canonical-control-plane-layout-with-sibling-repos.md`.
- **A database for logs.** Files plus an index. The Archive store stays available
  and unused by this plan.
- **Parsing or summarising log content.** Verbatim after redaction.
- **Changing what the writer writes**, or its ANSI/CR handling.
- **Confirm gates.** Per project rule, none.

## Metadata

**Complexity:** 4
**Tags:** feature, backend, security, infrastructure
**Feature:** 2440474a-cbe2-4876-b65d-3ccffd000aa3

## Dependencies

- **Hard prerequisites:** `terminal-logs-are-named-for-what-they-record.md`;
  `canonical-control-plane-layout-with-sibling-repos.md` for the derived path.
- **No longer blocked** on the storage topology's DuckDB decision.

## Proposed Changes

### 1. The writer targets the derived path

`TerminalLogWriter` is constructed with a logs directory
(`bootstrap.ts:2743`, `ptyHost.ts:53`). Resolve that to
`<controlPlaneRoot>/<repo>-logs` when the sibling exists, and to
`.switchboard/logs/` when it does not — the current behaviour, unchanged for anyone
without the layout.

The writer itself does not change. It takes a directory today and keeps taking one,
which is what keeps it a pure sink with no config or DB dependency — the property
that makes both hosts produce identical files.

`.switchboard/logs/` stays gitignored, and its contract test
(`terminal-session-log-contract.test.js:438`) stays green, because nothing about
the fallback changes.

### 2. `index.json` in the logs sibling

Maintained by the machine, rewritten whole (it is small, and a merge-based index is
a conflict waiting to happen):

```json
{ "schema": 1, "updatedAt": "…",
  "logs": [ { "planId": "abc-123", "planSlug": "milestones-tab", "terminal": "coder-1",
              "cli": "claude", "sessionId": "s7k2m", "status": "closed",
              "bytes": 184320, "startedAt": "…", "endedAt": "…",
              "path": "coder-1-claude-milestones-tab-abc-123-s7k2m.md" } ] }
```

Indexed by `planId` **and** `planSlug`, for the same reason the filename carries
both: exactness for an agent, readability for a human. `status` distinguishes a
live session from a finished one.

This is the whole of the searchability layer. Everything past it — content
indexing, SQL — is available later and unnecessary now.

### 3. Retention, as file deletion

A prune pass over the sibling: drop closed logs past a count or age, oldest first,
and update the index. Defaults configurable, and per
`retention-and-archive-for-unbounded-growth.md`'s own rule — *"growth measurement
has to precede policy"* — ship the size reporting before setting a number.

**If `-logs` is a git repo**, say plainly that pruning the tree does not shrink
history, and that the mitigation is a documented re-init rather than automated
history rewriting. That is the cost of choosing to share logs, and it belongs at
the point where the user chooses.

### 4. Status, with board state

`status.json` beside `board.json` at the board-state destination:

```json
{ "schema": 1, "updatedAt": "…",
  "cards": [ { "planId": "abc-123", "state": "active",
               "lastActivityAt": "…", "idleSeconds": 45 } ] }
```

No terminal name, no CLI, no path, no output. It answers the question actually
asked — *is this moving, or has it been silent for forty minutes* — and
`board.json` cannot, because a column changes only at the end of a stage.

A **sibling file, never a field in `board.json`**: that snapshot is the shared tier
and git-carried's contract test asserts no local-tier field appears in it.

Published on the destination's existing outbound cadence, never on the gateway's
flush interval (`terminalLogWriter.ts:11-14`) — a git operation on a shared timer
would stall every terminal's flush.

### 5. Redaction, when logs leave the machine

Only when `-logs` is a repo with a remote. Applied to the pushed copy, never to the
local file, which stays intact for the person at the machine.

Common credential shapes (`AKIA…`, `ghp_`/`github_pat_`, `sk-`, `xox[baprs]-`,
bearer tokens, PEM blocks, JWT triples), `KEY=`/`TOKEN=`/`SECRET=`/`PASSWORD=`
assignments, and — the highest-value one, because its shape is not guessable — any
line containing a value read from the workspace's own `.env`. Each redaction leaves
a visible marker.

**Described as reduction, never as protection.** A pattern matcher cannot catch an
arbitrary secret in arbitrary output, and calling it protection is how someone
shares a log believing it is clean.

### Migration

No new store, no new table, no setting beyond the layout's own. An install without
the layout writes logs exactly where it writes them today. Local files are never
modified.

## Verification Plan

1. **Path resolution** — with the sibling present, logs land there; without it, in
   `.switchboard/logs/`, byte-identically to today. Assert the gitignore contract
   test still passes.
2. **The writer is unchanged** — assert it still takes a directory and performs no
   config or DB lookup. A source-text assertion: this is what keeps the hosts
   identical.
3. **Index** — lookup by `planId` and by `planSlug` both resolve; a plan with three
   sessions lists three entries; `status` distinguishes live from closed; the index
   survives a prune with no stale rows.
4. **Grep works** — assert a glob by plan slug and by CLI finds the expected files
   from the filename alone, with no index. The index is an optimisation, not the
   only path.
5. **Retention** — exceed count and age; oldest closed logs are deleted, live ones
   never, and the index matches the tree.
6. **Tier safety of `status.json`** — assert it contains no terminal name, CLI,
   path, or output, and is a sibling file rather than a field in `board.json`. Run
   git-carried's tier-leakage contract test with status publishing on and assert it
   passes. This is the invariant this plan came closest to breaking.
7. **Status answers the question** — an idle session reports rising `idleSeconds`;
   an active one a recent `lastActivityAt`. A remote reader distinguishes moving
   from wedged from `status.json` alone.
8. **Default discloses nothing** — with `-logs` a plain folder, assert no git
   command is run against it and no log content reaches any remote.
9. **Redaction** — with `-logs` a repo, every pattern removed with a marker, the
   **local file unchanged**, and one negative case where an unguessable secret
   survives, so the documented limit is demonstrated rather than claimed.
10. **Cadence** — nothing publishes on the flush interval.
11. **Cloud-agent status check, end to end** — dispatch a card, then from a clone of
    `-plans`: read `status.json`, see the card active, watch `idleSeconds` climb
    when the agent stalls.
12. **Both hosts** — identical files and index entries under the extension host and
    the standalone host.

### Goal Invariants

- A log is findable by plan, terminal or CLI from its filename, and by the index
  without a scan.
- Whether a card is moving is answerable with no Runtime-tier data leaving the
  machine.
- Log content leaves the machine only because the user made the logs sibling a
  repo — never because of a flag they did not set.
- The local log files are never modified by publishing.
- Retention is file deletion; no database is involved.
- Redaction is described as reduction, never as protection.
