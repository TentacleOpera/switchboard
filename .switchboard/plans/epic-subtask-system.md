# Epic & Subtask System for Switchboard Kanban

## Goal

Introduce an "epic" card type to the Switchboard Kanban board. An epic is a plan card that can own invisible subtasks (other plan cards). When an epic is moved to a new column, all subtasks move with it on the backend. When dispatched to an agent, the prompt includes the epic plus all subtask plans, along with an instruction to use the receiving tool's native subagent/worktree orchestration. Subtasks are managed in `planning.html`, not on the main board.

## Problem Analysis

Switchboard currently treats every plan as a standalone unit. For large features that naturally decompose into multiple plans, users must either (a) batch all plans into one prompt and hope the receiving tool handles decomposition, or (b) move cards one-by-one through columns. Neither scales well.

The existing `useWorktreesPerPlan` addon (`agentConfig`) injects a generic directive into custom-agent prompts, but there is no first-class UI concept of a "project epic" that groups related plans. This forces users to mentally track which plans belong together.

By adding epics, Switchboard owns the *project management* layer (grouping, column state, locking) while delegating the *execution* layer (subagents, worktrees, per-plan implementation) to the receiving tool.

## Metadata

**Complexity:** 8
**Tags:** frontend, backend, database, api, ui, ux, feature

## User Review Required

- Should the epic prompt template be per-workspace or global? *(Proposed: per-workspace, stored in config table.)*
- Should subtasks inherit the epic's `repo_scope` and `project` fields? *(Proposed: no — subtasks are independent plans and may target different repos.)*
- What is the maximum subtask count before truncation? *(Proposed: 20, configurable in epic config.)*
- Should an epic card show the aggregate complexity of its subtasks? *(Proposed: no — Switchboard does not compute aggregate complexity.)*

## Complexity Audit

### Routine
- DB migration V29: two ALTER TABLE statements + two indexes
- Adding `is_epic`, `epic_id` to `PLAN_COLUMNS`, `SCHEMA_SQL`, `UPSERT_PLAN_SQL`
- Adding `isEpic`, `epicId` to `KanbanPlanRecord` and `KanbanCard` interfaces
- Epic CSS class on kanban cards (purple/blue left border + badge)
- "Convert to Epic" context menu item in kanban.html
- `getEpicDetails` message handler (read-only query)
- `removeSubtaskFromEpic` message handler (clear `epic_id`)
- `updateEpicConfig` message handler (config table read/write)
- Agent skill file `.agent/skills/convert_to_epic.md`
- Backward compatibility: existing plans unaffected, no prompt changes for non-epic cards

### Complex / Risky
- Epic column cascade in `moveCardToColumn`: must move all subtasks atomically in a single transaction
- `deleteEpic` with orphan-vs-delete modal: webview confirmation + conditional cascade delete
- Prompt builder epic injection: `EPIC_ORCHESTRATION_DIRECTIVE` + subtask plan list formatting + interaction with `noSubagentsEnabled`/`useWorktreesPerPlanEnabled`
- `addSubtaskToEpic` validation: reject if epic in locked column, reject if target is already an epic, reject circular containment
- Prompt truncation at configurable limit: must leave truncated subtasks in consistent state (not moved with epic)
- `planning.html` Epics view: new toggle, subtask picker, expand/collapse UI

## Edge-Case & Dependency Audit

- **Race Conditions:** Two users move an epic and a subtask simultaneously. SQLite serializes writes per connection. The backend transaction in `moveCardToColumn` must wrap epic + all subtask updates in a single transaction to prevent partial moves.
- **Security:** Agent skill does raw SQL — must route through KanbanProvider validation instead of direct DB writes to prevent bypassing integrity rules.
- **Side Effects:** Moving an epic cascades column changes to invisible subtasks. If a subtask is also being individually moved by another user, the last write wins. The epic move should log a warning if subtasks were in a different column than expected.
- **Dependencies & Conflicts:** `MIGRATION_V28_SQL` already exists (project sentinel normalization). Epic migration MUST be V29. `PromptBuilderOptions` already has `useWorktreesPerPlanEnabled` and `noSubagentsEnabled` — epic mode must interact correctly with these (epic overrides `useSubagentsEnabled`, respects `noSubagentsEnabled`).

## Dependencies

- sess_epic_subtask_system — Epic & Subtask System for Switchboard Kanban (this plan)

## Adversarial Synthesis

Key risks: V28 migration number collision (must be V29), non-atomic epic+subtask column cascade causing inconsistent state, and missing TypeScript interface updates (`KanbanPlanRecord`, `KanbanCard`) that would prevent the UI from rendering epic metadata. Mitigations: renumber to V29, wrap cascade moves in DB transactions, update all interfaces and SQL constants in the same change.

## Scope

### In Scope
- DB schema changes: `is_epic`, `epic_id` on `plans` table; config keys for epic settings.
- Kanban board UI: epic card rendering (different color), "Convert to Epic" action, drag-drop epic moves subtasks invisibly.
- `planning.html` epic management view: add/remove subtasks, view epic details.
- Backend logic: epic CRUD, column-move cascading (transactional), subtask locking rules, delete-with-orphan modal.
- Prompt builder: epic-specific injection for batch dispatches.
- Agent skill: convert plan to epic via KanbanProvider message (not raw SQL).
- DB migrations for existing workspaces.

### Out of Scope
- Replacing the Worktrees tab — it coexists as a workspace-level branching feature.
- Progress indicators on epic cards (Switchboard offloads progress to downstream tools; this policy does not change).
- Sub-subtasks (epics cannot contain other epics).

## Database Schema

### Migration V29 — Epic Support

```sql
-- 1. Add epic columns to plans table
ALTER TABLE plans ADD COLUMN is_epic INTEGER DEFAULT 0;
ALTER TABLE plans ADD COLUMN epic_id TEXT DEFAULT '';

-- 2. Index for fast subtask lookups
CREATE INDEX IF NOT EXISTS idx_plans_epic_id ON plans(epic_id);
CREATE INDEX IF NOT EXISTS idx_plans_is_epic ON plans(is_epic);

-- 3. Epic configuration (stored in existing config table as key-value pairs)
-- Keys:
--   epic_lock_columns    -> comma-separated list of column IDs where subtasks are locked (default: 'IN PROGRESS,CODE REVIEW,REVIEWED,DONE')
--   epic_prompt_template -> user-editable prompt suffix for epic dispatches
--   epic_max_subtasks    -> maximum subtask count before truncation warning (default: '20')
```

### Data Integrity Rules (enforced in code, not DB constraints)

- A plan with `is_epic = 1` **cannot** have `epic_id` set (epics cannot be subtasks).
- A plan with `epic_id` set **must** point to a plan where `is_epic = 1`.
- A plan can belong to **at most one** epic.
- Circular containment is impossible by construction: `is_epic = 1` implies `epic_id = ''`, and `epic_id != ''` implies `is_epic = 0`.

## Backend Changes

### KanbanDatabase.ts

**File:** `src/services/KanbanDatabase.ts`

1. **`SCHEMA_SQL`** (line 89-146): Add `is_epic INTEGER DEFAULT 0` and `epic_id TEXT DEFAULT ''` to the `plans` CREATE TABLE statement, after `worktree_status`.

2. **`MIGRATION_V29_SQL`** (add after line 444): New migration constant with the ALTER TABLE + CREATE INDEX statements above.

3. **`PLAN_COLUMNS`** (line 488-491): Append `, is_epic, epic_id` to the column list.

4. **`UPSERT_PLAN_SQL`** (line 453-483): Add `is_epic, epic_id` to both the INSERT column list and VALUES placeholder list. Add `is_epic = excluded.is_epic, epic_id = excluded.epic_id` to the ON CONFLICT UPDATE SET clause.

5. **`KanbanPlanRecord` interface** (line 19-44): Add `isEpic: number;` and `epicId: string;` fields.

6. **`_runMigrations()`** (after line 3819): Add V29 migration block following the existing pattern:
   ```typescript
   const v29 = await this.getMigrationVersion();
   if (v29 < 29) {
       for (const sql of MIGRATION_V29_SQL) {
           try { this._db.exec(sql); } catch (e) {
               console.debug('[KanbanDatabase] V29 migration step skipped:', e);
           }
       }
       await this.setMigrationVersion(29);
       console.log('[KanbanDatabase] V29 migration completed: epic support columns added');
   }
   ```

7. **`_ensureSchemaColumns()`** (line 3833): No changes needed — it auto-reconciles from `SCHEMA_SQL`. Adding columns to `SCHEMA_SQL` is sufficient.

8. **New method `getSubtasksByEpicId(epicPlanId: string)`**: Returns all plans where `epic_id = epicPlanId`. Used by cascade move and prompt builder.

9. **New method `updateColumnTransaction(sessionIds: string[], targetColumn: string)`**: Moves multiple plans to the same column in a single transaction. Used for epic cascade.

### KanbanProvider.ts

**File:** `src/services/KanbanProvider.ts`

**New `KanbanCard` interface fields** (line 81-92):
```typescript
isEpic?: boolean;
epicId?: string;
subtaskCount?: number; // populated at read time for badge display
```

**New message handlers** (add cases in `_handleMessage`, line 3942+):

| Message Type | Action |
|-------------|--------|
| `convertToEpic` | Sets `is_epic = 1`, clears `epic_id`. Rejects if plan already has `epic_id` set (is a subtask). |
| `addSubtaskToEpic` | Sets `epic_id` on target plan. Validates: epic exists, epic is in an unlocked column, target is not already an epic, target is not already a subtask of another epic. |
| `removeSubtaskFromEpic` | Clears `epic_id` on target plan. |
| `deleteEpic` | If `deleteSubtasks = true`, deletes all plans where `epic_id = <epicPlanId>`. If `false`, clears `epic_id` on all subtasks (orphan them). Then delete epic plan. |
| `getEpicDetails` | Returns epic plan + array of subtask plans (for planning.html). |
| `updateEpicConfig` | Stores `epic_lock_columns`, `epic_prompt_template`, `epic_max_subtasks` in config table. |

**Modified `moveCardToColumn`** (line 3764-3784):
- After `db.updateColumn(sessionId, targetColumn)`, check if the moved card is an epic (`isEpic === true`).
- If epic: call `db.getSubtasksByEpicId(planId)` to get all subtask session IDs, then call `db.updateColumnTransaction(subtaskSessionIds, targetColumn)` to move them atomically in the same logical operation.
- Subtask moves are silent — no UI refresh triggered for invisible cards.

**Modified `deleteCard` / `archiveCard`**:
- If the card is an epic, the webview must show a confirmation: "This is an epic with N subtask(s). Delete subtasks too?" Options: "Delete all", "Orphan subtasks", "Cancel".
- The webview posts `deleteEpic` with `deleteSubtasks: boolean`. The handler performs the cascade.

**Modified prompt building** (`_cardsToPromptPlans`, `generateUnifiedPrompt`):
- When the card list includes an epic, fetch its subtasks via `db.getSubtasksByEpicId(planId)`.
- Append subtasks to the `BatchPromptPlan[]` array with a `[SUBTASK]` prefix in the topic.
- Set `PromptBuilderOptions.epicMode = true`, `epicTopic`, `subtaskCount`.
- Respect `epic_max_subtasks` config: if subtask count exceeds limit, include only the first N and append a warning line to the prompt: `[WARNING: ${totalCount} subtasks exist but only ${maxSubtasks} included. Remaining subtasks stay in column: ${column}]`

### agentPromptBuilder.ts

**File:** `src/services/agentPromptBuilder.ts`

**New `PromptBuilderOptions` fields** (add to interface at line 74-149):
```ts
epicMode?: boolean;        // true when dispatching an epic
epicTopic?: string;        // the epic's topic/title
subtaskCount?: number;     // number of subtasks included
```

**New directive constant** (add after line 256):
```ts
export const EPIC_ORCHESTRATION_DIRECTIVE = (epicTopic: string, count: number) =>
    `EPIC MODE: You are implementing the epic "${epicTopic}" which consists of ${count} subtask(s).\n` +
    `Use your native subagent or orchestration capabilities to handle each subtask. ` +
    `If your tool supports worktree-per-plan isolation, activate it now. ` +
    `If you do not support subagents, handle each subtask sequentially in the order listed below. ` +
    `All subtasks are part of a single delivery unit — do not treat them as independent tickets.`;
```

**Injection point in `buildKanbanBatchPrompt`** (after `executionDirective`, before `safeguardsBlock`):
- For all roles, if `options.epicMode === true`, inject `EPIC_ORCHESTRATION_DIRECTIVE(options.epicTopic!, options.subtaskCount!)`.
- Interaction with existing options:
  - If `noSubagentsEnabled = true`: override epic directive to sequential fallback: `"EPIC MODE: ... If you do not support subagents, handle each subtask sequentially..."` (the directive already includes this fallback).
  - If `useWorktreesPerPlanEnabled = true`: the worktree directive is appended after the epic directive (they are complementary, not conflicting).

**Plan list format for epics** in `buildPromptDispatchContext` (line 199-236):
- The existing format is: `- [Topic] Plan File: /absolute/path.md`
- For epics, prepend the epic itself as the first item, then list subtasks with a `[SUBTASK]` prefix:
  ```
  - [EPIC: Epic Topic] Plan File: /absolute/path/epic.md
    - [SUBTASK] Subtask 1 Plan File: /absolute/path/subtask1.md
    - [SUBTASK] Subtask 2 Plan File: /absolute/path/subtask2.md
  ```

## Frontend Changes

### kanban.html

**File:** `src/webview/kanban.html`

**Board rendering (`renderKanbanCard` or equivalent):**
- If `card.isEpic === true`, apply CSS class `epic-card` with a purple/blue left border (4px) and subtle background tint.
- Epic cards show a small badge: "EPIC" + subtask count (e.g., "3 subtasks"). This is **metadata**, not a progress bar.
- Badge HTML: `<span class="epic-badge">EPIC · ${card.subtaskCount} subtask${card.subtaskCount !== 1 ? 's' : ''}</span>`

**Card context menu:**
- Add "Convert to Epic" option. Visible when:
  - Card is not already an epic (`card.isEpic !== true`).
  - Card does not have `epicId` set (cannot convert a subtask to an epic).
- Post `{ type: 'convertToEpic', sessionId: card.sessionId }` message on click.

**Epic card context menu additions:**
- "Remove Epic Status" — posts `{ type: 'convertToEpic', sessionId: card.sessionId, revert: true }` to clear `is_epic` back to 0.

**Drag-and-drop / column buttons:**
- No change needed for the user action — they drag the epic card as normal.
- Backend handles subtask movement silently via transactional cascade.

**Delete confirmation for epics:**
- When delete/archive is triggered on an epic card, show a webview modal (not VS Code modal) with:
  - "This epic has N subtask(s). Choose an action:"
  - Button: "Delete all (epic + subtasks)" → posts `{ type: 'deleteEpic', sessionId, deleteSubtasks: true }`
  - Button: "Orphan subtasks" → posts `{ type: 'deleteEpic', sessionId, deleteSubtasks: false }`
  - Button: "Cancel"

**CSS additions:**
```css
.epic-card {
    border-left: 4px solid #7c3aed; /* purple-600 */
    background: rgba(124, 58, 237, 0.06);
}
.epic-badge {
    display: inline-block;
    font-size: 0.7em;
    font-weight: 700;
    text-transform: uppercase;
    background: #7c3aed;
    color: white;
    padding: 1px 6px;
    border-radius: 3px;
    margin-right: 4px;
}
```

### planning.html

**File:** `src/webview/planning.html`

**New "Epics" view in the Kanban Plans panel:**
- Add a toggle button group at the top of the plans panel: "All Plans" | "Epics".
- "Epics" view shows a list of epic cards (plans where `isEpic = true`).
- Clicking an epic expands it (accordion-style) to show subtasks with: topic, plan file path, current column, status.
- "Add subtask" button on each epic: opens a picker (dropdown/select) of plans that are (a) not epics, (b) not already subtasks of another epic, (c) in an unlocked column. Posts `{ type: 'addSubtaskToEpic', epicSessionId, subtaskSessionId }`.
- "Remove" button next to each subtask to orphan it. Posts `{ type: 'removeSubtaskFromEpic', subtaskSessionId }`.
- "Delete Epic" button with the same confirmation modal as kanban.html.
- "Epic Config" section (collapsible): editable textarea for the prompt template, a multi-select for locking columns, and a number input for max subtasks. Posts `{ type: 'updateEpicConfig', ... }`.

## Agent Skill

**New skill file:** `.agent/skills/convert_to_epic.md`

```markdown
---
description: Convert a plan to an epic via the Switchboard Kanban system
---

## Usage

Post a message to the Switchboard extension to mark a plan as an epic.
Do NOT run raw SQL — the KanbanProvider validates integrity rules.

### Parameters
- `session_id` — the plan's session_id
- `workspace_root` — absolute path to the workspace

### Message to post
{ type: 'convertToEpic', sessionId: '<session_id>' }

This routes through KanbanProvider which:
1. Validates the plan is not already a subtask
2. Sets is_epic = 1 and clears epic_id
3. Refreshes the board UI
```

The skill is registered in the skill loader so agents can discover it.

## Migration & Backward Compatibility

1. **Existing databases:** `MIGRATION_V29_SQL` adds columns with defaults. All existing plans remain non-epics.
2. **Existing prompts:** No change unless the dispatched card is explicitly an epic. Regular plans continue to use the existing prompt format.
3. **Existing worktrees:** The worktree tab is untouched. Epics and worktrees are orthogonal concerns.
4. **V28 already taken:** V28 normalizes `__unassigned__` project sentinels. Epic migration is V29.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| **Prompt bloat** — an epic with 15 subtasks could exceed token limits. | Cap subtasks at a configurable limit (default 20). If exceeded, include only first N and append a warning line to the prompt. Truncated subtasks stay in their current column. |
| **Column name drift** — users may rename columns, breaking the lock-column config. | Store column IDs (not labels) in `epic_lock_columns`. The config UI resolves labels at display time. |
| **Race condition** — two users move an epic and a subtask simultaneously. | SQLite serializes writes per connection. The backend transaction in `moveCardToColumn` wraps epic + all subtask updates in a single `updateColumnTransaction` call. |
| **Orphaned subtasks** — a subtask's epic is deleted without clearing `epic_id`. | The `deleteEpic` handler explicitly clears `epic_id` on all subtasks before deleting the epic (when `deleteSubtasks = false`). |
| **Agent confusion** — the epic directive might conflict with `useWorktreesPerPlan` or `noSubagentsEnabled`. | Epic mode takes precedence: if `epicMode = true`, it overrides `useSubagentsEnabled` but respects `noSubagentsEnabled` (falls back to sequential). The epic directive already includes the sequential fallback text. |
| **V28 collision** — plan originally specified V28 for epic migration, but V28 is already used. | Renumbered to V29. |

## Proposed Changes

### src/services/KanbanDatabase.ts
- **Context:** Core DB layer. Must add epic columns to schema, migration, and all SQL constants.
- **Logic:** Add `is_epic`/`epic_id` to `SCHEMA_SQL`, `MIGRATION_V29_SQL`, `PLAN_COLUMNS`, `UPSERT_PLAN_SQL`, `KanbanPlanRecord`. Add `getSubtasksByEpicId()` and `updateColumnTransaction()` methods. Add V29 migration block in `_runMigrations()`.
- **Implementation:** See detailed steps in "Backend Changes > KanbanDatabase.ts" above.
- **Edge Cases:** `_ensureSchemaColumns()` auto-reconciles from `SCHEMA_SQL` — no separate fix needed. V29 must check `v29 < 29` before running.

### src/services/KanbanProvider.ts
- **Context:** Message handler and card management. Must add epic message handlers and modify `moveCardToColumn` for cascade.
- **Logic:** Add `isEpic`, `epicId`, `subtaskCount` to `KanbanCard`. Add 6 new message handler cases. Modify `moveCardToColumn` to detect epics and cascade. Modify prompt building to include subtasks.
- **Implementation:** See detailed steps in "Backend Changes > KanbanProvider.ts" above.
- **Edge Cases:** Epic cascade must use `updateColumnTransaction` for atomicity. Delete confirmation must come from webview, not VS Code modal. Prompt truncation must leave truncated subtasks in consistent state.

### src/services/agentPromptBuilder.ts
- **Context:** Prompt generation. Must add epic-specific directive and plan list formatting.
- **Logic:** Add `epicMode`, `epicTopic`, `subtaskCount` to `PromptBuilderOptions`. Add `EPIC_ORCHESTRATION_DIRECTIVE` constant. Inject after `executionDirective` in `buildKanbanBatchPrompt`. Modify `buildPromptDispatchContext` to support `[SUBTASK]` prefix.
- **Implementation:** See detailed steps in "Backend Changes > agentPromptBuilder.ts" above.
- **Edge Cases:** `noSubagentsEnabled` must override to sequential (directive already includes fallback). `useWorktreesPerPlanEnabled` is complementary, not conflicting.

### src/webview/kanban.html
- **Context:** Kanban board UI. Must render epic cards differently and add context menu options.
- **Logic:** Add `epic-card` CSS class and `epic-badge` element. Add "Convert to Epic" context menu item. Add epic-specific delete confirmation modal.
- **Implementation:** See "Frontend Changes > kanban.html" above.
- **Edge Cases:** Subtask cards are invisible on the board — only epic cards show. Badge shows count, not progress.

### src/webview/planning.html
- **Context:** Plan management UI. Must add Epics view with subtask management.
- **Logic:** Add "All Plans" | "Epics" toggle. Epics view: accordion expand, subtask picker, remove button, delete button, config section.
- **Implementation:** See "Frontend Changes > planning.html" above.
- **Edge Cases:** Subtask picker must filter out epics and already-assigned subtasks. Config must validate column IDs on save.

### .agent/skills/convert_to_epic.md
- **Context:** Agent skill for converting plans to epics.
- **Logic:** Post `convertToEpic` message to extension, not raw SQL. KanbanProvider validates integrity.
- **Implementation:** See "Agent Skill" section above.
- **Edge Cases:** Skill must not bypass validation by running SQL directly.

## Verification Plan

### Automated Tests
- **KanbanDatabase unit tests:** Migration V29 applies cleanly to empty and populated DBs. `_ensureSchemaColumns` reconciles missing epic columns. `getSubtasksByEpicId` returns correct subtask set. `updateColumnTransaction` moves all specified plans atomically.
- **KanbanProvider unit tests:** `convertToEpic` rejects subtasks. `addSubtaskToEpic` rejects when epic is in a locked column. `moveCardToColumn` moves epic + subtasks atomically. `deleteEpic` with `deleteSubtasks=true` removes all rows. `deleteEpic` with `deleteSubtasks=false` orphans subtasks.
- **agentPromptBuilder unit tests:** `buildKanbanBatchPrompt` injects `EPIC_ORCHESTRATION_DIRECTIVE` when `epicMode = true`. Plan list includes epic + subtasks in correct order with `[SUBTASK]` prefix. `noSubagentsEnabled` does not conflict (sequential fallback already in directive text).

### Manual Verification
- Create epic → add subtasks → move epic through columns → verify subtask columns in DB.
- Dispatch epic to clipboard → inspect prompt text for epic directive and subtask list.
- Delete epic with and without subtasks → verify orphan/delete behavior.
- Verify epic card renders with purple border and badge on kanban board.
- Verify "Convert to Epic" context menu appears only on valid cards.
- Verify planning.html Epics view toggle, subtask picker, and config section.

## Recommendation

**Complexity: 8 → Send to Lead Coder**

Multi-file coordination across DB, backend, prompt builder, and two webview HTML files. New architectural pattern (epic cascade). Data consistency risks (transactional moves). Breaking prompt format changes that must coexist with existing non-epic dispatches.
