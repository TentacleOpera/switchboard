# The Navigator Runs Missions, and the Pilot Keeps Them Moving

**Complexity:** 8

## Goal

Two models with two jobs. The Navigator sets a mission up with the operator in two questions, subject and goal, proposes up to ten existing cards, fills in the order, team, dependencies and worktree, starts it, and hands off to automated dispatch. The Pilot then keeps it moving for the hours or days it runs. Running missions is the Pilot primary job. Reporting board health is what it does today only because no rule it has can see a mission: all ten matrix rows are seat level, so a mission stalls while every seat reads healthy. The Navigator organizes work that already exists. It never writes or edits a plan.

## How the Subtasks Achieve This

- **The Navigator Is Its Own Model Slot**: gives the two models two configurations.
  Today there is one *active role pointer*, so choosing a provider for one job
  deselects it for the other. It also settles what the Navigator is NOT: a
  judgement tier, whose only behaviour is re-answering the Pilot's question.

  > **Superseded:** "Today there is one slot, so setting a cloud key replaced the
  > Pilot rather than adding a Navigator."
  > **Reason:** `GET /agent/control/config` on the live board (2026-09-22)
  > returns both provider rows intact, with the Google key still set and the
  > local model still configured. Nothing was overwritten. `agentControlProviders`
  > is a map keyed by provider and already holds per-provider endpoint, model and
  > key; what is single is the pointer `agentControlProvider`.
  > **Replaced with:** the fix is a second *role pointer* over the same rows — no
  > new credential slot, no new model slot, no migration.
- **The Navigator Proposes a Mission's Cards**: the two-question conversation.
  Subject and goal; scope follows from the subject. Up to ten existing cards,
  capped in code, and at most three groupings when asked to look at a cold board.
- **The Navigator Fills In a Mission's Parameters**: order, team, dependency
  mapping and worktree. Team is an availability question, not a suitability one.

  > **Superseded:** "All four are real schema — `coding_rounds.ordinal`,
  > `terminals.agentGroups`, the feature's own sequencing section, and the
  > per-feature `worktrees` table."
  > **Reason:** Three of the four homes were wrong (verified against the schema
  > and the live board, 2026-09-22). `coding_rounds` is keyed
  > `UNIQUE(team_id, feature_id, ordinal)` and is the *lead's* registration
  > record; a prose sequencing section would be a second dependency store that
  > can disagree with the one the queue pop actually obeys; and the `worktrees`
  > table is keyed by `feature_id`, which a mission of loose plans does not have.
  > **Replaced with:** order is `plan_dependencies` edges (written through
  > `POST /kanban/dependencies`, read by `isDependencyReady`, which gates the
  > queue pop); team is `missions.team`; the worktree decision is
  > `missions.max_extra_worktrees`; and the prose sequencing section is
  > *rendered* from the edges by the existing `_deriveMissionSequencing`.
  > `terminals.agentGroups` stays the team definition store and is read, never
  > written.
- **The Navigator Starts the Mission It Set Up**: dispatches the first work and
  hands off to automated dispatch. Its authority is fenced by the approval that
  precedes it, and it refuses to start a mission the assigned team's
  `automatedDispatch` policy will not carry.
- **The Pilot Posts the Completion a Coder Never Posted**: the most common
  failure on the board. Row 10 already detects a coder that wrote its work and
  never ran `submit`; its remediation prompts an agent that is out of context and
  completes nothing. This inverts it — the controller posts the bare completion,
  attributed to itself, and the card follows the ordinary route to the lead. It
  is state repair: the work is on disk, only the record is missing.
- **The Pilot and the Navigator Are One Crew**: retires the supervisor seat — a
  permanently-running agent carrying standing cost for a rare event — and makes
  the Navigator the escalation target for rows 6 and 8, which today reach nobody
  but the operator. It also makes the pair work together rather than
  independently: the Navigator is told what the Pilot did on any wake where the
  Pilot acted or could not read a seat, and an escalation carries what has
  already been tried.
- **The Pilot Acts on the Board, Not on the Agent**: retires prompting as a
  remediation class. Text injected into a running agent reshapes its turn and
  routinely stops the work it was meant to restart — observed on this board, and
  made worse by a standing order that already teaches "blocked → report and
  stop". Every remediation becomes a board operation, and a stuck seat is
  answered by a ladder of increasing cost: `bare-enter → redeliver-dispatch →
  respawn-seat`. The sole text ever delivered is the seat's own standard dispatch
  prompt, verbatim.
- **The Navigator Verifies, and Acts When the Pilot Did Not Fix It**: closes the
  loop. A remediation is finished when the work moves again, not when the call is
  accepted. Verification is mechanical; where it fails, the Navigator chooses a
  targeted second-order action — redispatch, reset a feature's status, stand a
  team down, disband it — from a closed set the controller validates and bounds.
  Its prerequisite is the board being able to stop a team in one call, which
  today is a browser-side fan-out.
- **A Mission Is Watched For the Whole of Its Life**: the Pilot's primary job.
  Detects a mission that has stopped moving even though every seat is healthy,
  and makes missions the subject of the *controller's* report rather than column
  counts. The watch runs **outside** the matrix — `diagnose()` is called once per
  subject and a subject requires a held card, so a stalled mission produces no
  subject and a matrix row would never be evaluated. It follows the existing
  `board-level-check` precedent instead, and the matrix's rows are untouched.

## Reconciled End-State — one design for the shared surfaces

Every mission subtask was rewritten against the board's **existing mission
subsystem**, discovered during the 2026-09-22 reconciliation pass. Implement to
this map; where a plan and this map disagree, this map is the later fact.

| Concept | The one store / seam that owns it | Written by | Read by |
|---|---|---|---|
| A mission | `missions` + `mission_members`, via `POST /kanban/mission/create`, `POST /kanban/mission/member/add` (→ `claimIntoMission`) | Proposes a Mission's Cards | panel strips, `GET /kanban/missions/progress` |
| Mission order / dependencies | `plan_dependencies`, via `POST /kanban/dependencies` | Fills In a Mission's Parameters | the **queue pop gate** (`isDependencyReady`), the start pass's staging sort, the watch's weirdness signal |
| Sequencing prose | rendered from the edges by `_deriveMissionSequencing` | nobody — it is a view | operator |
| Team | `missions.team`, via `POST /kanban/mission/update` | Parameters, re-checked at start | the start pass's pre-start check |
| Worktree decision | `missions.max_extra_worktrees` (default `0` = fail-safe) | Parameters | panel |
| Approval / started | `missions.ready`, and derived `runState` from `getMissions` | Starts the Mission | the start pass and the watch, panel |
| Mission progress evidence | `GET /kanban/missions/progress` (`lastMovementAt`, `cardsDone`, `columns`, `outsideMissions`) | the board | panel **and** the watch — one implementation, not two |
| Model configuration | `agentControlProviders` rows + **two role pointers** | Its Own Model Slot | `/controller/judgement`, `/controller/budget`, both panels |
| Stuck-seat remediation | `ESCALATION_LADDER`, one application per rung | Acts on the Board | the verification pass |

Three things this feature explicitly does **not** build, because they exist:
a second mission store on top of features; a second dependency store in prose;
a second computation of "has this mission moved" inside the controller.

One thing it explicitly does **not** touch: `coding_rounds`, which is the lead's
registration record.

## Team Dispatch Instructions

### The Navigator Is Its Own Model Slot

- **Seat:** coder (complexity 6)
- **Acceptance:**
  - `GET /controller/navigator` exists and reports unset distinctly from unreadable.
  - Configuring a Navigator leaves `GET /controller/judgement` with exactly one
    `classifier` tier — assert directly.
  - `GET /controller/budget` returns a populated `navigator` station from the new
    pointer, not from `role === 'escalation'`.
  - `judgeBoard` and the `countModelCall` call site select `role === 'classifier'`
    explicitly; no `tiers[0]` read remains that means "the Pilot".
  - Both provider rows survive a save of either role's config.
  - The `escalation` tier role is **retired in this same diff**: `TierRole` is
    `'classifier'` alone, a config declaring `escalation` is rejected loudly, and
    the Pilot's prompt no longer claims a later stage filters it.
- **Must not touch:** `src/extension.ts` and any extension-host wiring. The
  Navigator must not be appended to `judgement.tiers` — it is a role pointer, not
  a tier.

### The Navigator Proposes a Mission's Cards

- **Seat:** coder (complexity 6)
- **Acceptance:**
  - Applying a proposal creates a row in `missions` and `mission_members`, and it
    appears in `GET /kanban/missions/progress` with `cardsTotal` equal to the
    approved id count.
  - A model-returned id absent from the locally-assembled candidate set is
    rejected; the pass reports an invalid reply rather than proposing it.
  - Twelve ids yield ten with the truncation stated.
  - No plan file's body or mtime changes across a propose-and-apply cycle.
  - "No candidates", "invalid reply" and "pass failed" render three distinct
    strings.
- **Must not touch:** plan `.md` files; `create-feature.js` / `assign-to-feature.js`
  — this plan creates a mission, not a feature; `missions.team` and
  `missions.max_extra_worktrees`, which belong to the parameters subtask.

### The Navigator Fills In a Mission's Parameters

- **Seat:** lead coder (complexity 7)
- **Acceptance:**
  - `plan_dependencies` edges are written through `POST /kanban/dependencies`
    with a `mapFingerprint`; a cycle writes **nothing**.
  - `missions.team` and `missions.max_extra_worktrees` are set via
    `POST /kanban/mission/update`; a hand-set value survives a re-run.
  - With no live team, `missions.team` stays `''` and the exclusion reason from
    `resolveAutomatedDispatchExclusions` is reported verbatim.
  - No card's `kanban_column` or `column_order` changes — this pass never stages.
  - Zero rows written to `coding_rounds` and zero to `worktrees`.
- **Must not touch:** `appendQueuePositions` (it stages, which is the start);
  `coding_rounds`; the `worktrees` table; subtasks with `owner_since` set.

### The Navigator Starts the Mission It Set Up

- **Seat:** coder (complexity 5)
- **Acceptance:**
  - A refused start writes **nothing** — no staging, no `ready`, no dispatch —
    and names the policy or missing team.
  - A successful start stages every member above the pre-start workspace-wide
    STAGING maximum, sets `ready = 1`, and dispatches exactly one card.
  - The second subtask is started by the queue, not by the Navigator.
  - `runState !== 'not-started'` or `paused = 1` refuses the start.
  - An empty dependency edge set is a stated finding, not silent board-order
    staging.
- **Must not touch:** `coding_rounds`; any mission other than the one just
  approved; the queue pop itself.

### The Pilot Posts the Completion a Coder Never Posted

- **Seat:** coder (complexity 5)
- **Acceptance:**
  - Row 10 completes the card on the **first** detection; zero prompts sent.
  - The completion is attributed to the controller, distinguishably from a
    coder's own submit — both the actor and the seat are recorded.
  - A coder submitting after the controller already posted yields **one**
    completion and a success, not an error.
  - `'post-completion-on-behalf'` is in **both** the `MatrixRemediation` union
    and the `MATRIX_REMEDIATIONS` array; `'ask-completion-post'` is gone from
    both.
  - Row 10's `condition`, `evidence` and `requires` are unchanged.
- **Must not touch:** row 10's evaluator; the `from` wire field; `owner_since`.
  The controller must not post wearing the coder's identity.

### The Pilot and the Navigator Are One Crew

- **Seat:** lead coder (complexity 7)
- **Acceptance:**
  - Rows 6 and 8 escalate to the Navigator; an unconfigured Navigator and an
    unreachable one give **different** reasons on the human fallback.
  - A wake with zero actions **and** no unusable judgement replies makes zero
    Navigator calls; a wake with either makes exactly one digest call.
  - The digest reply is recorded in the report and read by no remediation,
    ladder or gate.
  - `'supervisor'` is gone from `MatrixCapabilityKey` **and**
    `MATRIX_CAPABILITY_KEYS`, and row 6 requires `['model']` alone.
  - Escalation prompts carry `stuckPasses`, nudge history and ladder rung.
  - One model-client seam serves both this and the mission adjudication.
- **Must not touch:** the digest channel's inertness — it observes every acting
  wake and must carry no authority. The escalation audit record (only its async
  lifecycle is removed, and only after checking the board's
  `/controller/escalations*` callers).

### The Pilot Acts on the Board, Not on the Agent

- **Seat:** lead coder (complexity 8)
- **Acceptance:**
  - The ladder opens `bare-enter → redeliver-dispatch → respawn-seat` and
    terminates at `stop`.
  - `bare-enter` writes exactly one byte (`\r`) and only at zero sampled CPU; a
    busy seat never receives one.
  - `respawn-seat` on a family with a declared argv shape performs **zero**
    terminal writes — the prompt arrives in the startup command.
  - A delivery whose echo never appears in the log tail is recorded as
    `unverified`, distinctly from `delivered`.
  - `redeliver-dispatch` delivers a payload **byte-identical** to what
    `/kanban/dispatch` sends for that card and seat — no marker, no timestamps,
    no controller sentence.
  - `'nudge'`, `'report-to-lead'`, `'relay-answer'` and `'escalate-human'` are
    gone from the union, the values array **and** the ladder.
  - One rung per application; the row firing again is what advances it.
- **Must not touch:** the delivered payload — no text is added to it for any
  reason. The nudge-era gates (`nudgeSilenceMs`, the board-nudge ledger) are
  removed, not preserved.

### The Navigator Verifies, and Acts When the Pilot Did Not Fix It

- **Seat:** lead coder (complexity 8)
- **Acceptance:**
  - A remediation that worked produces a success verification and **zero**
    Navigator calls; one that did not produces exactly one.
  - A reply outside `SECOND_ORDER_ACTIONS` applies nothing and is recorded as
    discarded — never coerced to a nearest name.
  - Per-subject rate and daily cap each suppress with a stated reason, and the
    subject continues on the first-order ladder.
  - A subject receiving a Pilot remediation this wake receives no second-order
    action in the same wake.
  - `disband-team` goes through `POST /kanban/team/stop` and closes seats by no
    other path.
  - Every applied action records model id, evidence and reason — written before
    the effect for actions that destroy their own evidence.
- **Must not touch:** `MATRIX_REMEDIATIONS` and `ESCALATION_LADDER` — second-order
  actions are a separate axis, not new rungs. The Pilot's behaviour when no
  Navigator is configured must be identical to today.

### A Mission Is Watched For the Whole of Its Life

- **Seat:** lead coder (complexity 8)
- **Acceptance:**
  - A `kind: 'mission'` action is emitted on a wake where `subjects.length === 0`
    — the pass must not depend on a held card.
  - `GET /kanban/missions/progress` is the noticing signal only; the explanation
    comes from terminal evidence already collected this wake, reused without a
    second `/proc` read or log fetch.
  - The six mechanical checks run in order, unposted-completion first; only a
    stall surviving all six reaches the Navigator.
  - A board with **zero** missions still produces a report containing a
    `### Missions` section saying none were examined.
  - A failed progress read reports "mission state could not be read", never "no
    missions".
  - Zero Navigator model calls on a wake with zero stalled missions.
- **Must not touch:** `src/standalone/controller/matrix.ts`. No remediation: this
  plan reports and does not act.

## Dependencies & sequencing

The feature has **two tracks that do not depend on each other**. The Navigator
track builds mission setup; the Pilot track rebuilds what the controller does
about a seat that has stopped. They can proceed in parallel, with one shared
hazard named at the bottom.

### Track A — the Navigator sets a mission up

1. **The Navigator Is Its Own Model Slot** lands first. Everything that calls a
   Navigator needs one that exists and is configured apart from the Pilot.
2. **Proposes a Mission's Cards** produces the mission the rest operate on.
3. **Fills In a Mission's Parameters** needs a mission with cards in it.
4. **Starts the Mission It Set Up** needs the parameters.

**Hard constraint:** subtask 4's handoff is only correct if 3 has landed. 4
stages the mission by topologically sorting the `plan_dependencies` edges that 3
writes; with no edges the queue pops members in board order, which is the
round-wasting failure 3 exists to prevent. Shipping 4 without 3 is not "4 works,
less well" — it is 4 quietly doing the wrong thing, which is why 4 must report an
empty edge set as a stated finding rather than proceeding silently.

2 and 3 are separately shippable: a mission can be proposed and created before
anything but a hand fills in its parameters.

### Track B — the Pilot keeps work moving

- **The Pilot Posts the Completion a Coder Never Posted** should land **first of
  everything**. It is the highest-frequency failure on the board and needs
  nothing from the mission work. Its own prerequisite is the standalone card
  `a-seats-identity-has-one-source.md`, which removes the CLI's `--from` so the
  controller has no seat identity to borrow.
- **The Pilot and the Navigator Are One Crew** needs the Navigator slot (A1). It
  supplies the single Navigator call seam that the next two both use.
- **The Pilot Acts on the Board, Not on the Agent** needs the crew plan, because
  rows 3 and 9 route to the Navigator seam it establishes.
- **The Navigator Verifies, and Acts When the Pilot Did Not Fix It** needs the
  crew plan, and the standalone card `the-board-can-stop-a-team-in-one-call.md` —
  `disband-team` has no server verb today and is a browser-side fan-out.

### Where the tracks meet

**A Mission Is Watched For the Whole of Its Life** is the only subtask that
needs both. It requires A2, A3 and A4 for a mission to exist, carry a recorded
order and have been started; and it requires *The Pilot Posts the Completion a
Coder Never Posted*, because an unposted completion is the **first** of its six
mechanical checks and without that plan it can detect one and has no remedy. Its
*detection* does not require A1 — the Navigator is needed only for adjudication,
which reports itself unavailable with a reason when there is none.

### The contended surface — serialise these

**Five plans edit the runtime-validated closed sets in
`src/standalone/controller/matrix.ts`** — `MatrixRemediation`,
`MATRIX_REMEDIATIONS`, `MATRIX_CAPABILITY_KEYS` and `ESCALATION_LADDER`:

| Plan | Touches |
|---|---|
| The Pilot Posts the Completion… | adds `post-completion-on-behalf`, removes `ask-completion-post` |
| The Pilot and the Navigator Are One Crew | removes the `supervisor` capability key, edits row 6's `requires` |
| The Pilot Acts on the Board… | adds `bare-enter`, `redeliver-dispatch`, `respawn-seat`, `stop`; removes `nudge`, `relay-answer`, `report-to-lead`, `escalate-human`; rewrites the ladder |
| The Navigator Verifies, and Acts… | adds the parallel `SECOND_ORDER_ACTIONS` set |
| *(standalone)* `the-board-restarts-only-when-it-stops-answering` | removes row 7 and `restart-board`, including its ladder rung |

These must **not** run in parallel. Each is a closed set validated at load time,
and the failure mode is silent: a verb present in the type union but missing from
the values array parses, loads, and falls through the controller's `switch` at
wake time doing nothing — a rule quietly ignored at 3am, which the file's own
comment records as already having happened once.

Merge order within that group: **Posts the Completion → Crew → restart card →
Acts on the Board → Verifies and Acts.** Each later one assumes the earlier
removals, and *Acts on the Board* rewrites the ladder that the restart card has
already shortened.

`A Mission Is Watched For the Whole of Its Life` is explicitly constrained **not**
to modify `matrix.ts`, so it is safe to run alongside any of them.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
1. [The Navigator Is Its Own Model Slot](../plans/the-navigator-is-its-own-model-slot.md) — **LEAD CODED**
2. [The Navigator Proposes a Mission's Cards](../plans/the-navigator-groups-ready-plans-into-missions.md) — **LEAD CODED**
3. [The Navigator Fills In a Mission's Parameters](../plans/the-navigator-orders-missions-into-a-schedule.md) — **LEAD CODED**
4. [The Navigator Starts the Mission It Set Up](../plans/the-navigator-starts-the-mission-it-set-up.md) — **LEAD CODED**
5. [A Mission Is Watched For the Whole of Its Life](../plans/a-mission-is-watched-for-the-whole-of-its-life.md) — **LEAD CODED**
6. [The Pilot Posts the Completion a Coder Never Posted](../plans/the-pilot-posts-the-completion-a-coder-never-posted.md) — **LEAD CODED**
7. [The Pilot and the Navigator Are One Crew](../plans/the-pilot-and-the-navigator-are-one-crew.md) — **LEAD CODED**
8. [The Navigator Verifies, and Acts When the Pilot Did Not Fix It](../plans/the-navigator-verifies-and-acts-when-the-pilot-did-not-fix-it.md) — **LEAD CODED**
9. [The Pilot Acts on the Board, Not on the Agent](../plans/the-pilot-acts-on-the-board-not-on-the-agent.md) — **LEAD CODED**
10. [A Prerequisite Outside the Feature Is the Navigator's Problem](../plans/a-prerequisite-outside-the-feature-is-the-navigators-problem.md) — **CREATED**
<!-- END SUBTASKS -->


## Delivery summary (2026-09-22)

All nine subtasks landed, in five rounds across two coder seats, plus two
standalone prerequisite cards the operator dispatched by hand (`the-board-
restarts-only-when-it-stops-answering` and `the-board-can-stop-a-team-in-one-
call`). The contended surface was serialised as the feature required — Posts the
Completion (269fba2b) → Crew (499a53b8) → the restart card (6973aca4) → Acts on
the Board (699b1bb4) → Verifies and Acts (1be9a695) — and `MATRIX_REMEDIATIONS`
and `ESCALATION_LADDER` were verified byte-identical where a plan was forbidden
to touch them. The Navigator now has its own role pointer over the existing
`agentControlProviders` rows, proposes and parameterises a mission against
`missions`/`mission_members`/`plan_dependencies`, and starts it; the Pilot posts
the completion a coder never posted, acts on the board rather than on the agent,
and watches missions from outside the matrix.

Two defects were caught in review and fixed before acceptance: subtask 6 made
`finishedByPlan` a required field on `ApplyContext` and missed the
`performBoardRestart` call site, so `tsc` aborted and none of its suites had ever
run; and subtask 1 left a `tiers[0]` fallback in `/controller/budget` that
presented a non-matching tier as the configured Pilot. The standalone team-stop
card needed three attempts before its released-seat names stopped coming back as
`''`. Final state: `compile-tests` clean and ten suites green with zero failures
— mission-watch (25), second-order (24), navigator-proposal (19),
navigator-parameters (28), navigator-start (26), controller-board-actions,
controller-crew, judgement-bundle, team-stop, queue-done-relay, queue-pipeline.

**Not verified:** no part of this feature has been exercised against a running
host. The board on :7777 serves a `dist/` bundle built at 09:02 and still 404s on
`/controller/navigator`; confirming the panels draw needs a rebuild and a restart,
which would have killed the seats mid-run. Subtask 1's four webview surfaces
(`command.html/js`, `dock.html/js`) were accepted on code review alone.
