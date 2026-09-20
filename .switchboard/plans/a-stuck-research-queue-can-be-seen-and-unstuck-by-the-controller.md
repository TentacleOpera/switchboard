# A Stuck Research Queue Can Be Seen and Unstuck by the Controller

Follow-up to the feature **A Research Request Is Queued Inside the Team, and Answered Back to the Planner That Asked** (`cf5537c5`). Not one of its subtasks — that set is reviewed and closed — but the mechanism its second resolved question assumed. Where this plan and a research subtask disagree, the subtask wins.

## Goal

The controller agent can read the research queue's state and force a stuck
request back into service, using CLI verbs. No operator surface is built: the
operator asks the controller, and the controller has a verb for each half.

### Why this exists

The research feature's second open question was resolved on 2026-09-20 as **no
operator surface** — *"the user can just ask the controller agent if it needs to;
if there is a stuck queue the controller agent can unstuck it."* That answer is
recorded in the feature file's `## Resolved decisions`, along with the fact that
**nothing in the eight subtasks implements it**:
`grep -iE 'controller|mission control|unstick'` over the research plans returns
nothing, and no verb exists for either half.

The normal path needs neither verb — the drain self-heals. Research-03's pump
re-assigns, and Research-06 requeues a dead researcher's `assigned` rows on the
fleet's exit event and re-pumps the affected teams. Three cases fall outside
that:

1. **A dead researcher on a registered team.** Research-06's own accepted
   outcome: registered rosters keep dead members (only `ManualGroupStore` drops
   them via `onTerminalExit`), so a requeued request stays `queued` with **no
   live seat to serve it** — deliberately *not* `abandoned`, because the roster
   still names a researcher. It is a visible backlog with nothing behind it.
2. **An `assigned` row whose seat died without the event being observed** — a
   board restart between the seat's death and the fleet callback leaves the row
   `assigned` forever. The requeue trigger is an event; a missed event has no
   second trigger.
3. **A researcher that comes back** after its requests were requeued or the team
   was abandoned: the queue does not know to re-offer them.

Today all three are visible only by reading the queue rows directly, and none
can be acted on from outside the process.

## Metadata

- **Tags:** backend, api, cli, reliability
- **Complexity:** 6
- **Project:** Orchestration

## User Review Required

No. The one policy choice is stated as an assumption in the body rather than put
to you: **a requeue must not take a request out of a live seat's hands** unless
the caller passes `--force` and a named reason. If you want the controller to be
able to yank work from a live researcher unconditionally, say so and the default
inverts.

## Complexity Audit

### Routine

- A read accessor over the research queue rows plus one read route.
- `switchboard research-status` / `switchboard research-requeue`, each mirroring
  `cmdDone`'s shape (`cli.ts:2642`): identity from `SWITCHBOARD_TERMINAL`, a
  `--from` override, and a loud named-variable failure rather than a silent
  wrong answer.
- POSTs go through `apiPost` (`cli.ts:740`), which sets the client marker — so
  the verbs are CSRF-safe by construction, exactly as the feature's first
  constraint demands.
- Registering both names in `KNOWN_SUBCOMMANDS`.

### Complex / Risky

- **A forced requeue of a live seat's row is a double-serve hazard.** The live
  researcher is still working; requeueing puts the same question in front of a
  second seat, and both answers then race to link into one plan. The default
  must refuse; `--force` must require a stated reason and be recorded.
- **Three stuck states must not collapse.** "No researcher on the roster"
  (`abandoned`), "researcher exists but none live" (`queued` backlog), and "the
  queue is empty" are different answers. The read verb must return the state
  **and** the reason, tagged — the feature's own constraint, and the AGENTS.md
  fallback rule applied to a collection read.
- **`KNOWN_SUBCOMMANDS` exists twice.** `cli.ts:4238-4241` and the earlier list
  at `:4190`, with `HEAP_REEXEC_EXEMPT_SUBCOMMANDS` at `:4187`. A verb added to
  one and not the other is reachable-but-unlisted or listed-but-unreachable;
  both must be updated, and the duplication named in the diff.
- **Serialisation.** A requeue must serialize against the pump and against a
  late `research-complete` from the dying seat — Research-03's
  `_researchPumpChains` and Research-01/06's conditional UPDATEs are the
  arbiters. This plan must not add a second lock.
- **This plan cannot be implemented before the feature lands.** No research
  schema, accessor or pump exists today (`grep` for `research_request`,
  `countOutstandingResearch`, `requeueResearch` over `src/` returns nothing), so
  every symbol below is a *proposed* name from Research-01/03/06. Landing this
  first would be coding against a table that does not exist.

## Edge-Case & Dependency Audit

**Race Conditions**

- Requeue racing a late `research-complete`: `complete` requires
  `state='assigned'` and `requeue` requires it too, so whichever conditional
  UPDATE commits first wins and the loser is a no-op — Research-06's rule, reused
  rather than re-derived.
- Requeue racing the pump: enqueue on `_researchPumpChains` (Research-03), not a
  new chain.
- Two controllers requeueing the same request: the second is a no-op that says
  so, not an error.

**Security**

- The requeue verb is state-changing, so it reaches the board only through
  `apiPost` (marker set) — never a raw POST. The read verb is a read.
- The verbs are runnable by an agent that is **not** a seat (the controller has
  no `SWITCHBOARD_TERMINAL`), so identity must be resolvable for the mutating
  verb from an explicit `--from`/`--reason` and the read verb must need no
  identity at all. A verb that only works from inside a seat is useless to the
  controller, which is the whole point.

**Side Effects**

- A requeue changes outstanding counts, and Research-07's round close derives
  from that count: a forced requeue can therefore hold a round open (correct —
  the work is live again) or, on completion of a requeued request, allow it to
  close. The response must say which.
- Every requeue records why, so "who yanked this request?" is answerable after
  the fact.

**Dependencies & Conflicts**

- **Research-01** — `countOutstandingResearchForSeat` and
  `requeueResearchForSeat` are the accessors this plan calls.
- **Research-03** — the pump and `_researchPumpChains`; a requeue must re-pump.
- **Research-06** — the exit-event requeue and the registered-team backlog
  outcome this plan exists to resolve.
- **Research-08** — the `queue-done` verb and the "every seat-facing call is a
  CLI verb" rewrite; this plan follows the same pattern and must not reintroduce
  a raw HTTP instruction.

## Dependencies

- **Requires** Research-01, Research-03 and Research-06 to have landed. Their
  accessors, pump and requeue semantics are this plan's substrate.
- **Consumed by** the operator's workflow described in the feature file's
  `## Resolved decisions` — the controller reads and unsticks.
- **Related** `the-queue-is-invisible-unless-an-agent-remembers-to-narrate-it` —
  the same visibility gap, on the card queue rather than the research queue.

## Adversarial Synthesis

Key risks: a forced requeue can double-serve a question the live researcher is
already answering, and the three "no answer is coming" states can collapse into
one string that looks like an empty queue. Mitigations: refuse to requeue a live
seat's row by default, require `--force` plus a recorded reason, and return state
*and* reason for every row with the empty queue as its own distinct answer.

## Proposed Changes

### 1. A read accessor for the queue (`src/services/KanbanDatabase.ts`)

- **Logic:** `listResearchQueue(workspaceId, teamId?)` returning one entry per
  request — `{ requestId, planId, teamId, state, requesterSeat, assignedTo,
  assignedAt, ageMs, reason? }` — plus a per-team summary that keeps `queued`
  (backlog), `assigned` (in flight), `abandoned` (no researcher on the roster)
  and empty as four distinct values. A read: no writes, no pump.
- **Edge cases:** a request whose plan no longer exists still lists, naming the
  plan id; an orphaned `assigned` row is listed with its seat and age, which is
  what makes case 2 above diagnosable.

### 2. The read route (`src/services/LocalApiServer.ts`)

- **Logic:** `GET /research/queue?team=<teamId>` (reads are readable over HTTP)
  returning the accessor's result verbatim. Team omitted → every team in the
  workspace, each tagged.

### 3. `switchboard research-status` (`src/standalone/cli.ts`)

- **Logic:** `research-status [--team <id>] [--json]`. Read-only, so no seat
  identity is required. Human output names the state and the reason; `--json`
  emits the accessor's shape unchanged. Registered in `KNOWN_SUBCOMMANDS`.

### 4. `switchboard research-requeue` (`src/standalone/cli.ts` + `LocalApiServer.ts`)

- **Logic:** `research-requeue --team <teamId> [--request <requestId>]
  [--seat <name>] [--force --reason "<why>"] [--json]`. POSTs via `apiPost` to a
  new `POST /research/requeue`. Server-side: resolve the target rows, **refuse
  any row whose `assignedTo` seat is live** unless `--force` and a non-empty
  `--reason` are both present, flip `assigned → queued` (Research-01's
  conditional UPDATE), re-pump the affected teams, and return what changed.
- **Edge cases:** no matching rows → a loud, named refusal (not a silent
  success). A row already `queued` → reported as "already claimable", not an
  error. `--force` without `--reason` → usage error locally, never a round trip.
  `--reason` recorded on the request and in `plan_events`.

### 5. Subcommand registration and the duplication

- **Logic:** add both names to `KNOWN_SUBCOMMANDS` (`cli.ts:4238-4241`) **and**
  the earlier list at `:4190`; decide `HEAP_REEXEC_EXEMPT_SUBCOMMANDS` (`:4187`)
  membership per the existing rule for `done`. Name the duplication in the diff
  so the next verb does not repeat the omission.

## Verification Plan

### Automated Tests

- **A registered team with a dead researcher**: `research-status` reports the
  request as `queued` with the "researcher exists but none live" reason — and
  **not** as `abandoned`, and not as an empty queue.
- **`research-requeue` on that team** makes the row claimable and re-pumps; with
  a live researcher present the pump assigns it.
- **`research-requeue` refuses a live seat's row** without `--force --reason`,
  and the refusal names the seat.
- **A requeue racing a late `research-complete`** leaves exactly one winner and
  no double-serve.
- **An orphaned `assigned` row** (seat gone, no exit event) is listed with its
  seat and age, and is requeueable without `--force` because the seat is not
  live.
- **An empty queue** answers "queue empty", distinct from all three stuck
  states.
- **Both verbs appear in both `KNOWN_SUBCOMMANDS` lists**, and neither emits raw
  HTTP (grep gate over `src/`).
- **The mutating verb works from a non-seat process** (no
  `SWITCHBOARD_TERMINAL`) via explicit flags.

### Goal Invariants

- **Negative:** the read output never renders "no researcher on the roster" and
  "researcher exists but none live" with the same state or reason string, and
  neither is rendered as an empty queue.
- **Negative:** no requeue takes a request from a live seat's hands without both
  `--force` and a recorded non-empty reason.
- **Positive:** after a requeue, the affected team is re-pumped in the same
  operation (no separate step to forget).
- **Positive:** both verbs are CLI subcommands present in `KNOWN_SUBCOMMANDS`,
  and no seat-facing text under `src/` instructs a raw HTTP call for either.
- **Positive:** every requeue leaves a record naming the caller and the reason.

## Constraints

**Every seat-facing call is a CLI verb, never raw HTTP.** This is the research
feature's non-negotiable constraint and it binds here: a documented raw POST
403s, and the agents that "work around it" hide the defect. Both verbs go
through `apiPost`, which sets the client marker.

**Tag every resolved value.** "No researcher is free" and "this team has no
researcher" are different answers and must not render the same. A queued request
that nothing will ever serve is surfaced, not silently held.

**No sessionId.** Every identifier here is a `planId`, a `requestId` or a seat
name.

**No confirmation dialogs.** A requeue acts immediately; the guard is the
`--force --reason` requirement, not a prompt.
