# Board state publishes to a private repo of its own, not a branch of the code repo

## Goal

Move the board snapshot off the `switchboard/board` orphan branch in the code
repository and into a **separate private repository** whose only writer is the
user's machine — so that access to board state is governed by its own repo
permissions rather than inherited from whoever can push code.

### Problem Analysis

**Today the snapshot lives in the code repo, so its audience is the code repo's
audience.** `BoardSnapshotPublisher` writes `board.json` / `board.md` /
`board.html` to the orphan ref `switchboard/board` (`BoardSnapshotPublisher.ts:10`)
and force-pushes it to `origin` (`:381`). A branch is not an access boundary:
every collaborator on the code repo can read it, and — more importantly — every
CI job, GitHub App, and automation token with `contents: read` on that repo can
too. Nobody granting a contributor push access is thinking "and they may read my
board".

**A branch cannot be permissioned the way the risk requires.** Push rulesets can
restrict *writes* to a ref pattern, but read access on a repo is repo-wide: there
is no way to say "collaborators may read code and not `switchboard/board`". The
boundary the situation needs is a repository, because that is the unit GitHub
actually permissions.

**The same move closes the token problem.** A separate private repo is outside the
code repo's CI scope, so no workflow token, dependency, or Action in the code repo
can reach it — which is the largest hole in the branch design and the one hardest
to notice, because those tokens do not look like people with access.

**And it simplifies the inbound channel's trust model.** The sibling control plans
were headed for signed commits verified against a key allowlist, in order to
narrow "anyone who can push to the repo" down to "the specific key holder".
A dedicated private repo with one or two collaborators achieves most of that
narrowing structurally, so signing becomes optional hardening rather than the
primary defence.

**One writer per repo is now achievable, and worth taking.** The publisher's
existing invariant is *"Sole writer is the extension"* (`:38`). With two separate
repos, that invariant can hold for real:

| Repo | Sole writer | The other party |
|---|---|---|
| board **state** | the user's machine | cloud agents get **read-only** |
| board **control** | the cloud agent | the user's machine gets **read-only** |

That is why **receipts belong in the state repo, not the control repo** — it keeps
each repo single-writer, so the inbound channel never needs write access from the
machine and the outbound channel never needs write access from an agent. A
compromised agent credential can then file instructions and cannot rewrite
published board state or fabricate a receipt saying its instruction was applied.

### Root Cause

The snapshot was isolated from the code *branches* — which was the right instinct
about not polluting history — but isolation of history is not isolation of access,
and the ref stayed inside the repo whose permissions it inherits.

### Non-goals

- **Creating the repositories.** The user creates two private repos and supplies
  their URLs. Switchboard handles no GitHub credentials, calls no provider API,
  and never creates a repo on someone's behalf.
- **Deleting the old `switchboard/board` ref from anyone's remote.** See the
  migration below — offered, never automatic.
- **Changing the snapshot's contents or format.** `board.json` / `board.md` /
  `board.html` and the `BoardSnapshot` schema are unchanged.
- **Making the snapshot on-by-default.** It stays opt-in.
- **Confirm gates.** Per project rule, none.

## Metadata

**Complexity:** 6
**Tags:** feature, backend, security, devops, infrastructure
**Feature:** 2440474a-cbe2-4876-b65d-3ccffd000aa3

## Dependencies

None. The control plans depend on this one's config surface and on the
receipts-in-the-state-repo decision, so ship this first.

## Proposed Changes

### 1. Configuration — a repo URL, and no silent fallback

The existing opt-in is the setting `switchboard.boardStateExport`, compared against
`BOARD_SNAPSHOT_MODE` (`'read-only-snapshot'`) at `KanbanDatabase.ts:9309-9314`.
**That setting and its value ship today and must keep working** — an install that
has it set must not be broken or silently reinterpreted.

Add `switchboard.boardStateRepo`: the remote URL of the private state repo. Then:

- mode `'read-only-snapshot'` **and** a repo URL set → publish to that repo;
- mode set, **no** repo URL → **publish nothing**, and surface a one-time
  actionable notice naming the setting to fill in.

The second case is the load-bearing one. Falling back to the old branch would mean
every existing opted-in install keeps publishing to the code repo after upgrading
to the release that was supposed to stop doing that — the fix would ship and
change nothing. Stopping is the correct failure: the snapshot is a convenience,
and the alternative is continuing an unintended disclosure.

`BOARD_SNAPSHOT_REF` becomes the branch **within** the state repo (`main`), not a
ref in the code repo.

### 2. `BoardSnapshotPublisher` — publish to a remote it does not have a checkout of

The current mechanism assumes the target ref lives in the local repo: it adds a
worktree for `switchboard/board`, commits, and force-pushes to `origin`
(`:310-390`). With a separate repo there is no local ref, so replace the
worktree-of-a-local-ref step with a **cached bare-ish clone** of the state repo
under `.switchboard/board-state-repo/` (git-ignored):

1. first run: `git clone --depth 1 <repoUrl> <cacheDir>`;
2. later runs: `git -C <cacheDir> fetch --depth 1 origin main` and reset to it;
3. write the three snapshot files, `git add`, commit;
4. `git push origin HEAD:main`.

Keep, unchanged in spirit, the properties that make the current publisher safe:
`_lastPublishedHash` content-skip, the 500 ms debounce, `_inFlight` / `_pending`
single-flight (`:49-52`), and cleanup in a `finally`. And keep the strongest one
explicitly: **the user's checkout, branch, and index are never touched.** A
separate clone directory makes that easier than the worktree dance did — the code
repo is not involved at all.

**Stop force-pushing.** `--force` existed because an orphan branch cannot
fast-forward from `main`. In a repo whose sole writer is this machine, a normal
push works, and force would destroy accumulated receipts if the local cache were
ever stale. Handle a rejected push by fetching, re-applying the three files onto
the fetched tip, and retrying once; force-push only as a documented manual
recovery, never automatically.

**No remote, unreachable host, or bad credentials** stays a logged non-fatal
`'failed'`, as today (`:381-387`). The board must not break because a side-channel
cannot publish.

### 3. Receipts share the state repo

Reserve `receipts/<instructionId>.json` in the state repo for the control
channel's use. The publisher must therefore be additive: it stages only its three
files by name (as it already does at `:342`) and never cleans the tree, so
receipts accumulate untouched.

Both writers live on the user's machine and now target one repo, so they must
share one write path and one single-flight — a receipt push and a snapshot publish
racing on the same clone is a corrupted working tree in a cache directory nobody
looks at. Expose a small serialized `withStateRepo(fn)` helper on the publisher and
have the control poller use it rather than opening its own clone.

### Migration

The setting shipped, so this follows the project's migrate-what-shipped rule:

- **Preserve the setting and its value.** `boardStateExport: 'read-only-snapshot'`
  keeps its meaning. Do not rename it, do not repurpose it, and do not drop an
  unknown value.
- **Publishing stops until a repo URL is supplied**, with a notice that says why
  and what to set. Opted-in installs are a small population (the mode is opt-in
  and defaults to `'none'`), and a stopped side-channel is recoverable in one
  setting; a silently-continuing disclosure is not.
- **The old `switchboard/board` ref is left exactly as it is.** It holds a stale
  board snapshot on the user's remote. Deleting a ref from someone's remote is
  destructive and not ours to do unasked. Instead: detect it, tell the user it
  exists and is now stale, and offer a single action that runs
  `git push origin --delete switchboard/board`. Never on a timer, never on
  upgrade.
- **Local refs and the old worktree path** are cleaned up only if present and
  unused, and never with `--force` against anything containing user content.

## Verification Plan

1. **Config gating** — mode unset → no git command runs at all (spy the invoker).
   Mode set with no repo URL → nothing published, notice raised once, **and no
   write to `switchboard/board`** (the regression that would make this plan a
   no-op). Mode set with a URL → published to that repo.
2. **Existing setting honoured** — an install carrying
   `boardStateExport: 'read-only-snapshot'` from a previous version is recognised,
   not reset, and not silently switched to another mode.
3. **Code repo untouched** — run publishes with the user's checkout dirty on a
   feature branch. Assert branch, index, and working-tree contents are byte-
   identical; assert `git worktree list` on the code repo is unchanged; assert no
   ref in the code repo was created or updated.
4. **Sole writer, additive** — write a `receipts/x.json` into the state repo, then
   publish twice. Assert the receipt survives both, and that only the three
   snapshot files were staged.
5. **No force-push** — assert the push command contains no `--force`. Simulate a
   rejected push; assert fetch-reapply-retry, and that a receipt added remotely in
   between still exists afterwards.
6. **Serialization** — trigger a snapshot publish and a receipt write
   concurrently; assert one clone, one at a time, and both results landed.
7. **Failure is non-fatal** — unreachable host, bad credentials, and deleted cache
   dir each log and continue; the board keeps working and the next cycle recovers.
8. **Old-ref cleanup is opt-in** — assert nothing deletes `switchboard/board`
   without an explicit user action, including on upgrade and on first publish to
   the new repo.
9. **Both hosts** — publish under the extension host and the standalone host. The
   publisher is constructed inside `KanbanDatabase` creation
   (`KanbanDatabase.ts:1319`), which is why it has never diverged; prove that still
   holds by running it, not by reading the constructor.

### Goal Invariants

- Board state is readable only by whoever has access to the state repo — not by
  code-repo collaborators, and not by any token scoped to the code repo.
- The code repository is never written to by the snapshot path, on any code path.
- The state repo has exactly one writer.
- An install that opted in before this change either publishes to the new repo or
  publishes nothing — never to the old branch.
- Nothing is deleted from any remote without the user asking.
