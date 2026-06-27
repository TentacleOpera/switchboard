# Enhancement: Epic File Subtask List Should Show Each Subtask's Current Kanban Column

## Goal

When an orchestrator agent reads an epic's markdown file (e.g. to decide what to work on next), each subtask in the `## Subtasks` block should show its current kanban column status alongside its name and link. Without this, the agent sees only a flat checklist of links — it has no way to tell which subtasks are in `CREATED`, which are `IN PROGRESS`, which are `DONE`, etc., without querying the kanban board directly (which an orchestrator agent cannot do).

### Problem

`_regenerateEpicFile` (`KanbanProvider.ts` L8443–8470) writes the `## Subtasks` block into the epic's markdown file. Each subtask line is currently rendered as:

```markdown
- [ ] [My Subtask Topic](../plans/my-subtask.md)
```

The `kanbanColumn` field is available on the `KanbanPlanRecord` returned by `db.getSubtasksByEpicId()` but is not included in the rendered line. An orchestrator agent reading the epic file therefore has no visibility into subtask status.

### Root Cause

`_regenerateEpicFile` (L8452–8456) maps over `subtasks` using only `st.topic` and `st.planFile`. It does not use `st.kanbanColumn` even though that field exists on the record.

## Metadata

**Complexity:** 1
**Tags:** feature, epic, orchestration, agent-ux

## Files to Modify

### `src/services/KanbanProvider.ts`

**Change the subtask line template** inside `_regenerateEpicFile` (L8452–8456) to include the column status as a badge after the link:

```typescript
// Before (L8452–8456):
const subtaskLines = subtasks.map(st => {
    const basename = path.basename(st.planFile);
    const topic = st.topic || basename;
    return `- [ ] [${topic}](../plans/${basename})`;
});

// After:
const subtaskLines = subtasks.map(st => {
    const basename = path.basename(st.planFile);
    const topic = st.topic || basename;
    const column = st.kanbanColumn || 'CREATED';
    return `- [ ] [${topic}](../plans/${basename}) — **${column}**`;
});
```

The resulting subtask section in the epic file will look like:

```markdown
<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Refactor auth module](../plans/refactor-auth-module.md) — **DONE**
- [ ] [Add login rate limiting](../plans/add-login-rate-limiting.md) — **IN PROGRESS**
- [ ] [Write auth unit tests](../plans/write-auth-unit-tests.md) — **CREATED**
<!-- END SUBTASKS -->
```

This is the only change required. `_regenerateEpicFile` is already called on every subtask membership and column change (callers at L7852, L7918, L7975, L8587, L8643), so the file stays up-to-date automatically.

## Verification

- Create an epic with 3 subtasks in different columns (`CREATED`, `IN PROGRESS`, `DONE`) → epic file's `## Subtasks` block shows each subtask with the correct status badge
- Move a subtask from `CREATED` to `IN PROGRESS` → epic file is regenerated and the badge updates
- Epic with 0 subtasks → subtask section shows `- [ ] (no subtasks)` (unchanged)
- Non-epic plan files → unaffected
