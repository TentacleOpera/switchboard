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

- **Project:** switchboard
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
   `GlobalPlanWatcherService._handlePlanFile` (`src/services/GlobalPlanWatcherService.ts:444`),
   the existing-plan update branch (`617-697`) already reads content (`readFile` at 499) and
   calls `parsePlanMetadata` (500). After that call, if `metadata.stageComplete` is present:
   - Optionally verify it matches the plan's current `kanban_column` (skip clear on mismatch —
     stale marker guard, mirrors the manifest's `fromColumn` philosophy).
   - Call a new `db.clearWorkingState(planFile, workspaceId)` that sets `dispatched_at = NULL`.
   - Fire `_onPlanDiscovered` (already fired at line 723) so the board refreshes the light.

3. **mtime-gate interaction (critical).** The update branch is only entered when
   `fileMtime > plan.updatedAt` (`GlobalPlanWatcherService.ts:481-484`); appending the marker
   bumps mtime, so the branch runs. But the branch then persists `updatedAt: fileMtime` (via
   `insertFileDerivedPlan`), so the event is **seen exactly once** — you must clear the flag
   *within this handler invocation*; you cannot rely on re-reading the same unchanged file
   later.

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
