# Board control instructions — the file format and the executor that fires them

## Goal

Define a single JSON instruction file that names a card and the board actions to
apply to it, and build the executor that validates one and fires the named
actions against the board. No git in this plan: the executor takes a parsed
object and returns a per-action result, so it is fully testable by handing it a
file. `board-control-repo-poller.md` is what delivers files to it.

### Problem Analysis

**A cloud agent can author plans but cannot touch the board.** Plan files reach
the board through git: an agent writes `.switchboard/plans/*.md`, pushes, and the
watcher imports on the next fetch. Nothing equivalent exists for board *actions*.
Moving a card, starring it, or marking it complete requires the LocalApiServer,
which binds to localhost and requires a token (`_checkAuth`) — correctly
unreachable from a cloud VM.

**So the only inbound channel is a file in git, and one already half-exists.**
`BoardSnapshotPublisher` (`BoardSnapshotPublisher.ts`) publishes `board.json`,
`board.md`, and `board.html` for remote reading. Its header is explicit that this
is *"One-directional, read-only… Sole writer is the extension; always overwrite;
no diff-ingest, no control"*. This plan and its siblings add the missing
direction, in a **separate private repository** of its own — see
`board-control-repo-poller.md` for why access, not history, is what has to be
isolated, and `board-state-moves-to-a-private-repo.md` for the same move applied
to the outbound half.

**Bare booleans cannot express the actions worth firing.** A flat
`{"move": true, "star": true}` map carries no arguments, so the most useful
action — *move this card to CODED* — is inexpressible, as are set-complexity and
add-to-milestone. It also has no defined order: JSON object key order is an
artifact of whatever emitted it, and an agent will emit keys in whatever order it
pleases, so "star then move" and "move then star" are indistinguishable. The
template therefore keeps booleans (they are the right shape for *whether* to do
something) and puts arguments in a sibling block, with execution order fixed by
the schema rather than by the file.

**Replay is the failure mode that matters.** A control file lives in a repo's
history. Anything that re-presents it — a force-push, a re-clone, a cursor reset,
a rebuild of the poller's state — re-fires every action in it unless identity is
carried by the *instruction*, not by the commit. "Move to CODED" replayed is
survivable; a replayed dispatch is not.

### Root Cause

The board's write surface was built for a caller on the same machine. A remote
author has no path in, and the file-based path that does exist (plan files)
carries content, not commands.

### Non-goals

- **Git, fetching, polling, or pushing.** All in the poller plan.
- **A general RPC channel.** This is a fixed allowlist of board actions, not a
  way to reach `POST /kanban/verb/<name>` or any other endpoint by name. See the
  allowlist rule below — it is the security boundary of the whole feature.
- **Shell, file paths, URLs, or arbitrary payloads** anywhere in the schema.
- **Creating plans.** Plan files already flow in over git; this is for actions on
  cards that exist.
- **Confirm gates.** Per project rule, none.

## Metadata

**Complexity:** 6
**Tags:** feature, backend, api, security, reliability
**Feature:** 2440474a-cbe2-4876-b65d-3ccffd000aa3

## Dependencies

None to build. `addMilestoneMember` / `setMilestoneComplete` actions are gated on
`milestones-long-term-targets-on-the-board.md`; ship the executor without them
and add them when that lands — the allowlist is a table, so it extends cleanly.

## Proposed Changes

### 1. The instruction file — `src/services/boardControlSchema.ts`

One file per instruction, named `instructions/<id>.json` in the control repo:

```json
{
  "schema": 1,
  "id": "2026-08-27-move-auth-refactor-01",
  "target": { "planId": "abc-123" },
  "actions": {
    "move":              true,
    "star":              false,
    "unstar":            false,
    "setComplexity":     false,
    "setPriorityLevel":  false,
    "addToMilestone":    false,
    "stageForQueue":     false,
    "completePlan":      false
  },
  "params": { "targetColumn": "CODED" },
  "note": "free text, logged, never executed"
}
```

- **`id` is the identity, and it is mandatory.** Idempotency keys on it, not on
  the commit SHA — a force-push changes the SHA while re-presenting the same
  instruction. Reject a missing or non-string id; reject an id containing a path
  separator or `..` (it is used to name the receipt file).
- **`target`** is `{ planId }` or `{ planName }`. `planId` wins. A `planName` is
  resolved only if it matches **exactly one** card: zero matches or two both
  refuse, and the refusal lists the candidates. Never guess — a mis-resolved name
  applies someone's intent to the wrong card, and the receipt would report
  success.
- **`actions`** is a closed boolean map. Every key is validated against the
  allowlist below; an unknown key is **reported in the receipt and never
  dispatched**. Non-boolean values are rejected rather than coerced, using the
  ladder from the star endpoint (`LocalApiServer.ts:6505-6528`) — a `"false"`
  that coerces to `true` here moves a card nobody asked to move.
- **`params`** carries arguments for whichever actions need them. A param without
  its action is ignored (and reported); an action without its required param is a
  per-action failure, not a whole-file failure.
- **`schema`** is checked. An unknown version is refused whole, so a future format
  is never half-interpreted by an old install.

### 2. The allowlist — the security boundary

A table in one place, each row naming an action, its required params, and the
single DB or service call it makes:

| Action | Params | Effect |
|---|---|---|
| `move` | `targetColumn` | The sanctioned move path, the same one `move-card.js` and `POST /kanban/move` take — never a direct SQL column write |
| `star` / `unstar` | — | `setPriorityStarred` |
| `setComplexity` | `complexity` | Existing complexity write |
| `setPriorityLevel` | `priority` | Gated on the priority field landing |
| `addToMilestone` | `milestoneId` | Gated on the milestones plan |
| `stageForQueue` | — | Stage into STAGING at the next queue position |
| `completePlan` | — | The board's own complete path |
| `dispatch` | `role` (optional) | Send the card to a seat via the remote dispatch seam — the channel's primary action |

Rules that make it a boundary rather than a list:

- **Nothing outside the table is reachable.** No verb name, endpoint path, SQL,
  or shell can be expressed in the file at all — there is no field for one.
- **Every action routes through the same code path a human's click takes.** Board
  moves in particular go through the sanctioned move path, never raw SQL: per
  project rules, SQL moves strand cards and skip the move side-effects.
- **`dispatch` is in v1, and is the point.** The workflow this channel exists for
  is *author plans in a cloud session, run `improve-plan` in the cloud, dispatch
  remotely to the local coder* — so a channel without dispatch does not serve its
  primary use case. It takes an optional `role` param (default: the column's mapped
  role) and routes through `remote-dispatch-is-its-own-audited-seam.md`, never
  through the local dispatch command, so it is attributable and logged.

  Replay matters more for this action than for any other: a re-fired move is
  cosmetic, a re-fired dispatch spends tokens and starts a second agent. The
  idempotency in §5 is therefore load-bearing rather than tidy, and its tests are
  the ones to trust before enabling the channel.

### 3. Execution order, and partial failure

**Order is fixed by the allowlist table's order, not by the file.** Documented in
the schema module and asserted in a test, so `star`-then-`move` is what happens
whatever order the JSON keys arrive in.

**Actions are independent: one failure does not abort the rest.** Each action
gets its own result, and the receipt reports all of them. Aborting on the first
failure would leave an instruction half-applied with no record of which half —
worse than applying what could be applied and saying so precisely.

### 4. The receipt

Receipts are published to the **state** repo, not the control repo, so each repo
keeps exactly one writer — the machine writes state, the agent writes control. The
executor returns the receipt object; the poller publishes it. That split also means
a compromised agent credential can file instructions and cannot fabricate a
receipt claiming one was applied.

```json
{ "schema": 1, "id": "…", "receivedAt": "…", "resolvedPlanId": "abc-123",
  "results": [ { "action": "move", "ok": true, "detail": "CREATED → CODED" },
               { "action": "setComplexity", "ok": false,
                 "error": "missing required param: complexity" } ],
  "ignored": [ "frobnicate" ],
  "status": "applied" }
```

`status` is `applied` (all requested actions succeeded), `partial`, `refused`
(whole-file validation failed — bad schema, unresolvable target), or `duplicate`
(this `id` was already processed; **nothing re-fired**).

The receipt is the only channel by which a remote author learns what happened, so
it must never be silently absent: every path through the executor produces one,
including every refusal.

### 5. Idempotency

A processed-ids store keyed by `(workspaceId, instructionId)`, written **before**
the actions fire and completed after, so a crash mid-instruction leaves it marked
attempted rather than unmarked and replayable. A second sighting of a known id
returns `duplicate` without dispatching, and re-emits the stored receipt.

Bounded: keep the last N ids (a few thousand) with a timestamp, pruned oldest-
first. An unbounded table is a slow leak; a too-small one reopens replay.

### Host parity (extension + standalone)

The executor is a plain service constructed alongside the DB, following
`BoardSnapshotPublisher`, which is instantiated inside `KanbanDatabase` creation
(`KanbanDatabase.ts:1319`) rather than in either composition root. That is why the
snapshot publisher has never diverged between hosts, and this plan copies it
deliberately: **no new composition-root seam is introduced.** Do not wire this in
`extension.ts` or `bootstrap.ts`.

### Migration

New state: the processed-ids store and nothing else. Additive table, idempotent
`CREATE TABLE IF NOT EXISTS` plus a migration block per the V63/V64 pattern
(`KanbanDatabase.ts:626-642`). No existing row is read differently.

## Verification Plan

1. **Schema validation** — unknown `schema` version refused whole; missing `id`
   refused; an `id` containing `/` or `..` refused; non-boolean action value
   refused, not coerced (assert `"false"` does not become `true`).
2. **Target resolution** — `planId` hit; `planName` unique hit; `planName` with
   zero and with two matches both refuse and the receipt lists candidates; assert
   **zero actions fired** on any refusal.
3. **Allowlist** — an unknown action key is reported in `ignored` and dispatches
   nothing; assert no code path can name an endpoint, verb, SQL string, or shell
   command (a source-text assertion: the schema type has no such field).
4. **Order** — a file with all keys true fires them in the table's order
   regardless of JSON key order. Build the input with keys deliberately reversed.
5. **Partial failure** — action 2 fails, actions 1 and 3 still apply, and the
   receipt reports all three honestly.
6. **Idempotency** — the same id twice → second returns `duplicate`, re-emits the
   first receipt, and fires nothing; a *different* id with identical content does
   fire; a simulated crash between mark and completion leaves the id
   non-replayable.
7. **Move goes through the sanctioned path** — spy on it and assert no direct SQL
   column write.
8. **Every path produces a receipt** — enumerate refusal branches and assert none
   returns without one.
9. **Both hosts** — construct the executor under each host's DB creation and run
   one instruction through each, proving the no-new-seam claim rather than
   asserting it.

### Goal Invariants

- An instruction can only do what the allowlist table says, and the file has no
  syntax for anything else.
- No value is silently coerced; ambiguity is refused, never guessed.
- The same instruction never applies twice, however it is re-presented.
- Every outcome, including every refusal, is reported in a receipt.
- Board moves take the same path a human's click takes.
