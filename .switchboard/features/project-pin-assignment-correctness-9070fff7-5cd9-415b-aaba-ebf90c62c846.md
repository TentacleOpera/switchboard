# Project Pin Assignment Correctness

**Complexity:** 6

## Goal

A valid **Project:** pin resolves to unassigned on every fresh plan import, and the miss is then unrecoverable from the file. Two halves: find and fix the resolution failure, and let a pin fill an unassigned plan without ever moving an assigned one.

## How the Subtasks Achieve This

- **Let a `**Project:**` Pin Apply to an Unassigned Plan Instead of Being Frozen Forever**: Relaxes `insertFileDerivedPlan`'s ON CONFLICT self-assignment to an apply-if-empty CASE (name and id driven by one condition, feature-linked rows excluded) and stops the watcher's update branch from discarding the file's pin when the row is unassigned. This makes every missed pin — past and future — self-healing on the file's next import, while preserving the load-bearing invariant that a file re-import can never *move* an assigned card. Locked by a contract test covering fill, no-move, pin-removal, resolve-only, and subtask-skip.
- **Find and Fix Why a Valid `**Project:**` Pin Resolves to Unassigned on Every Fresh Plan Import**: Structural fix for the first-import failure: moves name→id resolution into the INSERT statement itself (a `COALESCE`d same-snapshot subquery), so the lookup and the write can never see two different DB snapshots — the resolve-miss class that fits all recorded evidence becomes impossible by construction. Ships permanent, near-zero-noise tripwires (gated `[pin]` DROP lines with `instanceId` in the exthost log; a `[pin-parse]` anomaly line in the Switchboard output channel) so any residual mechanism names itself in logs on its next occurrence. A regression test asserts a valid pin resolves on *first* import, the fallback works at the statement level, resolve-only survives, and the stranded name-without-id state is unrepresentable.

Together they close both failure layers: subtask 2 makes the pin work on first import; subtask 1 guarantees that any miss that still slips through is recoverable from the file itself rather than frozen forever.

## Dependencies & sequencing

- **Cross-feature dependencies:** none — both subtasks touch only `KanbanDatabase.ts` / `PlanIngestionEngine.ts` internals plus contract tests, and nothing from other features must land first.
- **Single dispatch, one coder, both subtasks:** everything is fully specified and headlessly testable — no diagnosis session, live-window reproduction, or human gate anywhere in the work. Within the session, implement the **apply-if-empty subtask first**, then the same-snapshot resolution subtask, keeping both contract tests green at the end.
- **Shared surface — write the SQL once:** both subtasks edit `insertFileDerivedPlan`'s statement (subtask 2 computes the VALUES via the same-snapshot subquery; subtask 1 adds the apply-if-empty CASEs in ON CONFLICT that consume them as `excluded.*`). Author the combined statement in one edit; the exact combined shape is probe-verified against the vendored sql.js (SQLite 3.49.1). Remaining overlap is trivial: `PlanIngestionEngine.ts` (different lines: ~795 vs ~705) and one appended script line each in `package.json`.
- **Guards that must survive both subtasks:** resolve-only semantics (an unknown pin never mints a `projects` row), the no-move invariant (a file re-import never moves an assigned card), and subtask project governance (a subtask's project comes from its feature via the existing cascade / startup reconcile).
- **User's post-merge acceptance (after build + sync + reload):** author one pinned plan → lands assigned on first import; `touch` the 7 known-stuck files → each heals; if anything still lands unassigned, the tripwire logs name the mechanism.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Let a `**Project:**` Pin Apply to an Unassigned Plan Instead of Being Frozen Forever](../plans/feature_plan_20260730130632_project-pin-unrecoverable-once-missed.md) — **CODE REVIEWED**
- [ ] [Find and Fix Why a Valid `**Project:**` Pin Resolves to Unassigned on Every Fresh Plan Import](../plans/feature_plan_20260730130633_project-pin-resolves-to-unassigned-on-import.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->


## Code Review (2026-07-30, reviewer pass)

Both subtasks reviewed as one delivery unit against the jointly-written `insertFileDerivedPlan` statement. Verdict: the implemented shape matches both plans (apply-if-empty CASEs, same-snapshot COALESCE/subquery VALUES, engine guard, tripwires), but the delivery shipped **uncompiled and untested** — a CRITICAL backtick-in-template-literal syntax error broke the whole build, both contract tests could not initialize their DB, one test violated the `plans.session_id` UNIQUE constraint, and neither test was wired into CI. All four defects fixed in review; two unrelated build-blocking type errors from the tickets feature (swept into the same auto-commit) were also fixed to restore compile. Final state: tsc clean, webpack green, both contract tests PASS, both mutation checks bite (no-move assertion and fallback assertion each fail under the respective mutation), standing gates green (`verb-returns` / `push-routing` / `parity` / `catalog`), and both tests now run in `.github/workflows/integration-tests.yml`. Remaining: the 7 stuck cards heal on next file touch; post-merge acceptance (build + sync + reload, author one pinned plan) is the user's step.
