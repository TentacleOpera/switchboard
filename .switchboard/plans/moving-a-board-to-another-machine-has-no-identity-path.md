# Moving a Board to Another Machine Has No Identity Path

## Goal

A board can be moved to another machine deliberately, with one command, and the move either
completes with the same identity or fails loudly — it never half-succeeds into a new, empty board
that looks like data loss.

### The problem, and the root cause

**The workspace id is host state with no transfer path.** `resolveCanonicalWorkspaceId`
(`src/services/WorkspaceIdentityService.ts:212`) has exactly three rungs:

1. `.switchboard/workspace-id` line 1 — `source: 'committed_file'`
2. `.switchboard/workspace_identity.json` — `source: 'legacy_json'`
3. `sha256(resolvedRoot).slice(0, 12)` — `source: 'hash_fallback'`

Rung 3 is a **generator**, not a lookup. It cannot fail, it needs no coordination, and it answers
instantly. So a host that has not been given an id does not report a missing one — it mints a
plausible one and proceeds to serve an empty board at
`~/.switchboard/boards/<new-id>.db`.

**This has already happened three times.** `~/.switchboard/boards/` on the Pi holds
`6c88e6aeb0dc.db`, `d0b531c5ec74.db` and `f946ef55362a.db` — all 409,600 bytes, all zero active
plans, all dated 2026-09-15 — beside the real board
`038bffef-9842-4574-96a1-69a43a280b3c.db` at 13.7 MB with 649 active plans. Twelve hex characters
is the exact shape of `sha256(root).slice(0,12)`. Three hosts booted, found no id, generated one,
created a schema-only database and served it.

**Nothing in the product moves identity.** The CLI surface has no `adopt`, no `--workspace-id`, and
`SWITCHBOARD_WORKSPACE` is a workspace *path*, not an id (`cli.ts:4804`, where it is read only as a
legacy host-settings override). `export`/`import` move a transfer bundle, and
`TransferBundleService.ts:419` sets `sourceWorkspaceName: path.basename(root)` — the **directory
basename**, not the workspace id. The bundle carries cards and settings; it does not carry, and
cannot restore, the identity that names the board.

**So the move is a manual multi-file operation that nothing documents or verifies.** The id keys more
than one file. `storageTopology.ts` places the board at `~/.switchboard/boards/<workspace-id>.db`
(`:63`), the archive at `<workspace-id>-archive.db` (`:72`) and the per-machine runtime at
`<workspace-id>.runtime.db` (`:54`), and SQLite adds `-shm`/`-wal` sidecars — the Pi currently has a
4.1 MB WAL. An operator moving a board by hand must know which of those travel (board, archive),
which must not (runtime, which is explicitly per-machine and disposable), and that copying a `.db`
without checkpointing its WAL can leave committed rows behind.

**Why this is newly exposed.** `.switchboard/workspace-id` was untracked in `2d1e142a` — correct,
because a committed id routes every other machine at a board that is not theirs, and the regression
suite already calls the file machine-local. But tracking it was also the only thing that had ever
carried identity between machines, by accident. Removing the accident leaves the gap visible with
nothing behind it, and the Pi 400 → Pi 5 move is the first time it will be walked deliberately.

### Root cause

Identity resolution has a **generating** bottom rung on a read that is configuration. `CLAUDE.md`
names this shape directly: a default that behaves exactly like a configured value turns a loud
failure into a quiet wrong answer. `hash_fallback` is tagged in the return value, which satisfies the
letter of the rule, but the tag is never surfaced anywhere an operator sees it — so in practice
"this host was given an identity" and "this host invented one thirty seconds ago" are the same
observable state: a board that opens and is empty.

## Non-goals

- **Relocating boards.** `~/.switchboard/boards/<workspace-id>.db` stays where it is.
- **Removing the hash fallback.** A genuinely new workspace must still be able to start without
  ceremony. This plan makes the fallback *visible*, not absent.
- **Syncing two live boards.** One store, one host. This is a move, not replication.
- **Changing the kanban schema.**

## Metadata

**Tags:** reliability, cli, storage, operability
**Complexity:** 4

## Scope: standalone only

`src/standalone/cli.ts`, `src/services/WorkspaceIdentityService.ts`,
`src/services/storageTopology.ts` and a new export/import arm in
`src/services/TransferBundleService.ts`. The VS Code extension host is out of scope — it is the
legacy host being removed by the cutover, and wiring a new seam there is throwaway work. Per
`CLAUDE.md` this is the intended state, not a divergence: the seam is new, so it lands in the
standalone root only.

## Proposed changes

### 1. `switchboard identity` — say who this host thinks it is, and how it knows

A read-only command printing the resolved id **and its source**, because the whole failure mode is
that those two are indistinguishable today.

```
$ switchboard identity
workspace: /home/patrick/switchboard
id:        038bffef-9842-4574-96a1-69a43a280b3c
source:    committed_file (.switchboard/workspace-id line 1)
board:     ~/.switchboard/boards/038bffef-….db  (13.7 MB, 649 plans)
```

On a host that generated its own, the same command must make that the loudest line in the output —
`source: hash_fallback (derived from the workspace path; this host was never given an identity)` —
and report the board as newly created rather than found.

### 2. `switchboard identity adopt <id>` — the missing write path

Writes line 1 of `.switchboard/workspace-id`. Refuses when:

- an id is already present and differs, unless `--force` (adopting over a live identity orphans the
  board that identity names)
- no board exists at `~/.switchboard/boards/<id>.db` **and** `--expect-empty` was not passed, so the
  common typo fails instead of silently arming a hash-fallback boot on next start

### 3. Carry identity in the transfer bundle, as data rather than destiny

Add `sourceWorkspaceId` beside the existing `sourceWorkspaceName` in the bundle schema (bump
`schema` to 2). `import` does **not** apply it automatically — it prints it and requires
`--adopt-identity` to write it. An import that silently reassigned the destination's identity would
be a worse bug than the one this plan fixes.

Read path must accept `schema: 1` bundles, which have no `sourceWorkspaceId`, and say so rather than
treating the absence as a mismatch.

### 4. Make the move one command: `switchboard board move --to <host>`

Composes what an operator currently does by hand and gets wrong:

- **checkpoint the WAL before copying.** The Pi's board carries a 4.1 MB `-wal` right now; copying
  the `.db` alone loses every row in it. `PRAGMA wal_checkpoint(TRUNCATE)` first, then copy.
- **move what is keyed by the id, and only that**: the board and, when present, the archive
  (`<id>-archive.db`). Never `<id>.runtime.db` — `storageTopology.ts:54` declares it per-machine and
  disposable, and carrying it to another host is how a stale runtime outlives the machine it
  described.
- **adopt the identity on the destination** via change 2.
- **verify before declaring success**: destination resolves `source: committed_file`, the board opens,
  and the active plan count matches the source. A move that cannot prove the count matches fails and
  says which number it got.

### 5. Warn once at boot when identity was generated

`bootstrap.ts` already logs resolution decisions. When `resolveCanonicalWorkspaceId` returns
`hash_fallback` **and** the board file it implies did not exist before this boot, log a single
explicit line naming the generated id, the path it was derived from, and `switchboard identity adopt`
as the fix. This is the line that would have made the three empty boards self-evident on 2026-09-15
instead of a discovery three days later.

## Complexity Audit

### Routine

- `switchboard identity` read command (change 1) — the resolver already returns `{value, source}`.
- Bundle schema field and the `schema: 1` compatibility arm (change 3).
- The boot warning (change 5).

### Complex / Risky

- **`adopt` writes shipped state.** `.switchboard/workspace-id` exists in released versions, so the
  write archives the prior file as `workspace-id.migrated.bak` and is atomic (temp file + rename).
  A reader mid-write must get the old file or the new one, never a partial.
- **`board move` copies a live database.** The source board is being written by a running host —
  649 plans and a 4.1 MB WAL as of writing. The move must either stop the source host or take a
  proper SQLite backup; a plain `cp` of a live database with an un-checkpointed WAL is the
  data-loss path this change exists to prevent.
- **`--force` on adopt orphans a board.** It must name the id being displaced and the file that will
  stop being reachable, not just proceed.

## Edge-Case & Dependency Audit

- **Two checkouts at the same absolute path on different machines derive the same id.** The Pi and
  the Dell both check out at `/home/patrick/switchboard`, so both hash to `cc96cdf02a04`. That is a
  path collision, not synchronisation: two hosts, one id, two unrelated database files. `identity`
  must therefore print the resolved *file path* alongside the id, or the output invites exactly the
  wrong conclusion.
- **Destination already has a board at that id.** Refuse. Overwriting is never the safe default, and
  the operator can delete deliberately.
- **Interrupted move.** The destination must not be left with an adopted identity and no board — that
  is precisely a hash-fallback-shaped empty board with a legitimate-looking id. Adopt identity
  **last**, after the board is in place and verified.
- **Partial state on disk.** `-shm`/`-wal` sidecars must never be copied as if they were the board;
  after a `TRUNCATE` checkpoint they are empty and need not travel at all.
- **Security.** `adopt` writes a value into a file the resolver trusts as priority 1. Validate against
  `isValidCanonicalId` (`WorkspaceIdentityService.ts:165`), which already rejects path separators,
  `..` and NULs — an id is used to build a filename.

## Dependencies

None. This does not gate on, and is not gated by, the remote-seat work in
`a-remote-seat-reaches-the-board-over-http-not-a-tunnel.md`, though both are motivated by the same
Pi 400 → Pi 5 move.

## Adversarial Synthesis

Key risks: (1) adding `sourceWorkspaceId` to the bundle and applying it on import would make every
import silently reassign the destination's identity — strictly worse than the current gap, hence
`--adopt-identity` being explicit and off by default; (2) a `board move` that copies a live `.db`
without checkpointing looks like it works and loses the WAL, which on this board is currently 4.1 MB;
(3) deleting the hash fallback to "fix" the root cause would stop new workspaces from starting at
all — the fallback is correct behaviour that is merely silent, so the fix is visibility, not removal;
(4) adopting identity before the board is in place converts an interrupted move into exactly the
failure being fixed, so ordering is load-bearing, not stylistic.

## Verification

- **Unit** — `identity` on a host with a committed file reports `source: committed_file`; with the
  file removed and no legacy JSON, reports `hash_fallback` and names the derived id. Both assert on
  the printed source string, since the source being invisible is the bug.
- **Unit (adopt)** — writes line 1; archives the prior file as `workspace-id.migrated.bak`; refuses a
  differing existing id without `--force`; rejects an id failing `isValidCanonicalId`.
- **Contract** — a `schema: 1` bundle (no `sourceWorkspaceId`) imports without error and reports the
  field as absent, not mismatched.
- **Contract (move)** — seed a source board with N plans and an un-checkpointed WAL holding some of
  them; move; assert the destination reports N, proving the checkpoint ran. This fails against a
  naive `cp`.
- **Contract (interrupted move)** — kill the move after the board copy and before adoption; assert the
  destination does **not** resolve the adopted id, and that a subsequent boot does not create a
  second board.
- **Regression** — after a move, `~/.switchboard/boards/` on the destination contains no
  `<id>.runtime.db` copied from the source.

Run `npm run compile-tests` before any `test:contract:*` script.

## Goal Invariants

1. A host that generated its own identity is distinguishable from one that was given it, in output an
   operator actually sees.
2. No command creates a board as a side effect of failing to find one.
3. Identity is adopted only after the board it names is present and verified.
4. A move either matches the source's plan count or fails naming both numbers.
