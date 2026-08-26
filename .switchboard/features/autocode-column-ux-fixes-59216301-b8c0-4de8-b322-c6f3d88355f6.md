# Autocode Column UX Fixes

**Complexity:** 5

## Goal

Fix two UX issues in the AUTOCODE column observed during testing: (1) cards displayed oldest-to-newest instead of newest-to-oldest due to a missing createdAt tiebreaker in the sort comparator, and (2) working status light not activating when the copy-prompt is pasted to an external interface because dispatched_at is never stamped.

## How the Subtasks Achieve This

- **Fix Autocode Column Sort Order — Missing createdAt Tiebreaker**: Adds a `createdAt` descending secondary tiebreaker to the AUTOCODE column's sort comparator in `kanban.html` (line 7944), matching the two-tier sort already used by normal columns (lines 7988–7995) and by `compareCardsByRecency` in terminals.js (line 5440). This makes the AUTOCODE column display newest-first consistently with every other column when `_ts` values are equal.
- **Light Up Working Status When Copy-Prompt Is Pasted to an External Interface**: Stamps `dispatched_at` via the existing `attributePasteDispatch` writer in the `promptSelected`, `promptAll`, and `dispatchFailedPromptReady` handlers when a prompt is copied to the clipboard for external paste. This lights the `is-working` ring so the operator can see which cards have active agents, regardless of where the prompt was sent. The existing timeout sweep and `**Stage Complete:**` marker parser turn the ring off.

## Dependencies & sequencing

- Subtasks are independent and can land in any order. The sort-order fix is a frontend-only change to `kanban.html`; the working-status fix is a backend change to `KanbanProvider.ts` (calling an existing `KanbanDatabase.ts` writer). They touch no shared files.
- Synergy (not a dependency): the working-status fix's `attributePasteDispatch` call bumps `updated_at`, which refreshes the card's `lastActivity`/`_ts`. This complements the sort-order fix — a freshly-prompted card sorts to the top of the AUTOCODE column. This works regardless of which subtask lands first.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix Autocode Column Sort Order — Missing createdAt Tiebreaker](../plans/feature_plan_20260819085447_autocode-column-sort-order-mismatch.md) — **PLAN REVIEWED** — ID: 843dea32-0570-48f2-a4a1-34eb0d221913
- [ ] [Light Up Working Status When Copy-Prompt Is Pasted to an External Interface](../plans/feature_plan_20260819085502_working-status-light-external-paste.md) — **PLAN REVIEWED** — ID: bd65dba1-887b-488f-a910-211a43379d03
<!-- END SUBTASKS -->

