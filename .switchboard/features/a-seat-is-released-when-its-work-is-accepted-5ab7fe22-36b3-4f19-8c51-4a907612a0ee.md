# A seat is released when its work is accepted

**Complexity:** 7

## Goal

Nine loose plans that are one lifecycle: a seat given work must have a holder, and that hold must be released when the work is accepted. Today it often is not, and 571 stranded rows were measured. Landing order matters and is stated in Dependencies: the idempotent-completion and column-move fixes repair live state first, then the acceptance post surfaces its failures, then the invariants, then the instruction changes.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Completion Directive Becomes a Standing Order, Not a Prompt-Injected Section](../plans/feature_plan_20260827172158_completion-directive-becomes-standing-order.md) — **CREATED** — ID: c0302557-8abf-404e-ab46-f0422003d5de
- [ ] [The after-clear standing-orders block is a task-less prompt, so the lead wakes, inspects, and stops](../plans/after-clear-standing-orders-block-is-a-taskless-prompt.md) — **CREATED** — ID: 7dae7ef2-5792-4814-b77f-aa45c6147f26
- [ ] [The lead's acceptance post is the only thing that releases a seat, and it silently releases nothing](../plans/lead-acceptance-post-silently-releases-no-seat.md) — **CREATED** — ID: 4431d447-b8ee-4969-9283-0354c76bee75
- [ ] [Team lead escalation must exhaust cheap recovery before declaring a subtask blocked](../plans/team-lead-escalation-dead-end-recovery-ladder.md) — **CREATED** — ID: 3b387cf6-07a6-4d4b-952e-9b5f2fd873ee
- [ ] [The dispatch curtain is armed from intent, not from a clear that actually runs — so it covers dispatches and misses real clears](../plans/the-curtain-is-armed-from-intent-not-from-a-clear-that-happened.md) — **CREATED** — ID: 2e648081-3693-4485-8c74-777dd7118ed8
- [ ] [A column move orphans the dispatch holder, and the seat can never release it](../plans/a-column-move-orphans-the-dispatch-holder.md) — **CREATED** — ID: bf23c37f-d3d3-44b4-9378-340746214016
- [ ] [An idempotent completion skips the clear, so a seat that reported its own done is never stood down](../plans/an-idempotent-completion-skips-the-clear-so-a-seat-is-never-stood-down.md) — **CREATED** — ID: 16bdde5d-1749-4ab5-b41a-248df79e81d6
- [ ] [Status panes render an empty model — nothing records what a seat is working on](../plans/status-panes-render-an-empty-model-nothing-records-what-a-seat-is-doing.md) — **CREATED** — ID: 1b481ce7-bdba-4f6b-959e-a83b2713faeb
- [ ] [A feature dispatch seats exactly one lead — make it an invariant, not an outcome](../plans/a-feature-dispatch-seats-one-lead-never-a-set.md) — **CREATED** — ID: 6a025695-3d8d-4a63-822b-5755cc6a2a6b
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
