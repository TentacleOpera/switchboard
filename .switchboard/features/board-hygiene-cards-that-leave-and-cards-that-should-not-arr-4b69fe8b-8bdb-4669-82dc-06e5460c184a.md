# Board Hygiene — Cards That Leave, and Cards That Should Not Arrive

**Complexity:** 4

## Goal

Five plans on board population: stars that never expire, completed cards that never archive, reviewer findings that pile into a memo, plans filed into already-coded features, and stranded rows the scan never reconciles.

## How the Subtasks Achieve This

- **Reconcile Disk-vs-DB on Every Scan Tick — Clear Stranded Cards from Remote `git rm`**: wires the existing `purgeOrphanedPlans` method into `runPurgeSweep` so plan files deleted while no watcher was alive (remote `git rm`, machine off) are tombstoned on the next scan tick instead of leaving stranded `active` cards on the board forever.
- **A star is a sprint designation with no end — 37 of 51 have decayed into CODE REVIEWED**: adds a per-board setting naming a column on whose entry `priority_starred` is cleared, so the starred set stays the short, reportable list it exists to be — the star retires itself at a transition the system already observes.
- **Reviewer Findings Become Short Backlog Cards, Not a Memo Nobody Drains**: rewrites the reviewer directive so remaining risks land on the board as short, individually addressable Backlog cards (each linking to the plan it was found reviewing) instead of accumulating in `.switchboard/memo.md`, which nobody drains.
- **Add a Resident Rule: Never File a New Plan Into an Already-Coded Feature**: adds a resident rule (re-presented every turn) telling agents not to attach a new plan to a feature whose subtasks are already coded, because nothing will ever pick it up — the failure is quiet by construction.
- **Archive on Startup What Has Been in Completed Two Weeks**: replaces the dwell-triggered auto-completion sweep with a single startup pass that archives cards already in COMPLETED for two or more weeks, so the board does not grow without bound and the foot-gun of force-completing resting cards is removed.

## Dependencies & sequencing

- Subtasks are **independent** and can land in any order — each touches a distinct mechanism (orphan reconciliation, star lifecycle, reviewer prompts, a resident rule, startup archival).
- **Soft ordering note (same-coder):** the star-clear subtask and the archive subtask both touch column-transition UPDATEs in `KanbanDatabase`. The star-clear subtask *modifies* those UPDATEs (adds a `priority_starred = 0` term); the archive subtask only *reads* `column_entered_at` (already set by those UPDATEs). If the same coder edits the same UPDATE statement for both, land the star-clear subtask first so the archive subtask's read target is stable. Not required — they are compatible in either order.
- **External prerequisite (not within this feature):** the resident-rule subtask's standalone-host delivery is blocked by `eb2456e0` (managed-block refresh is not wired into `bootstrap.ts`). The extension host can deliver the rule immediately; standalone parity waits on that external card. This does not block any other subtask in this feature.

## Team Dispatch Instructions

### Reconcile Disk-vs-DB on Every Scan Tick — Clear Stranded Cards from Remote `git rm`
- **Seat:** Intern
- **Acceptance:**
  - `runPurgeSweep()` tombstones an `active` plan whose file is missing to `status='deleted'`; an `active` plan whose file exists stays `active`.
  - The `purgeOrphanedPlans` call sits inside the per-folder loop and inside the `isGitOpActive` guard (skipped during git operations).
  - The existing `plan-creation-status-regression.test.js` test for `purgeOrphanedPlans` still passes unchanged.
- **Must not touch:** `KanbanDatabase.purgeOrphanedPlans` (already exists and tested), `TaskViewerProvider._syncKanbanDbFromSheetsSnapshot` (unchanged empty-DB bootstrap caller). No source changes outside `PlanIngestionEngine.ts`.

### A star is a sprint designation with no end — 37 of 51 have decayed into CODE REVIEWED
- **Seat:** Intern
- **Acceptance:**
  - With the setting on a column, a card arriving there carries `priority_starred = 0`; with "Never", a starred card keeps its star across every transition.
  - The rule fires on **every** column-transition UPDATE path (`updateColumnByPlanFileWithReason`, `cascadeFeatureByPlanId` feature + subtask rows, `movePlanByPlanFile`) — not path-dependent.
  - A feature moved into the configured column drops the star on the feature AND its cascaded subtasks.
  - The setting clears `priority_starred` only — `priority` is never written by this rule.
  - The KanbanProvider comment at `:8656` ("priority_starred is untouched") is updated to reflect the new behaviour.
- **Must not touch:** the priority-field work (`602832e6`, `4115b513`, `d1556fd0`, `20d4a089`, `f144f810`) — compatible but out of scope; do not generalise the setting to priority.

### Reviewer Findings Become Short Backlog Cards, Not a Memo Nobody Drains
- **Seat:** Intern
- **Acceptance:**
  - A reviewer finishing a review with N remaining risks produces N plan files, each landing in `BACKLOG` with no manual move.
  - No reviewer path appends to `.switchboard/memo.md`; `reviewerRisksToMemo` has no producer.
  - A finding filed from a worktree lands in the main checkout and survives cleanup — verified on all three directive emitters, including the two that send no path line.
  - `/switchboard-memo` capture and the `memo-to-plans` job are unchanged.
- **Must not touch:** the `memo-to-plans` daily job, `/switchboard-memo` capture mode, and `.switchboard/memo.md` itself (the operator's capture surface stays).

### Add a Resident Rule: Never File a New Plan Into an Already-Coded Feature
- **Seat:** Intern
- **Acceptance:**
  - The rule appears in the emitted `CLAUDE.md` managed block, sourced from `RESIDENT_PROTOCOL_BODY` (not hand-edited into the markdown).
  - `claude-protocol-block-size-contract.test.js` passes with the rule present and the `DOCS_POINTER_RULE` headroom intact (the 800-char gate is not raised).
  - The rule does not read as forbidding subtasks on a feature still being planned.
- **Must not touch:** `AGENTS.md` and `CLAUDE.md` directly (hand-edits are silently overwritten by the scaffold); the `SIZE_GATE` (do not raise it — shorten the rule instead). Target the resident body by symbol; if `6c25a1e1` has relocated the helpers, follow them to their new home.

### Archive on Startup What Has Been in Completed Two Weeks
- **Seat:** Coder
- **Acceptance:**
  - On startup, `COMPLETED` cards with `column_entered_at` ≥ 2 weeks old are archived; younger ones are not.
  - No card is ever moved *into* COMPLETED by this mechanism (the dwell-triggered auto-completion is deleted, not reconfigured); no periodic sweep runs.
  - Both hosts archive identically (extension and standalone — `bootstrap.ts` is wired).
  - An archived row carries `status = 'completed'` (not `'archived'`); a feature and its subtasks archive together.
  - The first run reports the archived count rather than acting silently.
- **Must not touch:** the `column_entered_at` field semantics (V61 migration — already populated and rewritten on every transition). The plan-file-move decision is recorded as an Outstanding Question in the plan — confirm with the operator before adding `unlink`/`rename` to `ArchiveManager`.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Reconcile Disk-vs-DB on Every Scan Tick — Clear Stranded Cards from Remote `git rm`](../plans/feature_plan_20260823102112_purge-orphaned-plans-on-scan-tick.md) — **PLAN REVIEWED** — ID: cf95c461-7b75-4d85-9367-e2455d46ec96
- [ ] [A star is a sprint designation with no end — 37 of 51 have decayed into CODE REVIEWED](../plans/drop-starred-status-on-entering-a-configured-column.md) — **PLAN REVIEWED** — ID: 685a4ac5-708a-44a7-a6a9-dc0bfea6d919
- [ ] [Reviewer Findings Become Short Backlog Cards, Not a Memo Nobody Drains](../plans/reviewer-findings-become-backlog-cards-instead-of-piling-into-a-memo.md) — **PLAN REVIEWED** — ID: c5818617-62e1-4eae-8e06-c2c443db9d87
- [ ] [Add a Resident Rule: Never File a New Plan Into an Already-Coded Feature](../plans/add-a-resident-rule-against-filing-plans-into-coded-features.md) — **PLAN REVIEWED** — ID: 3fe13494-1df2-4c90-97b1-221b1ea8bcae
- [ ] [Archive on Startup What Has Been in Completed Two Weeks](../plans/archive-on-startup-what-has-been-completed-two-weeks.md) — **PLAN REVIEWED** — ID: ccffc96a-1451-464b-8380-0285c6a14c54
<!-- END SUBTASKS -->

