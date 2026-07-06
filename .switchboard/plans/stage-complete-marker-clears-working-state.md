# `**Stage Complete:**` marker parsing clears working state

## Goal

Let an agent turn its own card's activity light OFF by appending a `**Stage Complete:**`
line to the plan `.md`. The watcher detects the marker on the next file event and clears the
card's `dispatched_at` (the derived `working` flag then reads false).

### Core problem & root cause

There is no path for an agent to tell Switchboard "I'm done." The state added in
`working-state-model-and-dispatch-on.md` turns the light ON at dispatch but nothing turns it
OFF except the 20-min timeout. A frontmatter marker is the natural OFF-switch because the
watcher already re-reads a plan `.md` whenever its mtime advances.

### Design

The marker is a **pure OFF-switch — it does NOT move the card's column** (column moves happen
in advance, at dispatch). Recommended shape: `**Stage Complete: <COLUMN>**`, where `<COLUMN>`
is the stage the agent just finished. The column value is used only to (a) confirm the marker
matches the card's current column before clearing (so a stale marker copied into a re-dispatched
plan doesn't clear a fresh light), and (b) aid debugging — it is never used to move the card.

## Metadata

- **Project:** Switchboard
- **Tags:** kanban, watcher, frontmatter, parsing
- **Complexity:** 5

## Implementation

1. **Parse the marker.** `planMetadataUtils.ts` already has `extractEmbeddedMetadata(content,
   label)` (`src/services/planMetadataUtils.ts:27`) which matches `**Label:** value` and
   `> **Label:** value` case-insensitively — exactly the marker shape (it already backs
   `extractClickUpTaskId`/`extractLinearIssueId`). Add a `stageComplete?: string` field to
   `PlanMetadata` (`planMetadataUtils.ts:47-54`) parsed via
   `extractEmbeddedMetadata(content, 'Stage Complete')` inside `parsePlanMetadata`
   (`planMetadataUtils.ts:74`).

2. **Clear the flag in the watcher's update branch.** In
   `GlobalPlanWatcherService._handlePlanFile` (`src/services/GlobalPlanWatcherService.ts:445`),
   the file content is read (`readFile` at 509) and `parsePlanMetadata` is called at **510**
   — both run *before* the new-vs-existing split, so `metadata` is in scope for both branches.
   In the **existing-plan update branch** (the `else` at line 627, running to ~707), after the
   `parsePlanMetadata` result is available, if `metadata.stageComplete` is present:
   - Optionally verify it matches the plan's current `kanban_column` (skip clear on mismatch —
     stale marker guard, mirrors the manifest's `fromColumn` philosophy).
   - Call a new `db.clearWorkingState(planFile, workspaceId)` that sets `dispatched_at = NULL`.
   - The board refresh is already triggered: `_onPlanDiscovered.fire({ uri, workspaceRoot })`
     fires at **line 733** (inside the trailing `if (plan)` block), and `KanbanProvider`
     subscribes at `KanbanProvider.ts:535` → `refreshIfShowing(workspaceRoot)` (536). No extra
     fire is needed; just ensure the clear happens before line 733 in the same handler pass.

3. **mtime-gate interaction (critical).** The update branch is only entered when
   `fileMtime > plan.updatedAt` (the comparison at `GlobalPlanWatcherService.ts:491`);
   appending the marker bumps mtime, so the branch runs. But the branch then persists
   `updatedAt: fileMtime` (`updatedRecord.updatedAt = fileMtime` at 646, written via
   `insertFileDerivedPlan` at 651), so the event is **seen exactly once** — you must clear the
   flag *within this handler invocation*; you cannot rely on re-reading the same unchanged
   file later.

4. **Idempotency / do not re-fire.** Once `dispatched_at` is NULL, a subsequent unchanged-file
   scan is skipped by the mtime gate, so the clear naturally does not repeat. If the agent
   later re-appends or the file is touched with the marker still present, `clearWorkingState`
   is a harmless no-op (already NULL).

## User Review Required

- Confirm marker syntax: `**Stage Complete: <COLUMN>**` (column echoed for the stale-marker
  guard) vs a bare `**Stage Complete:**`.
- Confirm the stale-marker guard (clear only when the echoed column matches the card's current
  column) — recommended, prevents a copied marker from clearing a re-dispatched card.

## Complexity Audit

### Routine
- Adding a `stageComplete` field via the proven `extractEmbeddedMetadata` helper.
- A single-column `UPDATE plans SET dispatched_at = NULL` method.

### Complex / Risky
- **Single-shot detection.** Because the mtime gate self-advances (`updatedAt := fileMtime`),
  the marker is observed on exactly one handler pass. Any logic that assumes it can re-scan
  the file to re-read the marker is wrong. Clear inside `_handlePlanFile`.
- **Stale marker after re-dispatch.** If a plan is re-dispatched while an old `**Stage
  Complete:**` line is still in the file, the next unrelated file edit would clear the fresh
  light. The column-match guard closes this; without it, agents must delete the marker before
  re-dispatch.

## Edge-Case & Dependency Audit

- **Dependency:** requires `dispatched_at` + `clearWorkingState` from
  `working-state-model-and-dispatch-on.md`. Marker syntax must match the directive emitted by
  `stage-complete-prompt-directive.md`.
- **Debounce:** `_debounceHandleFile` (300ms, `GlobalPlanWatcherService.ts:420`) coalesces
  rapid saves — fine, the last read wins and still contains the marker.
- **Non-dispatched card:** clearing `dispatched_at` when it is already NULL is a no-op; a
  marker on a never-dispatched card does nothing, which is correct.
- **Epics:** epics are containers, not dispatched to agents — the marker path should be a
  no-op for `is_epic = 1` rows.

## Dependencies

- Requires `dispatched_at` + the `clearWorkingState(planFile, workspaceId)` method surface from
  `working-state-model-and-dispatch-on.md` (B-1). B-1 adds the column; this subtask adds the
  `clearWorkingState` method (a one-column `UPDATE plans SET dispatched_at = NULL WHERE
  plan_file = ? AND workspace_id = ?`) and the watcher call site.
- Marker label MUST match `stage-complete-prompt-directive.md` (B-3) via the shared
  `STAGE_COMPLETE_LABEL` constant.

## Proposed Changes

### src/services/planMetadataUtils.ts
- **Context:** shared embedded-metadata parser already used for ClickUp/Linear IDs.
- **Logic:** add `stageComplete?: string` to `PlanMetadata` (47-54); inside `parsePlanMetadata`
  (74) parse it via `extractEmbeddedMetadata(content, STAGE_COMPLETE_LABEL)` (import the shared
  label constant from B-3). Return it in the metadata object (104-110).
- **Edge cases:** the regex (line 28) matches `**Label:** value` and `> **Label:** value`
  case-insensitively — exactly the marker shape; a marker with no value still matches and
  yields `''` (treat present-but-empty as "clear without column guard").

### src/services/KanbanDatabase.ts
- **Context:** owns the `dispatched_at` column (added by B-1).
- **Logic:** add `clearWorkingState(planFile, workspaceId)` —
  `UPDATE plans SET dispatched_at = NULL WHERE plan_file = ? AND workspace_id = ?` (use
  `_ensureRelativePlanFile` + `_persistedUpdate` like `updateDispatchInfoByPlanFile` at 6929).
- **Edge cases:** no-op when `dispatched_at` is already NULL (correct); scope by workspace_id
  so a same-named file in another workspace is untouched.

### src/services/GlobalPlanWatcherService.ts
- **Context:** `_handlePlanFile` (445) re-reads a plan `.md` on mtime advance.
- **Logic:** in the existing-plan update branch (`else` at 627), after `parsePlanMetadata`
  (called at 510), if `metadata.stageComplete` is present: optionally guard on column match,
  call `db.clearWorkingState(...)`, then let the existing `_onPlanDiscovered.fire` at 733
  refresh the board.
- **Edge cases:** single-shot mtime gate (491/646/651) — clear must happen in this pass; stale
  marker after re-dispatch (column-guard closes it); no-op for epics.

## Adversarial Synthesis

Key risks: (1) the marker is observed on exactly one handler pass (the mtime gate
self-advances at 646/651) — any logic that defers the clear to a later scan is wrong; (2) a
stale `**Stage Complete:**` line left in a re-dispatched plan would clear the fresh light on
the next unrelated edit — the column-match guard is the mitigation, and it must compare
against the DB's current `kanban_column`, not the marker's echo, with a safe skip-on-mismatch;
(3) `parsePlanMetadata` runs for new plans too (510), so the clear logic must be gated to the
existing-plan branch only or a freshly-imported plan carrying a copied marker could null a
non-existent `dispatched_at` (harmless no-op, but the column guard would compare against a
just-inserted row's column — verify the guard reads post-insert state).

## Verification Plan

> Per session directives: no automated tests, no compilation. Verify via the installed VSIX.

### Manual checks
- Dispatch a card (light ON) → have the agent append `**Stage Complete: <COLUMN>**` to the
  plan `.md` and save → confirm the light turns OFF within the next watcher pass (≤ a few
  seconds, plus the 300ms debounce).
- Append a marker whose `<COLUMN>` does NOT match the card's current column → confirm the
  light stays ON (stale-marker guard).
- Re-dispatch a card whose plan file still contains an old marker → confirm the fresh light is
  not cleared by the stale marker (guard), and that the light clears correctly only when a
  fresh matching marker is appended.
- Confirm a marker on a never-dispatched / epic card does nothing (no error, no column move).
- Confirm the card's column does NOT move when the marker is parsed (marker is a pure
  OFF-switch).

### Recommendation
Complexity 5 → **Send to Coder.**
