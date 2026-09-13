# Board Rows Outlive Their Plans, and Nothing Archives Them

**Complexity:** 5

## Goal

Consolidated 2026-09-10: board rows outliving their plan files, the archive switch that never ran, and the plan API answering 200 with nothing. The feature kills the "empty success" in every costume it wears — a plan endpoint that returns 200 with `content: ""` for a file it could not read, a stale CLI binary that returns `data: []` for any query-string path, and a board read that silently truncates — and fixes the two hygiene faults that let dead rows accumulate: a `kanban_column` that survives the row's death, and a purge that only reaps `missing` rows. It is the standing fallback rule ("a fallback must never be indistinguishable from a real value") applied to every read of plan content, plan state, and board membership.

## How the Subtasks Achieve This

- **A Plan Whose File Is Gone Answers 200 With an Empty Body**: makes the plan-read endpoint distinguish "no file" from "empty file" so a missing plan is never reported as a success with nothing in it. Contributes the "empty success on a content read" kill.
- **A Dead Row Keeps Its Working Column, and Nothing Ever Reaps It**: routes every delete through `archivePlan` (the one seam that clears `kanban_column`) and widens the purge to reap `deleted` rows, so a dead row stops claiming a working column and has a path out of the table. Contributes the column-clearing invariant and the purge backstop.
- **Auto-Archive Has Never Run: the Advertised Switch Is Not the One the Code Reads**: unifies the two contradictory archive settings into one DB-backed key with an honest default (off), and makes "never run" reportable. Contributes the switch fix that lets archiving actually happen once the store placement is decided.
- **The Board's Active Read Has No Limit, So a Used Repo Loads Every Card**: puts a `LIMIT` + explicit `ORDER BY` on `getBoard` and makes a truncated board say "showing N of M". Contributes the "empty success by silent truncation" kill and the 1GB-board safety bound.
- **A First Run Imports Every Plan File as Active Work**: makes a first run a distinct event that lands historical plans outside the active set (age signalled from git/mtime, not the clock). Contributes the source-side bound that keeps a first run from filling a 1GB board with thousands of active cards.
- **A Stale CLI Binary Answers Every Board Read With an Empty Success**: wires a rebuild into the loop that matters (CLI/API source change → `dist/` rebuilt) and adds build-commit provenance, so the binary agents invoke can't drift from the source every gate is green against. Contributes the "empty success via a stale artifact" kill.

## Dependencies & sequencing

- **first-run + board-read are companions and should land together (or first-run first).** first-run keeps the active count small at the source; board-read caps the read when it is not. A `LIMIT` alone leaves a first run importing thousands and showing a permanently truncated board (correct, but useless); an import policy alone leaves a bounded read unsafe on a 1GB box. Neither blocks the other at the code level, but a survivable 1GB first run wants both.
- **dead-row + auto-archive are complementary and independent.** dead-row owns the delete-seam unification (route `tombstonePlan`/`purgeOrphanedPlans` through `archivePlan`) and the purge widening; auto-archive owns the switch unification. Neither pre-empts the other. auto-archive must NOT enable archiving before the store placement (`fbdddc53`) lands — that is a guard on auto-archive, not an ordering constraint between the two.
- **plan-gone and the CLI card are independent** of every other subtask (distinct surfaces: plan-endpoint content vs. CLI binary staleness).
- **No hard ordering constraint forces serialisation.** The subtasks are otherwise independent and can land in any order. The only shared-code relationships are the complementary delete/archive seams (dead-row/auto-archive) and the companion board-volume pair (first-run/board-read), both recorded above.
- **Prerequisite/guard:** auto-archive's effective default must stay off until `fbdddc53` (Storage topology) decides where the archive lives; state that dependency in the code, not just the plan.

## Team Dispatch Instructions

### A Plan Whose File Is Gone Answers 200 With an Empty Body
- **Seat:** Intern
- **Acceptance:**
  - A row whose `plan_file` does not exist returns a failure signal (e.g. `content: null` + `contentError` naming the resolved path), never `content: ""`.
  - A row whose plan file is zero bytes returns `content: ""` with no error — the two cases are distinguishable from the response alone.
  - A healthy plan is unchanged: same status, same body shape, content intact.
  - The plan-read path substitutes nothing on failure (no `catch { return '' }`).
- **Must not touch:** the purge sweep (`runPurgeSweep` / `purgeMissingPlansOlderThan`) — healthy and out of scope; the standalone deferred-init path (`1e5da4ea`) — separate defect.

### A Dead Row Keeps Its Working Column, and Nothing Ever Reaps It
- **Seat:** Coder
- **Acceptance:**
  - Deleting a card from a working column leaves no row asserting that working column (route deletes through `archivePlan`, which clears `kanban_column` to `COMPLETED`).
  - The purge (renamed from `purgeMissingPlansOlderThan`) removes an aged `deleted` row and archives its tracker counterpart when `deleteSyncEnabled` is on.
  - The purge leaves `completed` rows alone (the 440 are the only record — do not reap).
  - A query filtering only on `kanban_column` (no status predicate) returns no dead rows.
  - Undelete/restore recovers a sensible column rather than stranding the card.
- **Must not touch:** the auto-archive switch (owned by the auto-archive card); the store placement (`fbdddc53`).

### Auto-Archive Has Never Run: the Advertised Switch Is Not the One the Code Reads
- **Seat:** Coder
- **Acceptance:**
  - Exactly one setting decides auto-archiving (the DB `kanban.autoArchive` key); the contributed VS Code setting writes it rather than shadowing it.
  - A test asserts the contributed default and the code default are the same value; it fails if either moves.
  - With the setting off, the sweep runs and archives nothing — and reports which setting stopped it.
  - "Never run" / last-swept state is reportable where an operator looks, and reads the same on the standalone host and the extension host.
  - The effective default stays off (the dependency on `fbdddc53` is stated in the code).
- **Must not touch:** the purge predicate (owned by the dead-row card); the archive store placement (`fbdddc53`).

### The Board's Active Read Has No Limit, So a Used Repo Loads Every Card
- **Seat:** Coder
- **Acceptance:**
  - No `status = 'active'` SELECT in `KanbanDatabase` lacks a `LIMIT` (source-level check).
  - A workspace with 5,000 active rows materialises at most the ceiling; RSS after the read is flat against the 500-row measurement.
  - Cards in working columns survive truncation ahead of cards in `CREATED`.
  - The response carries the excluded count and the UI renders "showing N of M" — never a silently short board.
  - Both composition roots answer the bounded read identically.
- **Must not touch:** the `updated_at` window-key defect (its own card); webview pagination (separate question); retention/deletion (nothing here removes a row).

### A First Run Imports Every Plan File as Active Work
- **Seat:** Coder
- **Acceptance:**
  - A fresh board pointed at a repo with 2,500 plan files has an active count bounded by the policy, not the file count, and stays within the 1GB board-only budget.
  - One new plan file on an established board still lands in `CREATED` active (steady-state path untouched).
  - A plan placed as history can be moved back into a working column and behaves normally.
  - The first run's counts (imported vs placed-as-history) are surfaced; a run importing thousands is distinguishable from one importing a handful.
  - The plans directory is byte-identical before and after a first run.
  - Both composition roots take the same import path.
- **Must not touch:** the board-read `LIMIT` (owned by the board-read card); plan-file markdown (import reads, never writes); retention (nothing here removes a row).

### A Stale CLI Binary Answers Every Board Read With an Empty Success
- **Seat:** Coder
- **Acceptance:**
  - For `/kanban/plans?column=<id>`, `/kanban/plans?featureId=<id>`, and `/kanban/board`, a freshly built CLI and a direct HTTP request return identical row counts against the same host.
  - An old binary pointed at a newer host reports the mismatch rather than returning rows that silently differ.
  - A mangled request forces a non-zero exit and a stated reason, never `data: []`.
  - Every `switchboard api` invocation in `query-kanban/SKILL.md` returns rows against a board known to have them (contract test).
  - The CLI states the commit it was built from (`--version` / `/health`).
- **Must not touch:** `cmdApi` / `apiRequest` (correct — a change there is a fix to the wrong layer); `_handleGetPlans` or any read endpoint (`curl` demonstrates they are correct); the board's storage topology.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A Plan Whose File Is Gone Answers 200 With an Empty Body](../plans/a-plan-whose-file-is-gone-answers-200-with-an-empty-body.md) — **PLAN REVIEWED** — ID: 19ac4972-dced-4432-a153-32c562a9259e
- [ ] [A Dead Row Keeps Its Working Column, and Nothing Ever Reaps It](../plans/a-dead-row-keeps-its-working-column-and-nothing-reaps-it.md) — **PLAN REVIEWED** — ID: a9e39b4f-36ac-457c-b70c-4d0b1054caf9
- [ ] [Auto-Archive Has Never Run: the Advertised Switch Is Not the One the Code Reads](../plans/auto-archive-has-never-run-because-the-advertised-switch-is-not-the-one-read.md) — **PLAN REVIEWED** — ID: a064cf90-d7c0-4f23-a578-df2058f56969
- [ ] [The Board's Active Read Has No Limit, So a Used Repo Loads Every Card](../plans/the-board-read-has-no-limit-so-a-used-repo-loads-every-card.md) — **PLAN REVIEWED** — ID: 1cb5a069-e037-4c66-98be-033797e1f18e
- [ ] [A First Run Imports Every Plan File as Active Work](../plans/a-first-run-imports-every-plan-file-as-active-work.md) — **PLAN REVIEWED** — ID: 452a92a1-2d1e-4845-a2fd-1022b85e44ad
- [ ] [A Stale CLI Binary Answers Every Board Read With an Empty Success](../plans/the-cli-returns-an-empty-success-for-any-path-carrying-a-query-string.md) — **PLAN REVIEWED** — ID: d84ca3eb-9418-4da0-a9d6-f54861bea0af
<!-- END SUBTASKS -->

