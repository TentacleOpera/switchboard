# Board control instructions — a structured command payload on the channel that already exists

## Goal

Let a remote author request explicit board actions — move this card, star it,
dispatch it — by committing one JSON file to the board's configured git
destination, and have Switchboard validate it, apply the allowlisted actions, and
publish a receipt saying exactly what happened.

This is the **payload**, not the transport. The transport is
`board-state-remote-mirror-channels.md` §3's `GitStateProvider`, extended to read
one more directory.

### Problem Analysis

**The git channel carries signals today and cannot carry commands.**
Mirror-channels §3 gives the git destinations the same two channels Linear and
Notion have: a **state signal** (a plan's `**Column:** <name>` line changed) and a
**comment signal** (new text under that line, appended locally and dispatched to
the column's agent). It is explicit that this is *"no command-syntax parsing,
identical behavior to today's Notion/Linear comment flow."*

That covers "the card moved" and "someone said something". It does not cover "star
this", "set complexity", or "dispatch this to a coder" — and it cannot, because
those are not expressible as a column value or a comment.

**The gap is already an open question on a live plan.**
`git-carried-shared-board-state.md` asks, under Outstanding Questions: *"Should a
remote agent be able to write the ref directly (push a board change without
running Switchboard), and if so does that need a schema-validation guard on
ingest?"* — and notes in its side-effects that *"a remote agent could now write by
pushing to the ref, which is a capability worth naming rather than discovering."*
This plan is the answer: yes, through a declared schema, with validation, an
allowlist, and a receipt — not by hand-editing board state.

**A comment that dispatches an agent is the reason validation is not optional.**
Mirror-channels §3 routes an inbound comment straight into
`KanbanProvider.ts:1638`, dispatching the current column's agent. So the git
channel already reaches execution. A command payload on the same channel must
therefore be *narrower* and *more* checked than the comment path, not looser.

**Bare booleans cannot express the actions worth requesting.** A flat
`{"move": true, "star": true}` map carries no arguments, so the most useful action
— *move this card to CODED* — is inexpressible, as are set-complexity and dispatch
to a named role. It also has no defined order: JSON object key order is an artifact
of whatever emitted it. So the template keeps booleans for *whether*, puts
arguments in a sibling block, and fixes execution order in the schema.

**Replay is the failure mode that matters, and the transport's cursor does not
prevent it.** `GitStateProvider`'s cursor is the last-processed commit SHA, which
is correct for deltas and insufficient for commands: a force-push, a re-clone, a
cursor reset, or the ref hygiene squash that `git-carried-shared-board-state.md`
plans all re-present the same instruction under a different SHA. A replayed move is
cosmetic; a replayed dispatch spends tokens and starts a second agent. Identity
must therefore live in the **instruction**, not the commit.

### Non-goals

- **The transport.** Polling, fetching, cursors, and reconciliation are
  mirror-channels §3's. This plan adds a directory to read and a result to
  publish.
- **A new repo, ref, or destination.** Instructions live wherever
  `boardStateExport` points. Two constraints on that, both settled elsewhere:
  a **dedicated board repo** (`board-state-and-instructions-get-a-dedicated-repo.md`)
  is the destination when the channel must be private, and the **control plane is
  never a destination** — it holds the personas, workflows and skills agents
  execute, so a command channel there could rewrite the prompt the agent runs on,
  which no action allowlist can contain.
- **A general RPC channel.** Fixed allowlist; see below.
- **Replacing the state or comment signals.** They keep working unchanged; this is
  a third channel for things they cannot express.
- **Shell, file paths, URLs, or arbitrary payloads** anywhere in the schema.
- **Creating plans.** Plan files already flow in over git — mirror-channels §5.
- **Confirm gates.** Per project rule, none.

## Metadata

**Complexity:** 6
**Tags:** feature, backend, api, security, reliability

## Dependencies

- **Hard prerequisite:** `board-state-remote-mirror-channels.md` §3
  (`GitStateProvider`, the cursor, the poll loop, the inbound trust guard).
- **Required for a private channel:**
  `board-state-and-instructions-get-a-dedicated-repo.md`. Without it the only built
  destination is the code repo's own orphan ref, where `contents: write` — held by
  every collaborator and every CI token — becomes the ability to file instructions.
- `remote-dispatch-is-its-own-audited-seam.md` for the `dispatch` action — it must
  not route through the local dispatch command.
- The `addToMilestone` / `setMilestoneComplete` actions are gated on
  `milestones-long-term-targets-on-the-board.md`; the allowlist is a table, so it
  extends cleanly.

## Proposed Changes

### 1. The instruction file — `src/services/boardControlSchema.ts`

One file per instruction at `instructions/<id>.json` in the configured
destination:

```json
{
  "schema": 1,
  "id": "2026-08-27-move-auth-refactor-01",
  "target": { "planId": "abc-123" },
  "actions": { "move": true, "star": false, "setComplexity": false,
               "addToMilestone": false, "stageForQueue": false,
               "completePlan": false, "dispatch": false },
  "params": { "targetColumn": "CODED" },
  "note": "free text, logged, never executed"
}
```

- **`id` is mandatory and is the identity.** Reject a missing or non-string id, or
  one containing a path separator or `..` (it names the receipt file).
- **`target`** is `{ planId }` or `{ planName }`. `planId` wins; a name resolves
  only if it matches exactly one card, and zero or two both refuse with the
  candidates listed. Never guess — a mis-resolved name applies someone's intent to
  the wrong card and the receipt would report success.
- **`actions`** is a closed boolean map. Unknown keys are reported in the receipt
  and never dispatched. Non-boolean values are rejected, not coerced, using the
  ladder from the star endpoint (`LocalApiServer.ts:6505-6528`).
- **`schema`** is checked; an unknown version refuses the whole file, so a future
  format is never half-interpreted by an old install.

### 2. The allowlist is the security boundary

| Action | Params | Effect |
|---|---|---|
| `move` | `targetColumn` | The sanctioned move path — the same one `move-card.js` and `POST /kanban/move` take, never raw SQL |
| `star` / `unstar` | — | `setPriorityStarred` |
| `setComplexity` | `complexity` | Existing complexity write |
| `addToMilestone` | `milestoneId` | Gated on the milestones plan |
| `stageForQueue` | — | Stage into STAGING at the next queue position |
| `completePlan` | — | The board's own complete path |
| `dispatch` | `role` (optional) | Via `remote-dispatch-is-its-own-audited-seam.md`, never the local dispatch command |

Rules that make this a boundary rather than a list: **nothing outside the table is
expressible** — the schema has no field for an endpoint, verb, SQL string, or shell
command; and **every action takes the path a human's click takes**, board moves in
particular, since per project rules a SQL move strands cards and skips the move
side-effects.

### 3. Execution order, partial failure, receipts

**Order is fixed by the table's order, not the file**, and asserted in a test —
`star`-then-`move` regardless of JSON key order.

**Actions are independent; one failure does not abort the rest.** Aborting on the
first would leave an instruction half-applied with no record of which half.

**The receipt** — `{ status: applied | partial | refused | duplicate, results[],
ignored[] }` — is published wherever the destination's outbound cycle publishes,
alongside the mirror content. Every path through the executor produces one,
including every refusal: it is the only channel by which a remote author learns
what happened.

**An applied action is never rolled back because its receipt could not be
published.** If the actions landed and the push failed, they stay landed, the
cursor is not advanced, and the next cycle re-reads, gets `duplicate`, and retries
only the publish.

### 4. Idempotency, keyed to the instruction

A processed-ids store keyed by `(workspaceId, instructionId)`, written **before**
the actions fire and completed after, so a crash leaves it marked attempted rather
than replayable. A second sighting returns `duplicate` without dispatching and
re-emits the stored receipt. Bounded: last N ids with timestamps, pruned oldest
first.

This is what makes the channel safe under `git-carried-shared-board-state.md`'s
planned ref squashing and under any force-push — neither of which the commit-SHA
cursor survives.

### 5. Reading them — a directory, not a new service

Extend `GitStateProvider` to read `instructions/*.json` in the same
`git log <lastSeenSha>..<remoteHead>` pass it already makes for state and comment
deltas, oldest-first by path for determinism. Instructions go through the **same
inbound trust guard** as every other delta on that channel, before validation.

Add `ls-remote` ahead of the fetch while there: one round trip, no object
transfer, so the common no-change case is nearly free.

### Host parity

No new composition-root seam. `GitStateProvider` is constructed by
`RemoteControlService`, whose deps are wired in both roots — and those callbacks
are a known divergence risk, so diff the two roots by hand for anything this plan
adds rather than trusting verb reachability.

### Migration

New state: the processed-ids store. Additive table with an idempotent
`CREATE TABLE IF NOT EXISTS` plus a migration block per the V63/V64 pattern
(`KanbanDatabase.ts:626-642`). Mirror-channels is unreleased, so the channel
itself takes a clean break with no migration.

## Verification Plan

1. **Schema validation** — unknown version refused whole; missing `id` refused; an
   `id` with `/` or `..` refused; `"false"` does not become `true`.
2. **Target resolution** — `planId` hit; unique `planName` hit; zero and two
   matches both refuse with candidates listed; **zero actions fired** on any
   refusal.
3. **Allowlist** — an unknown action key is reported and dispatches nothing;
   assert by source text that the schema type has no field for an endpoint, verb,
   SQL, or shell string.
4. **Order** — all-true with JSON keys deliberately reversed fires in table order.
5. **Partial failure** — action 2 fails, 1 and 3 apply, receipt reports all three.
6. **Idempotency under the transport's own edge cases** — the same id after a
   force-push returns `duplicate`; the same id after a simulated ref squash
   returns `duplicate`; a different id with identical content fires; a crash
   between mark and completion leaves it non-replayable. These are the tests to
   trust before enabling `dispatch`.
7. **Receipt on every path** — enumerate refusal branches, assert none returns
   without one; assert an applied action survives a failed receipt push and the
   next cycle publishes without re-firing.
8. **Trust guard first** — an instruction from an untrusted author is dropped and
   surfaced before validation, never applied.
9. **No second poller** — assert by source text that no new timer or `ls-remote`
   loop exists outside `GitStateProvider`.
10. **The other two signals still work** — a `**Column:**` change and an inbound
    comment behave exactly as mirror-channels specifies, with instructions present
    in the same commit.

### Goal Invariants

- An instruction can only do what the allowlist says, and the file has no syntax
  for anything else.
- No value is silently coerced; ambiguity is refused, never guessed.
- The same instruction never applies twice — under force-push, squash, re-clone or
  crash.
- Every outcome, including every refusal, is reported in a receipt.
- One transport, one cursor, one poll loop, shared with the state and comment
  signals.
