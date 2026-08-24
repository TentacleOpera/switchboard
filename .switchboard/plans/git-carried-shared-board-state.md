# Make the orphan-branch board snapshot bidirectional, so a team that shares a repo shares a board with no infrastructure

## Goal

Turn the existing read-only board snapshot into an optional authoritative shared store: the same `board.json` on the same orphan branch, read back in as well as written out, with git's own ref semantics providing arbitration. A team that already shares a git remote gets a shared board with no account, no token, no server and no database.

### Problem Analysis

**Most of this already exists, and it was deliberately built one-directional.** `BoardSnapshotPublisher` writes `board.json`, `board.md` and `board.html` to the orphan branch `switchboard/board` (`BOARD_SNAPSHOT_REF`), gated by `switchboard.boardStateExport === 'read-only-snapshot'`. Its header states the design: "Sole writer is the extension; always overwrite; no diff-ingest, no control, no per-persist timestamp. Content-stable via SHA256 hash skip + debounce + single-flight."

**Its payload is already exactly the shared tier.** `BoardCardEntry` is `{ plan_id, topic, column, feature, project, complexity, planFile }`, plus a `features` map. That is the shared-tier projection, serialised, versioned (`schema`), and content-hashed — arrived at independently of this plan.

**The transport is a compare-and-swap primitive, which is the property that makes this a store rather than a mirror.** A non-fast-forward push rejection is a lost-write *detector*: it tells the pushing machine, definitively, that someone else's write landed first. So the arbitration loop is fetch, re-apply the local change onto the newer snapshot, push again, bounded retries. Git gives for free the one property Notion cannot supply at any price. It is worse UX than a serialising server and better correctness than last-write-wins.

**What is missing is small and specific.** Three things: reading `board.json` back in (there is no ingest path); replacing "always overwrite" with the CAS retry loop (today a second machine's push would destroy the first's); and per-machine identity in the snapshot so a machine can recognise its own writes. `board-state-remote-mirror-channels.md` already scoped the inbound half and noted the related gap that "plan files do not carry a `**Column:**` line today".

**Why this is worth having next to libSQL rather than instead of it.** Different trade: git is pull-paced (seconds to minutes, network and credentials required per sync) where libSQL is live; git conflicts surface as a retry where libSQL serialises invisibly. But git inherits the repository's existing authentication, audit and review — the team's real trust boundary — and costs nothing to adopt. For a team where people mostly move their own cards, it is the better default. For live multi-machine coordination, libSQL is.

### Root Cause

The snapshot was built to solve reading, for an audience (web-only agents) that could not write anyway. One-directional was correct for that job. The constraint was the audience's, not the mechanism's.

### Non-goals

- Committing board state to code branches. The orphan ref exists precisely so board churn never touches `main`; that stays true. The two problems `board-state-remote-mirror-channels.md` documented — a per-persist timestamp dirtying the tree, and conflicting regenerated copies in two merged PRs — must not be reintroduced.
- Moving plan or feature *bodies*. They are already committed markdown; only board state travels.
- Real-time. This is pull-paced by construction, and the panel must say so.
- Carrying the local runtime tier. Only shared state (`split-shared-board-state-from-machine-local-runtime.md`).

## Metadata

**Complexity:** 7
**Tags:** database, backend, devops, reliability, feature, infrastructure

## User Review Required

Yes — three decisions.

1. **Sync trigger.** On board change plus on fetch/focus, versus a timer. Recommendation: on local board change (debounced, as today) and on focus, plus a slow timer; never a fast poll, because each sync is a git network operation against the operator's remote.
2. **Conflict resolution granularity.** The snapshot is one file, so a CAS retry re-applies *this machine's change* onto the fetched snapshot — which requires knowing what changed locally, not just the resulting state. Recommendation: keep a small outbound intent log (card X moved to column Y at time T by device D) and replay intents onto the fetched snapshot, rather than diffing two full snapshots. Diffing cannot distinguish "I moved this card" from "I have a stale copy of someone else's move".
3. **Does this write `**Column:**` into plan markdown as well?** Recommendation: no. That puts board churn back into code branches — the exact problem the orphan ref solved. The orphan snapshot is the carrier; plan files stay as they are.

## Complexity Audit

### Routine

- An ingest path parsing `board.json` and applying the shared tier, reusing the schema version already present.
- Adding `device_id` (and the attribution plan's `user_id`) to snapshot entries.
- A `boardStateExport` enum value for the bidirectional mode, alongside `none` and `read-only-snapshot`.

### Complex / Risky

- **Replacing "always overwrite" is the heart of the plan.** The publisher currently force-writes the ref. The retry loop must be single-flight (it already is), bounded, and correct under a push rejected repeatedly by a busy team. On exhaustion it must surface, not silently drop the local change.
- **Applying an inbound snapshot must not yank cards out of columns wrongly.** The schema comment at `KanbanDatabase.ts:874` is explicit that "a file re-import must never yank a card out of its column". An inbound *board* snapshot is the one input that legitimately may — so the apply path is distinct from the file-import path and must not be routed through it.
- **Intent replay against a moved target.** A local move of a card that the fetched snapshot shows deleted, or moved to a third column, or re-parented to another feature. Each needs a defined outcome. Deleted wins over moved; a third-column move is a genuine conflict and the honest resolution is last-writer-wins with a surfaced notice, because the transport cannot do better and pretending otherwise is worse.
- **Git credentials and network in the write path.** A board move now depends on a remote being reachable. That must degrade to local-only-with-pending-state, and the pending state must be visible, or operators will believe a move landed for teammates when it did not.
- **Orphan-branch history growth.** Every board change is a commit. A busy team generates a lot; the ref needs periodic squashing or a shallow retention policy, or clones get expensive.

## Edge-Case & Dependency Audit

**Race conditions**
- Two machines pushing simultaneously: exactly the case CAS handles, and the case to test hardest.
- A machine offline for a week returning with stale intents. Intents need an age bound beyond which they are surfaced rather than replayed.
- `AutoArchiveService` and the retention sweep mutating the board while a sync is in flight.

**Security**
- Board state lands in the repository's remote, so anyone with repo read access sees the board. That is the intended trust model — it is the team's existing boundary — but it must be stated: adopting this shares board state with everyone who can clone.
- The snapshot must not carry local paths, terminal names, or tokens. The tier split guarantees this; a contract test should enforce it.

**Side effects**
- `board.md` / `board.html` stay as human-readable companions; only `board.json` is authoritative.
- `ControlPlaneMigrationService` already reasons about `.switchboard/` mirror content and ignore rules; the interaction needs checking.
- The `/switchboard-cloud` protocol and agent-facing surfaces read the per-repo snapshot and are unaffected — but a remote agent could now *write* by pushing to the ref, which is a capability worth naming rather than discovering.

**Migration**
- `read-only-snapshot` shipped, so its ref may already exist in user repos with the current schema. The bidirectional mode must adopt an existing snapshot rather than replacing it, and a client in the old mode must keep working against a ref a newer client is writing — so schema evolution is additive only.

## Dependencies

- **Hard prerequisite:** the tier split, which defines what the snapshot may contain.
- **Builds on** `BoardSnapshotPublisher` and the `boardStateExport` setting rather than replacing them.
- **Pairs with** the attribution plan for `user_id` in snapshot entries.
- **Independent of** the libSQL plan. Neither blocks the other; the panel offers whichever is configured.

## Adversarial Synthesis

Key risks: replacing force-overwrite with a bounded CAS retry must never silently drop a local change; applying an inbound board snapshot is the one path allowed to move cards between columns and must not be routed through the file-import path that is forbidden to; intent replay against a deleted or thrice-moved card has no lossless resolution; and a board move now depends on network and credentials. Mitigations: bounded single-flight retry that surfaces on exhaustion; a distinct apply path for board snapshots; per-case replay outcomes specified in the plan with last-writer-wins plus a visible notice where nothing better exists; and a visible pending state when the remote is unreachable.

## Proposed Changes

1. **An ingest path** for `board.json`, applying the shared tier through a dedicated board-apply route, never the file-import route.
2. **CAS publish loop** in `BoardSnapshotPublisher`: fetch, replay local intents onto the fetched snapshot, push; bounded retries; surface on exhaustion. Replaces the unconditional overwrite.
3. **An outbound intent log** — small, local, bounded by age — so replay knows what this machine changed rather than diffing whole snapshots.
4. **Snapshot identity** — `device_id` and `user_id` per entry, additive to the existing schema.
5. **A `boardStateExport` mode** for bidirectional operation, defaulting off, with the Database panel stating plainly that it is pull-paced and repo-visible.
6. **Ref hygiene** — periodic squash or shallow retention for the orphan branch.
7. **A contract test** asserting no local-tier field can appear in a snapshot.

### Migration

Additive schema only, so an existing `switchboard/board` ref is adopted in place and older clients keep reading it. Default stays `none`; nobody is opted in.

## Verification Plan

- **CAS correctness:** two clients, same remote, simultaneous moves of different cards. Assert both land. Simultaneous moves of the *same* card: assert one wins, the loser is surfaced, and nothing is silently dropped.
- **Retry exhaustion:** hold the ref busy until retries exhaust. Assert the local change survives locally and the failure is visible.
- **Column integrity:** assert an inbound snapshot moves cards, and that a plan-file re-import still cannot — the two paths stay separate.
- **Replay edge cases:** local move against a card deleted remotely, moved to a third column remotely, and re-parented remotely. Assert each defined outcome.
- **Offline:** no network. Assert board moves apply locally, pending state is visible, and sync resumes correctly on reconnect.
- **Tier leakage:** contract test asserting no `dispatched_*`, `last_liveness_at`, `worktrees` or filesystem path appears in `board.json`.
- **Backward compatibility:** an old-mode client reading a ref written by a new-mode client; assert it still renders.
- **No code-branch churn:** run 200 board changes; assert zero commits on any code branch and a clean working tree throughout.
- **History growth:** 1,000 board changes; measure ref size and assert the hygiene policy bounds it.

## Outstanding Questions

- Is a squash-on-schedule acceptable for the orphan ref, given someone may be reading its history for an audit trail?
- Should a remote agent be able to write the ref directly (push a board change without running Switchboard), and if so does that need a schema-validation guard on ingest?
- Does the intent log need to survive a crash, or is losing unsynced intents on kill acceptable given the local DB still holds the resulting state?
