# A seat is released when its work is accepted

**Complexity:** 7

## Goal

Nine loose plans that are one lifecycle: a seat given work must have a holder, and that hold must be released when the work is accepted. Today it often is not, and 571 stranded rows were measured. Landing order matters and is stated in Dependencies: the idempotent-completion and column-move fixes repair live state first, then the acceptance post surfaces its failures, then the invariants, then the instruction changes.

> **Reconciliation note (2026-09-04 improve-feature pass).** The Goal and Dependencies sections reference "nine loose plans," but the auto-generated Subtasks block below contains six. The three not present as subtasks — idempotent completion, the dispatch curtain, and the after-clear standing-orders block — are separate plans on the board (not part of this feature's subtask set) or were deleted/merged in earlier passes. They are listed in Dependencies as sequencing context only, not as subtasks to execute here. This feature's executable scope is the six subtasks in the auto-generated block. Do not edit that block to reconcile the count — Switchboard regenerates it from the DB.

## How the Subtasks Achieve This

- **A column move orphans the dispatch holder, and the seat can never release it**: fixes the `_runQueueDone` release path to key on `dispatched_terminal === from` alone (dropping the `dispatched_at` requirement that made column-moved cards invisible to their own seat's completion post). Repairs the 571 measured stranded rows and stops new orphans from forming. Contributes the live-state repair that every other subtask's release path depends on.
- **The lead's acceptance post is the only thing that releases a seat, and it silently releases nothing**: makes `POST /kanban/task/complete` actually clear the accepted coder (and every seat attributed to the subtask, minus the lead's submitting seat), surfaces `cleared: false` / `clearError` instead of silently dropping them, and refuses a feature-completion sweep. The standalone `clearTerminalContext` seam is already wired (`cf57044b`); this plan closes the four no-op cases in `completeCardInternal`.
- **A feature dispatch seats exactly one lead — make it an invariant, not an outcome**: enforces a count invariant (exactly one terminal) at the single delivery chokepoint, after both team-scoped and workspace-wide resolution and before the prompt is pasted. Zero or multiple matches are refusal conditions, not fallbacks. Inverts `restrictToOriginTeam` to refuse-by-default for feature dispatch (scoped so the `queue/next` path is unchanged).
- **Status panes render an empty model — nothing records what a seat is working on**: stamps `dispatched_terminal` AND `dispatched_at` at `ptySendPrompt` so a prompt-dispatched card has a holder and a heartbeat (not a new orphan), investigates why no seat report has ever been written, and renders "working, no report yet" from `lastDataAt` so an active-but-unattributed seat stops reading as idle. Depends on the CLI surface (6fc37578) for durability.
- **Team lead escalation must exhaust cheap recovery before declaring a subtask blocked**: replaces the terminal "stop and report" branch in the coding-head prompt with a five-rung ladder (verify → clear-and-retry → lateral hand-off → vertical escalate → lead self-fix → stop), and reconciles the KanbanProvider drive block in the same change so its "context preserved" and "stand-down case only" rules don't override rung 1. Owns the sole edit to the drive-block wording.
- **Completion Directive Becomes a Standing Order, Not a Prompt-Injected Section**: moves the `COMPLETION REPORT` directive from prompt-injected content (via `ensureDispatchProtocolDirectives` in `buildKanbanBatchPrompt`) to a role-scoped standing order delivered at the `ptySendPrompt` layer, so copy-prompt buttons produce clean prompts for any agent (including external/cloud) and the directive reaches only live Switchboard-connected terminals. Uses the CLI form (`switchboard done --from`), not the old `POST /kanban/queue/done` form. Lands last; its seat-block-gate prerequisite is unimplemented at HEAD.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Completion Directive Becomes a Standing Order, Not a Prompt-Injected Section](../plans/feature_plan_20260827172158_completion-directive-becomes-standing-order.md) — **PLAN REVIEWED** — ID: c0302557-8abf-404e-ab46-f0422003d5de
- [ ] [The lead's acceptance post is the only thing that releases a seat, and it silently releases nothing](../plans/lead-acceptance-post-silently-releases-no-seat.md) — **PLAN REVIEWED** — ID: 4431d447-b8ee-4969-9283-0354c76bee75
- [ ] [Team lead escalation must exhaust cheap recovery before declaring a subtask blocked](../plans/team-lead-escalation-dead-end-recovery-ladder.md) — **PLAN REVIEWED** — ID: 3b387cf6-07a6-4d4b-952e-9b5f2fd873ee
- [ ] [A column move orphans the dispatch holder, and the seat can never release it](../plans/a-column-move-orphans-the-dispatch-holder.md) — **PLAN REVIEWED** — ID: bf23c37f-d3d3-44b4-9378-340746214016
- [ ] [Status panes render an empty model — nothing records what a seat is working on](../plans/status-panes-render-an-empty-model-nothing-records-what-a-seat-is-doing.md) — **PLAN REVIEWED** — ID: 1b481ce7-bdba-4f6b-959e-a83b2713faeb
- [ ] [A feature dispatch seats exactly one lead — make it an invariant, not an outcome](../plans/a-feature-dispatch-seats-one-lead-never-a-set.md) — **PLAN REVIEWED** — ID: 6a025695-3d8d-4a63-822b-5755cc6a2a6b
<!-- END SUBTASKS -->

## Dependencies & sequencing (2026-09-04, Board Collapse 08)

Nine plans that were loose on the board. They are one lifecycle, not nine bugs: a seat given work
must have a holder, and that hold must be released when the work is accepted. Land in this order.

1. **An idempotent completion skips the clear** — separate the write from its consequences, so a
   seat that reported its own done is still stood down when the lead's acceptance arrives second.
2. **A column move orphans the dispatch holder** — release keys on `dispatched_terminal === from`
   alone. Rescoped to its server-side half only (decision 8); it repairs **571 measured stranded
   rows**, so it goes early.
3. **The lead's acceptance post releases nothing** — surface `cleared:false` and `clearError`
   instead of dropping them. Its standalone-wiring step is already done by `cf57044b`.
4. **A feature dispatch seats exactly one lead** — make it an invariant, not an outcome.
5. **The dispatch curtain is armed from intent** — arm from a clear that actually runs.
6. **The after-clear standing-orders block is a task-less prompt** — a cleared lead should not burn
   a turn inspecting its roster.
7. **Status panes render an empty model** — nothing records what a seat is working on. This plan's
   own analysis names steps 2 and the deleted "queued card has no holder" as the same class.
8. **Team lead escalation must exhaust cheap recovery** — the single recovery ladder (decision 9),
   with its verify-first rung. It owns the sole edit to the KanbanProvider drive-block wording, so
   it must not be authored in parallel with step 3.
9. **Completion Directive Becomes a Standing Order** — last (decision 8). Its stated prerequisite,
   the gate stopping lead-dispatched coders receiving the directive twice, does not exist at HEAD.

Steps 1 to 3 repair live state and are worth landing even if the rest waits.

## Team Dispatch Instructions

### A column move orphans the dispatch holder, and the seat can never release it

- **Seat:** Coder (Complexity 5)
- **Acceptance:**
  - `_runQueueDone` releases a held card keyed on `dispatched_terminal === from` alone (no `dispatched_at` requirement).
  - A column move that nulls `dispatched_at` does NOT orphan the holder — the seat's next `queue/done` still releases the card.
  - The superset test passes: the release path's "held" predicate is a subset of `heldByTeam`'s.
  - A seat cannot release another seat's card; `completed_at` authority remains intact.
  - Both hosts (standalone and extension) behave identically.
- **Must not touch:** completion directive text (owned by *Completion Directive Becomes a Standing Order*); prompt content; the `task/complete` clear path (owned by *The lead's acceptance post*).

### The lead's acceptance post is the only thing that releases a seat, and it silently releases nothing

- **Seat:** Coder (Complexity 5)
- **Acceptance:**
  - `POST /kanban/task/complete` for a team subtask returns `cleared: true` for the accepted coding seat under the standalone host.
  - A completion that resolves no seat returns `cleared: false` with a reason (not `success: true` with `cleared` absent).
  - A re-posted completion clears the seat once (idempotent); a third post is a no-op.
  - A subtask touched by two seats (escalation-ladder path) clears both on `task/complete`, minus `from`.
  - A seat working a DIFFERENT subtask is not cleared by another subtask's `task/complete`.
  - `clearTerminalContext` is present in BOTH composition roots' options objects — no asymmetry.
- **Must not touch:** the standalone `clearTerminalContext` seam (already wired by `cf57044b` — do not re-wire); the `queue/done` release path (owned by *A column move orphans the dispatch holder*); the KanbanProvider drive-block wording (owned by *Team lead escalation*).

### A feature dispatch seats exactly one lead — make it an invariant, not an outcome

- **Seat:** Intern (Complexity 3)
- **Acceptance:**
  - A feature dispatch resolves to exactly one terminal (count === 1); zero or >1 is a refusal.
  - With `gate.role` unavailable, the dispatch is refused naming that reason (no workspace-wide fallback).
  - With two seats matching the role workspace-wide, the dispatch is refused (not "the first").
  - An explicit `targetTerminalOverride` seats exactly that one terminal.
  - The `queue/next` path's existing refusal behaviour is unchanged.
  - A selection containing a feature is refused, naming the feature.
- **Must not touch:** the `queue/next` path's refusal semantics; the column cascade (`cascadeFeatureByPlanId`); the `plan_dependencies` / `map_fingerprint` tables.

### Status panes render an empty model — nothing records what a seat is working on

- **Seat:** Coder (Complexity 5)
- **Acceptance:**
  - After a `ptySendPrompt` carrying a plan, `fleet --json` reports a non-null `planId` and `planTitle` for that seat, and the status pane names the plan.
  - The same holds for `ptySendPrompt` delivery (not just board dispatch).
  - A seat producing output with no plan association renders as active (`lastDataAt` recent), not idle; a genuinely idle seat still renders as idle.
  - Stamping `dispatched_terminal` on a prompt-dispatched card does NOT create a new orphan — `dispatched_at` is also stamped.
  - Completing the card releases the seat and the pane stops naming the plan (no regression).
- **Must not touch:** the `queue/done` release path (owned by *A column move orphans the dispatch holder*); the `task/complete` clear path (owned by *The lead's acceptance post*); the CLI surface itself (owned by 6fc37578, an external feature).

### Team lead escalation must exhaust cheap recovery before declaring a subtask blocked

- **Seat:** Coder (Complexity 6)
- **Acceptance:**
  - `NEW_CODING_HEAD_PROMPT` in `teamWiring.ts` contains `ptyClearTerminal` and `recovery ladder` (or equivalent).
  - `NEW_CODING_HEAD_PROMPT` does NOT contain the old dead-end fragment `'if the seat that failed twice is a lead, or your team has no seat above it'`.
  - `NEW_CODING_HEAD_PROMPT_CLIENT` is ABSENT from `terminals.js` (the client mirror is retired); `teamWiring.ts` and `kanban.html` remain byte-identical after the identical escalation-clause replacement.
  - The KanbanProvider drive block at `KanbanProvider.ts:6024` references the recovery ladder; at `:6037` it permits rung 1's clear-and-re-dispatch.
  - `NEW_CODING_HEAD_PROMPT` does NOT contain `against the port in .switchboard/api-server-port.txt`.
- **Must not touch:** `terminals.js` (the client mirror is retired — no reunification step); the `task/complete` clear semantics (owned by *The lead's acceptance post*); the completion directive text (owned by *Completion Directive Becomes a Standing Order*).

### Completion Directive Becomes a Standing Order, Not a Prompt-Injected Section

- **Seat:** Lead (Complexity 7)
- **Acceptance:**
  - `COMPLETION_REPORT:` is absent from `buildKanbanBatchPrompt` output for all code-touching roles.
  - `COMPLETION_REPORT:` is present in `applyStandingOrders` output when a `role`-scoped order with `role: 'coder'` exists.
  - The standing-order text uses the CLI form (`switchboard done --from`), NOT the old `POST /kanban/queue/done` form.
  - `against the port in .switchboard/api-server-port.txt` is absent from `applyStandingOrders` output.
  - `<your terminal name>` is absent from `applyStandingOrders` output when interpolation context with a non-empty `terminalName` is supplied.
  - `installCompletionDirectiveOrder(db, 'coder')` called twice produces exactly one order with `id === 'completion-directive:role:coder'`, `parent: ''`, `scope: 'role'`.
  - The `dispatch` payload gate fallback remains in place and is idempotent (standing order + fallback = exactly one `COMPLETION REPORT:`).
- **Must not touch:** the `SWITCHBOARD_LIVENESS_DIRECTIVE` cross-reference (already removed by a fragment sweep — Proposed Change #7 is obsolete); the escalation clause of `NEW_CODING_HEAD_PROMPT` (owned by *Team lead escalation*); the `queue/done` release path; the `task/complete` clear path.
