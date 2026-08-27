# Switchboard watches a remote control branch and fires the instructions it finds

## Goal

Watch a remote orphan branch for new commits, read any new instruction files from
it, hand each to the executor, and push the receipts back — so a cloud agent that
pushes a filled template gets board actions applied on the user's machine and can
read what happened.

### Problem Analysis

**The outbound half already exists, and it force-pushes.**
`BoardSnapshotPublisher` publishes `board.json` / `board.md` / `board.html` to the
orphan branch `switchboard/board` (`BoardSnapshotPublisher.ts:10`), and its final
step is `git push --force origin switchboard/board` (`:381`). Its header states
the invariants: *"Sole writer is the extension; always overwrite; no diff-ingest,
no control."*

**That settles the branch question, and not by preference.** Instructions cannot
live on `switchboard/board`: the next snapshot publish force-pushes over them, so
every instruction the cloud agent pushed between two publishes is destroyed —
silently, since a force-push reports success. The debounce is 500 ms
(`:52`), so the window is not even wide. Control therefore gets its **own** orphan
branch, `switchboard/board-control`, and the snapshot branch keeps its sole-writer
invariant untouched.

Two further reasons the split is right rather than merely safe: the snapshot's
content-stable hash-skip (`_lastPublishedHash`) assumes one writer, so a second
one makes "unchanged" wrong; and the two refs point opposite ways — one discloses
board state, the other commands it. A ref that does both is a ref where read
access and write access are easy to confuse.

**Detection does not require a fetch.** `git ls-remote origin
refs/heads/switchboard/board-control` returns the remote SHA in one round trip and
transfers no objects, so it is cheap enough to poll on a short timer. Fetch only
when the SHA differs from the stored cursor. `RemoteControlService` already
establishes the timer pattern in this codebase (`:425`).

**And the working tree must never be involved.** The publisher solved this: a temp
dir plus `git worktree add` for the orphan ref, commit there, push, then
`git worktree remove --force` in a `finally` with a manual-`rm` + `worktree prune`
fallback (`:389-403`). Reading and receipt-writing reuse that shape exactly. The
user's checkout, branch, and index are never touched — this is not negotiable in a
feature that runs on a timer while someone is working.

### Root Cause

The board's remote channel was built one-directional on purpose. Adding the other
direction is not a modification of that channel but a second one, and conflating
them would destroy data by force-push.

### Non-goals

- **Instruction semantics, validation, and the action allowlist.** All in
  `board-control-instruction-format-and-executor.md`.
- **Changing `switchboard/board` or `BoardSnapshotPublisher` in any way.**
- **Webhooks or any inbound network listener.** Polling only: no port is opened,
  and nothing about the localhost bind changes.
- **Watching code branches, merges, or PRs.** This watches one control ref. A
  merge watcher is a different feature.
- **Touching the user's working tree, index, or current branch.** Ever.
- **On by default.** See the opt-in below.
- **Confirm gates.** Per project rule, none.

## Metadata

**Complexity:** 7
**Tags:** feature, backend, devops, reliability, security

## Dependencies

Blocked on `board-control-instruction-format-and-executor.md` — this plan
delivers files to that executor and stores its receipts.

## Proposed Changes

### 1. Opt-in, and what enabling it means

Off unless explicitly configured. Three config keys in the `config` table
(`boardControl.enabled`, `boardControl.remote`, `boardControl.branch`), defaulting
to disabled / `origin` / `switchboard/board-control`. **Never auto-enable on
finding the branch**, and never infer the remote.

The setup UI and the docs must state the trust consequence in one plain sentence,
because it is the whole security model:

> Anyone who can push to this branch can move your cards.

The HTTP API is gated by a localhost bind and a token; this channel is gated by
git push access to one branch of one repo. That is a deliberate trade — it is the
only way a cloud agent can reach the board — and it is why the feature is opt-in,
why the action set is a closed allowlist, and why dispatch is excluded from v1.

For ~4,000 installs, a feature that executes instructions from a branch must be
something the user turned on knowingly, not something a stale branch name switches
on for them.

### 2. `src/services/BoardControlWatcher.ts`

Constructed alongside `BoardSnapshotPublisher` inside `KanbanDatabase` creation
(`KanbanDatabase.ts:1319`) — the reason that publisher has never diverged between
hosts. **No new composition-root seam**; do not wire this in `extension.ts` or
`bootstrap.ts`.

**Poll cycle:**

1. If disabled, return. (Cheap and first — this runs on a timer forever.)
2. `git ls-remote <remote> refs/heads/<branch>` → remote SHA. No ref, or no such
   remote, is a normal quiet state, not an error to surface repeatedly.
3. If the SHA equals the stored cursor, stop. This is the common case and costs one
   round trip.
4. Fetch the ref into a temp worktree using the publisher's pattern.
5. Read `instructions/*.json`, oldest-first by path sort for determinism.
6. Hand each to the executor. It owns duplicate suppression, so re-reading an
   instruction is safe by construction — a cursor is an optimisation here, never
   the correctness mechanism.
7. Write each receipt to `receipts/<id>.json` in the worktree, commit, push.
8. Store the new cursor **after** receipts are pushed, so a crash re-processes
   (and the executor deduplicates) rather than losing an instruction.
9. Remove the worktree in a `finally`, with the publisher's fallback cleanup.

**Single-flight and debounce**, copying the publisher's `_inFlight` / `_pending`
pair (`:49-51`). A poll while a poll is running must not start a second worktree
against the same ref.

**Interval:** default 60 s, configurable, floor of 15 s. `ls-remote` is one round
trip, but it is a network call on someone's machine — a 1 s floor invites a
config that hammers a remote all day.

**Push failure is not instruction failure.** If actions applied but the receipt
push failed, the actions **stay applied** — they are already done — the cursor is
not advanced, and the next cycle re-reads, gets `duplicate` from the executor, and
retries only the push. Rolling back a board action to match a failed push would be
strictly worse.

### 3. Surfacing it

- Log every cycle that does anything (fetched SHA, instructions seen, statuses) to
  the existing output channel. A silent channel is undiagnosable, and the first
  question will always be "did it see my push".
- Show last-poll time, last SHA, and the last few instruction statuses in the
  Setup surface next to the enable toggle. A remote author's mistakes land here
  and nowhere else.
- Never notify per instruction. On a timer, that is a notification storm.

### Migration

Three config keys and a cursor value in existing tables. No new table beyond the
executor plan's processed-ids store. Disabled default means an upgraded install
behaves identically until someone turns it on.

## Verification Plan

1. **No-op path** — disabled → no git command runs at all (spy on the git
   invoker). Enabled with no such remote ref → quiet, no repeated error noise.
2. **Detection** — unchanged SHA → `ls-remote` only, no fetch, no worktree.
   Changed SHA → fetch and process.
3. **Working tree untouched** — run a cycle with the user's checkout dirty on a
   feature branch; assert branch, index, and working-tree contents are byte-
   identical afterwards, and that no worktree is left behind (assert
   `git worktree list` is back to its prior state, including after a forced
   mid-cycle throw).
4. **The snapshot branch is untouched** — run a cycle and a snapshot publish
   interleaved; assert `switchboard/board` still has only the publisher's commits
   and the control branch only the watcher's receipts. This is the regression that
   would silently destroy data.
5. **Force-push resilience** — force-push the control branch with the same
   instruction id; assert the executor returns `duplicate` and nothing re-fires.
   Then rewrite history with a *new* id; assert it fires.
6. **Crash between apply and push** — kill after actions apply, before the receipt
   push; assert the cursor did not advance, the next cycle re-reads, gets
   `duplicate`, and pushes the receipt without re-firing.
7. **Push failure** — make push fail; assert actions stay applied, cursor
   unadvanced, and the next cycle recovers.
8. **Single-flight** — trigger two cycles concurrently; assert one worktree.
9. **Both hosts** — enable it under the extension host and the standalone host and
   run one instruction end to end in each. The no-new-seam claim is proven by
   running it, not by reading the constructor.

### Goal Invariants

- The user's checkout, branch, and index are never touched, on any path including
  failures.
- `switchboard/board` keeps its sole writer.
- Nothing runs until a user enables it and names the remote and branch.
- An instruction is applied at most once, regardless of force-push, re-clone, or
  crash.
- An applied action is never rolled back because a receipt could not be published.
