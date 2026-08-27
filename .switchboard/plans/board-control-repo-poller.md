# Switchboard watches a private control repo and fires the instructions it finds

## Goal

Watch a **separate private repository** for new commits, read any new instruction
files from it, hand each to the executor, and publish the receipts — so a cloud
agent that pushes a filled template gets board actions applied on the user's
machine and can read what happened.

### Problem Analysis

**Access, not history, is what has to be isolated.** An earlier draft of this plan
put instructions on an orphan branch of the code repo. That was wrong for the same
reason the board snapshot was wrong there (`board-state-moves-to-a-private-repo.md`):
a branch is not an access boundary. Read and write on a repo are repo-wide, so
every code-repo collaborator and every CI token with `contents: write` could file
instructions — and a filed instruction moves someone's cards. A repository is the
unit GitHub permissions, so the channel gets its own.

**A dedicated repo also lets the control channel have exactly one writer: the
agent.** Receipts go to the **state** repo, whose sole writer is the user's
machine. The machine therefore needs only **read** access to the control repo, and
the agent needs only **read** on state. Beyond least privilege, this removes an
entire class of failure: with one writer, no push is ever rejected as
non-fast-forward, so there is no fetch-rebase-retry loop on either side. It also
means a compromised agent credential can file instructions but cannot fabricate a
receipt claiming one was applied.

**Detection needs no clone.** `git ls-remote <controlRepo> refs/heads/main` returns
the remote SHA in one round trip and transfers no objects, so it is cheap enough
for a short timer. Fetch only when the SHA differs from the stored cursor.
`RemoteControlService` already establishes the timer pattern here (`:425`).

**And the user's checkout must never be involved.** The state-repo plan replaces
the publisher's worktree dance with a cached clone under `.switchboard/`; this
plan does the same for the control repo. The code repository is not touched by
either channel — no worktree, no ref, no index — which is not negotiable in a
feature that runs on a timer while someone is working.

### Root Cause

The board's remote channel was one-directional by design. Adding the other
direction is a second channel, with its own audience, and therefore its own repo.

### Non-goals

- **Instruction semantics, validation, and the action allowlist** —
  `board-control-instruction-format-and-executor.md`.
- **Publishing board state** — `board-state-moves-to-a-private-repo.md`, which
  also owns the state repo's clone cache and write path.
- **Webhooks or any inbound listener.** Polling only: no port is opened, and the
  localhost bind of the API server is untouched.
- **Watching code branches, merges, or PRs.** This watches one repo. A merge
  watcher is a different feature.
- **Creating the repository, or handling any credential.** The user creates the
  private repo and supplies its URL; git uses the credentials it already has.
- **Touching the user's working tree, index, or current branch.** Ever.
- **On by default.**
- **Confirm gates.** Per project rule, none.

## Metadata

**Complexity:** 7
**Tags:** feature, backend, devops, reliability, security
**Feature:** 2440474a-cbe2-4876-b65d-3ccffd000aa3

## Dependencies

- `board-control-instruction-format-and-executor.md` — this delivers files to that
  executor.
- `board-state-moves-to-a-private-repo.md` — receipts are written through that
  plan's serialized `withStateRepo` helper, not through a second clone of the
  state repo.

## Proposed Changes

### 1. Opt-in, and what enabling it means

Off unless configured. Config keys alongside the state-repo ones:
`boardControl.enabled` and `boardControl.repo` (the private control repo's URL).
**Never auto-enable, and never infer a repo URL** from the code repo's remote —
inferring it is how a channel switches itself on.

The setup UI and docs state the trust consequence in one sentence, because it is
the security model:

> Anyone who can push to this repository can move your cards.

With a dedicated private repo that sentence names a set the user chose — the
collaborators they added — rather than everyone with code access plus every CI
token in the org. That is the whole point of the split, and it is why signed
commits are now *optional* hardening rather than the primary defence. Signing
remains worth adding for anyone who wants trust pinned to a key rather than to
repo membership; it is deliberately not a prerequisite.

### 2. `src/services/BoardControlWatcher.ts`

Constructed alongside `BoardSnapshotPublisher` inside `KanbanDatabase` creation
(`KanbanDatabase.ts:1319`) — the reason that publisher has never diverged between
hosts. **No new composition-root seam**; do not wire this in `extension.ts` or
`bootstrap.ts`.

**Poll cycle:**

1. If disabled, return. Cheap and first — this runs on a timer forever.
2. `git ls-remote <controlRepo> refs/heads/main` → remote SHA. An unreachable
   host, missing repo, or absent branch is a quiet state, logged once per
   transition, not re-reported every cycle.
3. If the SHA equals the stored cursor, stop. The common case, at one round trip.
4. Fetch into the cached control clone under `.switchboard/board-control-repo/`
   (git-ignored), created with `--depth 1` on first use.
5. Read `instructions/*.json`, oldest-first by path sort for determinism.
6. Hand each to the executor. It owns duplicate suppression, so re-reading is safe
   by construction — the cursor is an optimisation, never the correctness
   mechanism.
7. Write each receipt to `receipts/<id>.json` in the **state** repo, via the
   state-repo plan's serialized helper.
8. Store the new cursor **after** receipts are published, so a crash re-processes
   (and the executor deduplicates) rather than losing an instruction.

**Single-flight and debounce**, copying the publisher's `_inFlight` / `_pending`
pair (`:49-51`). A poll starting while one is running must not open a second clone
of the same repo.

**Interval:** default 60 s, configurable, floor of 15 s. `ls-remote` is one round
trip, but it is still a network call on someone's machine — a 1 s floor invites a
config that hammers a remote all day.

**Read-only against control.** The watcher never pushes to the control repo, never
deletes a processed instruction, and never writes to it in any way. Deletion is
the agent's business if it wants housekeeping; the executor's duplicate
suppression is what makes leaving files in place safe. This keeps the one-writer
invariant true rather than aspirational.

**Publish failure is not instruction failure.** If actions applied but the receipt
could not be published, the actions **stay applied** — they are already done — the
cursor is not advanced, and the next cycle re-reads, gets `duplicate` from the
executor, and retries only the publish. Rolling a board action back to match a
failed publish would be strictly worse.

### 3. Surfacing it

- Log every cycle that does anything (SHA, instructions seen, statuses) to the
  existing output channel. The first question will always be "did it see my push",
  and a silent channel cannot answer it.
- Show last-poll time, last SHA, and the last few instruction statuses in Setup
  beside the enable toggle. A remote author's mistakes land here and nowhere else.
- Never notify per instruction. On a timer, that is a notification storm.

### Migration

Two config keys and a cursor in existing tables, plus a git-ignored cache
directory. Nothing shipped is reinterpreted. Disabled default means an upgraded
install behaves identically until someone turns it on.

## Verification Plan

1. **No-op path** — disabled → no git command runs at all (spy the invoker).
   Enabled with an unreachable repo → quiet, logged once, no repeated noise.
2. **Detection** — unchanged SHA → `ls-remote` only, no fetch, no clone update.
   Changed SHA → fetch and process.
3. **The code repo is untouched** — run a cycle with the user's checkout dirty on a
   feature branch. Assert branch, index, and working-tree contents byte-identical;
   assert no ref in the code repo created or updated; assert `git worktree list` on
   the code repo unchanged, including after a forced mid-cycle throw.
4. **Control repo is never written** — assert no `push`, `commit`, or file write
   targets the control clone on any path, including error paths. This is the
   one-writer invariant and it is easy to break with a "helpful" cleanup commit.
5. **Receipts go to the state repo** — through the shared serialized helper, and a
   concurrent snapshot publish does not corrupt either result.
6. **Force-push resilience** — force-push the control repo with the same
   instruction id; assert `duplicate` and that nothing re-fires. Then rewrite with
   a *new* id; assert it fires.
7. **Crash between apply and publish** — kill after actions apply, before the
   receipt publishes. Assert the cursor did not advance, the next cycle re-reads,
   gets `duplicate`, and publishes the receipt without re-firing.
8. **Publish failure** — make the receipt publish fail; assert actions stay
   applied, cursor unadvanced, next cycle recovers.
9. **Single-flight** — trigger two cycles concurrently; assert one clone operation.
10. **Both hosts** — enable under the extension host and the standalone host and
    run one instruction end to end in each, proving the no-new-seam claim by
    running it.

### Goal Invariants

- Who can command the board is decided by the control repo's collaborator list,
  not by code-repo access and not by any CI token.
- The control repo has exactly one writer, and it is not this machine.
- The user's code checkout, branch, and index are never touched, on any path.
- Nothing runs until a user enables it and supplies a repo URL.
- An instruction is applied at most once, regardless of force-push, re-clone, or
  crash.
- An applied action is never rolled back because a receipt could not be published.
