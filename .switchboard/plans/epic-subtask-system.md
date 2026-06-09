# Epic & Subtask System for Switchboard Kanban

## Metadata

**Complexity:** 8
**Tags:** frontend, backend, database, api, ui, ux, feature

## Goal

Introduce an "epic" card type to the Switchboard Kanban board. An epic is a plan card that can own invisible subtasks (other plan cards). When an epic is moved to a new column, all subtasks move with it on the backend. When dispatched to an agent, the prompt includes the epic plus all subtask plans, along with an instruction to use the receiving tool's native subagent/worktree orchestration. Subtasks are managed in `planning.html`, not on the main board.

## Problem Analysis

Switchboard currently treats every plan as a standalone unit. For large features that naturally decompose into multiple plans, users must either (a) batch all plans into one prompt and hope the receiving tool handles decomposition, or (b) move cards one-by-one through columns. Neither scales well.

The existing `useWorktreesPerPlan` addon (`agentConfig`) injects a generic directive into custom-agent prompts, but there is no first-class UI concept of a "project epic" that groups related plans. This forces users to mentally track which plans belong together.

By adding epics, Switchboard owns the *project management* layer (grouping, column state, locking) while delegating the *execution* layer (subagents, worktrees, per-plan implementation) to the receiving tool.

## Scope

### In Scope
- DB schema changes: `is_epic`, `epic_id` on `plans` table; new `epic_config` meta table.
- Kanban board UI: epic card rendering (different color), "Convert to Epic" action, drag-drop epic moves subtasks invisibly.
- `planning.html` epic management view: add/remove subtasks, view epic details.
- Backend logic: epic CRUD, column-move cascading, subtask locking rules, delete-with-orphan modal.
- Prompt builder: epic-specific injection for batch dispatches.
- Agent skill: convert plan to epic via DB update.
- DB migrations for existing workspaces.

### Out of Scope
- Replacing the Worktrees tab — it coexists as a workspace-level branching feature.
- Progress indicators on epic cards (Switchboard offloads progress to downstream tools; this policy does not change).
- Sub-subtasks (epics cannot contain other epics).

## Database Schema

### Migration V28 — Epic Support

```sql
-- 1. Add epic columns to plans table
ALTER TABLE plans ADD COLUMN is_epic INTEGER DEFAULT 0;
ALTER TABLE plans ADD COLUMN epic_id TEXT DEFAULT '';

-- 2. Index for fast subtask lookups
CREATE INDEX IF NOT EXISTS idx_plans_epic_id ON plans(epic_id);
CREATE INDEX IF NOT EXISTS idx_plans_is_epic ON plans(is_epic);

-- 3. Epic configuration (one row per workspace, stored in existing config table)
-- Keys (no new table needed):
--   epic_lock_columns    -> comma-separated list of columns where subtasks are locked (default: 'IN PROGRESS,CODE REVIEW,REVIEWED,DONE')
--   epic_prompt_template -> user-editable prompt suffix for epic dispatches
```

### Data Integrity Rules (enforced in code, not DB constraints)

- A plan with `is_epic = 1` **cannot** have `epic_id` set (epics cannot be subtasks).
- A plan with `epic_id` set **must** point to a plan where `is_epic = 1`.
- A plan can belong to **at most one** epic.
- Circular containment is forbidden (a subtask's epic cannot itself be a subtask of that subtask).

## Backend Changes

### KanbanDatabase.ts

1. Add `is_epic` and `epic_id` to `SCHEMA_SQL` and `SCHEMA_PLAN_COLUMN_DEFS`.
2. Add `MIGRATION_V28_SQL` with the ALTER TABLE statements above.
3. Update `PLAN_COLUMNS` constant to include new fields.
4. Update `_ensureSchemaColumns()` to backfill `is_epic = 0` and `epic_id = ''`.

### KanbanProvider.ts

**New message handlers:**

| Message Type | Action |
|-------------|--------|
| `convertToEpic` | Sets `is_epic = 1`, clears `epic_id`. Rejects if plan already has `epic_id`. |
| `addSubtaskToEpic` | Sets `epic_id` on target plan. Validates epic exists and is in an unlocked column. |
| `removeSubtaskFromEpic` | Clears `epic_id` on target plan. |
| `deleteEpic` | If `deleteSubtasks = true`, deletes all plans where `epic_id = <epic>`. If `false`, clears `epic_id` on all subtasks (orphan them). Then delete epic plan. |
| `getEpicDetails` | Returns epic plan + array of subtask plans (for planning.html). |
| `updateEpicConfig` | Stores `epic_lock_columns` and `epic_prompt_template` in config table. |

**Modified handlers:**

- `moveCardToColumn` / column-advance automation: When moving an epic, find all plans with matching `epic_id` and move them to the same column *before* building the dispatch prompt. Subtask moves are silent (no UI refresh for invisible cards).
- `deleteCard` / `archiveCard`: If the card is an epic, show a VS Code modal: "Delete epic and all N subtasks?" Yes/No/Cancel.
- Prompt building (`_cardsToPromptPlans`, `generateUnifiedPrompt`): When the card list includes an epic, fetch its subtasks and append them to the `BatchPromptPlan[]` array. Inject the epic prompt suffix.

### agentPromptBuilder.ts

**New `PromptBuilderOptions` field:**
```ts
epicMode?: boolean;        // true when dispatching an epic
epicTopic?: string;        // the epic's topic/title
subtaskCount?: number;     // number of subtasks included
```

**New directive constant:**
```ts
export const EPIC_ORCHESTRATION_DIRECTIVE = (epicTopic: string, count: number) =>
    `EPIC MODE: You are implementing the epic "${epicTopic}" which consists of ${count} subtask(s).\n` +
    `Use your native subagent or orchestration capabilities to handle each subtask. ` +
    `If your tool supports worktree-per-plan isolation, activate it now. ` +
    `If you do not support subagents, handle each subtask sequentially in the order listed below. ` +
    `All subtasks are part of a single delivery unit — do not treat them as independent tickets.`;
```

**Injection point:** In `buildKanbanBatchPrompt`, after the `executionDirective` and before `safeguardsBlock` for all roles (planner, lead, coder, intern, reviewer, analyst). This ensures the epic context is prominent.

**Plan list format for epics:** The existing `buildPromptDispatchContext` already produces:
```
- [Topic] Plan File: /absolute/path.md
```
For epics, prepend the epic itself as the first item, then list subtasks indented or with a `[SUBTASK]` prefix to make the hierarchy clear to the agent.

## Frontend Changes

### kanban.html

**Board rendering (`renderKanbanCard` or equivalent):**
- If `card.isEpic === true`, apply a distinct CSS class (e.g., `epic-card`) with a purple/blue left border or background tint.
- Epic cards show a small badge: "EPIC" + subtask count (e.g., "3 subtasks"). This is **metadata**, not a progress bar.

**Card context menu:**
- Add "Convert to Epic" option. Visible when:
  - Card is not already an epic.
  - Card does not have `epic_id` set (cannot convert a subtask to an epic).
- Post `convertToEpic` message on click.

**Drag-and-drop / column buttons:**
- No change needed for the user action — they drag the epic card as normal.
- Backend handles subtask movement silently.

### planning.html

**New "Epics" view in the Kanban Plans panel:**
- Toggle between "All Plans" and "Epics" view.
- Epics view shows a list of epic cards. Clicking an epic expands it to show subtasks (with file paths, columns, statuses).
- "Add subtask" button on each epic: opens a picker of plans that are (a) not epics, (b) not already subtasks, (c) in an unlocked column.
- "Remove" button next to each subtask to orphan it.
- "Delete Epic" button with the same Yes/No/Cancel modal logic as the board.
- "Epic Config" section: editable textarea for the prompt template, and a multi-select for locking columns.

## Agent Skill

**New skill file:** `.agent/skills/convert_to_epic.md`

```markdown
---
description: Convert a plan to an epic via the Kanban database
---

## Usage

Call the Switchboard Kanban DB to mark a plan as an epic.

### Parameters
- `session_id` — the plan's session_id
- `workspace_root` — absolute path to the workspace

### SQL
UPDATE plans SET is_epic = 1, epic_id = '' WHERE session_id = ? AND workspace_id = ?;
```

The skill is registered in the skill loader so agents can discover it.

## Migration & Backward Compatibility

1. **Existing databases:** `MIGRATION_V28_SQL` adds columns with defaults. All existing plans remain non-epics.
2. **Existing prompts:** No change unless the dispatched card is explicitly an epic. Regular plans continue to use the existing prompt format.
3. **Existing worktrees:** The worktree tab is untouched. Epics and worktrees are orthogonal concerns.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| **Prompt bloat** — an epic with 15 subtasks could exceed token limits. | Cap subtasks at a configurable limit (default 20). If exceeded, show a warning and truncate. |
| **Column name drift** — users may rename columns, breaking the lock-column config. | Store column IDs (not labels) in `epic_lock_columns`. The config UI resolves labels at display time. |
| **Race condition** — two users move an epic and a subtask simultaneously. | SQLite serializes writes per connection. The backend transaction in `moveCardToColumn` already locks the row. |
| **Orphaned subtasks** — a subtask's epic is deleted without clearing `epic_id`. | The delete handler explicitly clears `epic_id` on all subtasks before deleting the epic. |
| **Agent confusion** — the epic directive might conflict with `useWorktreesPerPlan` or `noSubagentsEnabled`. | Epic mode takes precedence: if `epicMode = true`, it overrides `useSubagentsEnabled` but respects `noSubagentsEnabled` (falls back to sequential). |

## Testing Strategy

1. **Unit tests (KanbanDatabase):**
   - Migration V28 applies cleanly to empty and populated DBs.
   - `_ensureSchemaColumns` backfills defaults.

2. **Unit tests (KanbanProvider):**
   - `convertToEpic` rejects subtasks.
   - `addSubtaskToEpic` rejects when epic is in a locked column.
   - `moveCardToColumn` moves epic + subtasks atomically.
   - `deleteEpic` with `deleteSubtasks=true` removes all rows.
   - `deleteEpic` with `deleteSubtasks=false` orphans subtasks.

3. **Integration tests (agentPromptBuilder):**
   - `buildKanbanBatchPrompt` injects `EPIC_ORCHESTRATION_DIRECTIVE` when `epicMode = true`.
   - Plan list includes epic + subtasks in correct order.
   - `noSubagentsEnabled` overrides epic directive to sequential fallback.

4. **Manual tests:**
   - Create epic → add subtasks → move epic through columns → verify subtask columns in DB.
   - Dispatch epic to clipboard → inspect prompt text.
   - Delete epic with and without subtasks.

## Open Questions

1. Should the epic prompt template be per-workspace or global? *(Proposed: per-workspace, stored in config table.)*
2. Should subtasks inherit the epic's `repo_scope` and `project` fields? *(Proposed: no — subtasks are independent plans and may target different repos.)*
3. What is the maximum subtask count before truncation? *(Proposed: 20, configurable in epic config.)*
4. Should an epic card show the aggregate complexity of its subtasks? *(Proposed: no — Switchboard does not compute aggregate complexity.)*
