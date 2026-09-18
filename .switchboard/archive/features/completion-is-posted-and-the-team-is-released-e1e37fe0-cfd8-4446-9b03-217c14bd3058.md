# Completion Is Posted, And The Team Is Released

**Complexity:** 5

## Goal

Make a team completion an assertion the system acts on rather than a state the operator infers.

The team panel ACKNOWLEDGE COMPLETIONS button is a light switch: its entire body deletes entries from an in-memory badge map, re-renders and toasts. No fetch, no DB write. It is also redundant as a light switch, because badges already clear on focus. What the operator actually needs from that control is a release - posting task/complete for every card the scoped team holds with no completion - and it should be absent whenever there is nothing to release.

From the other end, the standing order fires a completion report at the head unconditionally, whatever the work source. That conflicts with both queue systems: the kanban queue/done and the file-based queue/done endpoints need the coder to POST to them, not to message the head. One context-aware standing order should check where the work came from and route the report accordingly.

Both write the same fact - completed_at - which is the single thing that releases a team. Nothing else does; board position is not part of the predicate.

## How the Subtasks Achieve This

- **The Team Panel Releases What The Lead Did Not Post**: replaces `ACKNOWLEDGE COMPLETIONS` — whose entire body deletes in-memory badge entries and toasts, writing nothing — with a real release control that POSTs `task/complete` for every card the scoped team holds with no completion, and which is absent when there is nothing to release.
- **Context-Aware Completion Reporting For Teams**: replaces the unconditional report-to-head standing order with one order that checks where the work came from and routes accordingly, so a coder finishing kanban-dispatched or file-queue work POSTs to the queue endpoint that needs it instead of messaging the head.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Context-Aware Completion Reporting for Teams](../plans/context-aware-completion-reporting.md) — **CODE REVIEWED** — ID: 2153aaf2-2fc0-41a3-a7c4-92fa27775976
- [ ] [The team panel releases what the lead did not post](../plans/the-team-panel-releases-what-the-lead-did-not-post.md) — **CODE REVIEWED** — ID: ba276bc5-fe6b-43df-9d66-e83b1d68f499
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; both write the same fact — `completed_at` — from opposite ends, one operator-initiated and one agent-initiated.

The shared invariant is worth stating for whoever codes either: exactly one fact releases a team, and it is `completed_at`. Board position is not part of the predicate — moving a card never releases a team, and columns advance when work **starts**, not when it finishes. Neither subtask may infer completion from a column, an mtime, or silence; both require the explicit POST.

One cross-feature edge: `advance-when-ready-on-a-scheduled-job.md`, in the scheduling feature, consumes precisely this release signal to fire a job on completion rather than on the clock. If both features are scheduled, landing this one first gives that plan a reliable signal to build on. Neither blocks the other.

The badge behaviour is a non-goal: badges already clear on focus, so the replacement control must not try to preserve the old button's in-memory side effect.

## Review Findings

Reviewer pass over both subtasks. The panel-release half needed no code fix — the control,
its visibility rule, the shared `completeCardInternal` helper and the shared `heldByTeam`
predicate all match the plan, and `resolveTeamMembers` is wired in both composition roots.
The reporting half needed two: the completion order carried a paragraph telling any seat to
`POST /kanban/dispatch` a feature to `CODE REVIEWED` once "all subtasks are in LEAD CODED" —
exactly the board-position inference this feature's sequencing section forbids — and the
implementing commit had deleted the CI-gated assertions that forbade it; and the `team-head`
scope was handed the *member* body, so the lead was told to `ptySendPrompt` itself and was
never told to post `task/complete`, the one fact that releases a team. Both are fixed in
`src/services/teamWiring.ts` with the guards restored and a head-specific order body added.
Validation: `tsc` clean, `eslint src` 0 errors, all four parity/catalog gates green, and nine
contract suites green including the new CI-wired `team-release-control`; three pre-existing
failures unrelated to this feature remain, listed on the subtask plans.

## Deferred Findings

See the two subtask plans' `## Deferred Findings` sections — six items total, three NITs on
each subtask plus three pre-existing MAJORs (`_scheduleQueuePop`, the external head prompt
phrase, and two `stage-marker-commit` cases) that belong to other work.
