# Enhancement: Epic File Subtask List Should Show Each Subtask's Current Kanban Column

## Goal

When an orchestrator agent reads an epic's markdown file (e.g. to decide what to work on next), each subtask in the `## Subtasks` block should show its current kanban column status alongside its name and link. Without this, the agent sees only a flat checklist of links — it has no way to tell which subtasks are in `CREATED`, which are `LEAD CODED`, which are `COMPLETED`, etc., without querying the kanban board directly (which an orchestrator agent cannot do).

### Problem

`_regenerateEpicFile` (`KanbanProvider.ts` L8491–8518) writes the `## Subtasks` block into the epic's markdown file. Each subtask line is currently rendered as:

```markdown
- [ ] [My Subtask Topic](../plans/my-subtask.md)
```

The `kanbanColumn` field is available on the `KanbanPlanRecord` returned by `db.getSubtasksByEpicId()` (KanbanDatabase.ts L3811–3818; field declared at L36, populated at L5909) but is not included in the rendered line. An orchestrator agent reading the epic file therefore has no visibility into subtask status.

### Root Cause

`_regenerateEpicFile` (L8500–8504) maps over `subtasks` using only `st.topic` and `st.planFile`. It does not use `st.kanbanColumn` even though that field exists on the record.

**Secondary root cause (discovered during plan review):** Even after adding the badge to the template, the badge would go **stale** whenever a subtask changes column, because `_regenerateEpicFile` is **NOT** called on any column-move path. The existing 6 callers fire only on epic creation / subtask membership changes (add, remove, promote), never on column transitions. The column-move entry points (`moveCardToColumn` L4819, `moveCardToColumnByPlanFile` L4878, and the auto-complete cascade sites at L6746, L6772, L6812, L6861, L6875, L7160) update the DB column and refresh the board UI, but they never rewrite the epic markdown file. So a badge written at creation time would silently drift from reality — which is worse than showing no badge at all (misleading vs. absent). The fix must therefore add epic-file regeneration to the column-move paths, not just edit the template.

## Metadata

**Tags:** feature, ux
**Complexity:** 4

## User Review Required

**Decision needed — column ID vs. label in the badge.** The `kanbanColumn` field stores the column **ID** (e.g. `LEAD CODED`, `CODER CODED`, `PLAN REVIEWED`, `COMPLETED`), not the human-readable **label** (`Lead Coder`, `Coder`, `Planned`, `Completed`) — see `agentConfig.ts` L107–122. This plan's default is to render the **ID** (normalized), because (a) it requires no extra async column-definition lookup inside `_regenerateEpicFile`, (b) IDs are what the rest of the system dispatches by, and (c) agents interpret IDs like `LEAD CODED` / `COMPLETED` readily. If you prefer the friendlier **label** (`Lead Coder` instead of `LEAD CODED`), say so and the implementation will resolve ID→label via `_buildKanbanColumns` before rendering. The label path adds one async fetch per regeneration.

## Complexity Audit

### Routine
- Editing the subtask line template inside `_regenerateEpicFile` (L8500–8504) to append the column badge — single-line template change.
- Applying `_normalizeLegacyKanbanColumn` to the column value — reuses an existing private helper (L2008) already used at 8+ other sites.
- The `|| 'CREATED'` fallback is redundant (`_readRows` already defaults to `"CREATED"` at L5909) but harmless and matches codebase convention.

### Complex / Risky
- **Adding `_regenerateEpicFile` calls to the column-move paths.** This is the non-trivial part. Without it the badge goes stale on every column change, defeating the feature. Requires touching multiple call sites and correctly resolving which epic file to regenerate (the moved subtask's `epicId`, or the epic's own `planId` when an epic cascade moves subtasks).
- **Performance**: an extra epic-file write on every column move. The file is small and this already happens on membership changes, so impact is negligible — but it is a new write on a hot path (drag-and-drop).
- **Auto-complete cascade sites** (L6746, L6772, L6812, L6861, L6875, L7160) also change subtask columns without regenerating the epic file; for full correctness these need regeneration too, or the badge drifts on auto-completion.

## Edge-Case & Dependency Audit

**Race Conditions**
- `_regenerateEpicFile` reads the existing epic file, splices the `<!-- BEGIN SUBTASKS -->…<!-- END SUBTASKS -->` block, and writes it back (L8496–8517). It already calls `GlobalPlanWatcherService.registerPendingCreation(epicAbsPath)` (L8516) so the plan watcher does not re-import the file mid-write. Adding more callers (column moves) does not introduce a new race class — the same guard applies — but two concurrent column moves on subtasks of the **same** epic could interleave read-modify-write cycles and lose one update. Low probability (column moves are user-driven, sequential) and self-correcting on the next move. No transactional change needed.

**Security**
- The column ID is a controlled enum/identifier from the DB, not user input — no injection risk in the markdown. `_normalizeLegacyKanbanColumn` only maps `CODED`→`LEAD CODED`; it does not interpolate raw input.

**Side Effects**
- New epic-file writes on column moves will trigger the plan watcher (guarded by `registerPendingCreation`, so it is a no-op for the watcher). No DB mutation from the regeneration itself.
- Existing consumers that parse the `## Subtasks` block (orchestrator agents, the epic-prompt generator at L3124) must tolerate the new ` — **COLUMN**` suffix. The block is delimited by the BEGIN/END markers and parsed by humans/agents, not by a strict regex, so the suffix is non-breaking.

**Dependencies & Conflicts**
- No dependency on other plans or sessions.
- Depends on `_normalizeLegacyKanbanColumn` (L2008) and `db.getSubtasksByEpicId` (KanbanDatabase.ts L3811) — both stable, pre-existing.
- No conflict with the `is_epic` clobbering / cascade fixes from the recent `3d7f8bc` commit; those touch `updateEpicStatus` and cascade ordering, not the subtask-line template.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) the original plan's claim that regeneration happens "on every column change" is **false** — without adding `_regenerateEpicFile` to the column-move paths the badge silently goes stale and misleads the orchestrator agent; (2) skipping `_normalizeLegacyKanbanColumn` surfaces the deprecated `CODED` value; (3) the example output used non-existent column names (`DONE`, `IN PROGRESS`). Mitigations: add regeneration calls to `moveCardToColumn`, `moveCardToColumnByPlanFile`, and the auto-complete cascade sites; normalize the column value; correct the example to real column IDs.

## Proposed Changes

### `src/services/KanbanProvider.ts`

**Context:** `_regenerateEpicFile` (L8491–8518) is the single writer of the epic markdown's `## Subtasks` block. It is called on epic creation and subtask membership changes, but **not** on column moves. The template at L8500–8504 omits `st.kanbanColumn`.

**Logic:** Two coordinated changes — (A) render the badge in the template, (B) trigger regeneration whenever a subtask or epic changes column.

**Implementation:**

#### A. Render the column badge in the template (L8500–8504)

```typescript
// Before (L8500–L8504):
const subtaskLines = subtasks.map(st => {
    const basename = path.basename(st.planFile);
    const topic = st.topic || basename;
    return `- [ ] [${topic}](../plans/${basename})`;
});

// After:
const subtaskLines = subtasks.map(st => {
    const basename = path.basename(st.planFile);
    const topic = st.topic || basename;
    const column = this._normalizeLegacyKanbanColumn(st.kanbanColumn) || 'CREATED';
    return `- [ ] [${topic}](../plans/${basename}) — **${column}**`;
});
```

The resulting subtask section in the epic file will look like (using **real** column IDs, not the fictional `DONE`/`IN PROGRESS` from the original draft):

```markdown
<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Refactor auth module](../plans/refactor-auth-module.md) — **COMPLETED**
- [ ] [Add login rate limiting](../plans/add-login-rate-limiting.md) — **LEAD CODED**
- [ ] [Write auth unit tests](../plans/write-auth-unit-tests.md) — **CREATED**
<!-- END SUBTASKS -->
```

#### B. Regenerate the epic file on column moves

Add a `_regenerateEpicFile` call after every successful column change that can affect a subtask or epic. The two primary user-facing entry points:

1. **`moveCardToColumn` (L4819–4863)** — after `moved` succeeds (inside the `if (moved)` block at L4846), resolve the moved plan's epic and regenerate:
   - If `plan.isEpic`: `await this._regenerateEpicFile(workspaceRoot, plan.planId, db);` (subtasks cascaded, so their badges changed).
   - Else if `plan.epicId`: `await this._regenerateEpicFile(workspaceRoot, plan.epicId, db);` (this subtask moved).
   - Else: no epic file to update.

2. **`moveCardToColumnByPlanFile` (L4878–4929)** — same logic inside the `if (moved)` block at L4913, using `previousRecord` (the plan record fetched earlier in the function) in place of `plan`.

3. **Auto-complete / cascade sites** (L6746, L6772, L6812, L6861, L6875, L7160) — these call `updateColumnWithEpicCascadeByPlanId` and move subtasks to `COMPLETED` or `LEAD CODED`. For full correctness, add `await this._regenerateEpicFile(workspaceRoot, epicPlanId, db);` after each successful cascade (the `epicPlanId` / `plan.planId` variable is already in scope at each site). These are secondary but needed so the badge does not drift on auto-completion.

**Edge Cases:**
- Subtask with no `epicId` (standalone plan moved): skip regeneration — no epic file owns it.
- Epic moved with no subtasks: `_regenerateEpicFile` already handles the empty case (renders `- [ ] (no subtasks)`), and the badge list is empty, so the call is a harmless no-op rewrite.
- `db` and `workspaceRoot` are already in scope at every target site — no new parameter threading required.
- Keep the regeneration `await`ed (not fire-and-forget) so the file is consistent before the board refresh / integration sync that follows.

## Verification Plan

### Automated Tests
> Per session directive, automated tests are NOT run here. The existing test file `src/services/__tests__/KanbanProvider.test.ts` is the place to add a unit test for the new template + regeneration-on-move behavior; the user will run the suite separately.

### Manual Verification
- Create an epic with 3 subtasks in different columns (`CREATED`, `LEAD CODED`, `COMPLETED`) → epic file's `## Subtasks` block shows each subtask with the correct status badge.
- Move a subtask from `CREATED` to `LEAD CODED` via drag-and-drop → epic file is regenerated and the badge updates (this validates change B; without it the badge would stay `CREATED`).
- Move an epic card (cascade) → all subtask badges in the epic file reflect the cascaded column.
- Auto-complete a subtask (cascade to `COMPLETED`) → epic file badge updates.
- Epic with 0 subtasks → subtask section shows `- [ ] (no subtasks)` (unchanged).
- Non-epic plan files → unaffected.
- Legacy subtask with raw `kanban_column = 'CODED'` → badge renders `**LEAD CODED**` (validates normalization), not the deprecated `**CODED**`.

## Recommendation

Complexity 4 → **Send to Coder.** The template change is trivial, but the column-move regeneration wiring across multiple call sites is the kind of coordinated, multi-site edit that benefits from a Coder's attention to correctly resolving the epicId at each site.

---

## Reviewer Pass — Completed

### Review Date
2026-06-28

### Implementation Status: COMPLETE — all plan requirements met

#### Files Changed (committed in `352fad9` "epic fixes")
- `src/services/KanbanProvider.ts` — template change at `_regenerateEpicFile` (L8629-8630) + 16 regeneration call sites across `moveCardToColumn`, `moveCardToColumnByPlanFile`, `completePlan`, `completeSelected`, `completeAll`, `uncompleteCard` (+ rollback), `sendToLead/copyPrompt`.

#### Change A — Template (verified)
`KanbanProvider.ts:8629-8630` — verbatim match to plan spec:
```typescript
const column = this._normalizeLegacyKanbanColumn(st.kanbanColumn) || 'CREATED';
return `- [ ] [${topic}](../plans/${basename}) — **${column}**`;
```
Em-dash confirmed as U+2014 (`e2 80 94`). Normalization via `_normalizeLegacyKanbanColumn` (L2010) handles `CODED`→`LEAD CODED`.

#### Change B — Regeneration on column moves (verified)
All 8 `cascadeEpicByPlanId` calls followed by `_regenerateEpicFile`. All 9 `db.updateColumn`/`updateColumnByPlanFile` calls (except epic-recompute at L4777, which only changes the epic's own column — non-issue) followed by conditional `_regenerateEpicFile` based on `isEpic`/`epicId`. Drag-and-drop path routes through `_updateKanbanColumnForSession` → `moveCardToColumn` (regenerates). All `await`ed (not fire-and-forget).

#### Consumer Compatibility (verified)
No regex parser of the `## Subtasks` block exists in `src/`. `TaskViewerProvider.ts:18561` checks heading line-equality only. `project.js:249` click-interceptor operates on rendered `<a>` tags (badge is outside link). Epic-prompt generator (`KanbanProvider.ts:3126`) reads subtasks from DB, not file. Non-breaking.

### Findings by Severity

| Severity | Finding | Location | Status |
|----------|---------|----------|--------|
| CRITICAL | *(none)* | — | — |
| MAJOR | *(none)* | — | — |
| NIT | No-provider fallback skips regeneration | `TaskViewerProvider.ts:2265-2275`, `11652-11659`, `14083-14090` | Documented — degenerate state (`_kanbanProvider` null), not fix-worthy |
| NIT | NotionBackupService restore skips regeneration | `NotionBackupService.ts:140-152` | Documented — out of plan scope, rare operation |
| NIT | Redundant `\|\| 'CREATED'` fallback | `KanbanProvider.ts:8629` | Plan-acknowledged, harmless, matches convention |

### Fixes Applied
None — implementation matches plan exactly. No CRITICAL or MAJOR findings to fix.

### Verification Results
- **Typecheck**: Skipped per session directive (SKIP COMPILATION). Types verified by inspection: `st.kanbanColumn` is `string` (KanbanPlanRecord L36), `_normalizeLegacyKanbanColumn` accepts `string | null | undefined`, template interpolation is type-safe.
- **Tests**: Skipped per session directive (SKIP TESTS). User to run `src/services/__tests__/KanbanProvider.test.ts` separately.
- **Code inspection**: All 16 regeneration sites verified present and correctly guarded by `isEpic`/`epicId` checks. All `cascadeEpicByPlanId` calls followed by regeneration.

### Remaining Risks
1. **No-provider fallback paths** (3 sites in TaskViewerProvider): When `_kanbanProvider` is null, column changes bypass epic-file regeneration. Degenerate state only — `_kanbanProvider` is always set in production. Badge drift self-corrects on next normal column move.
2. **NotionBackupService restore**: Bulk column restore from Notion backup does not regenerate epic files. All epic badges stale after restore until next column move. Fix would require threading KanbanProvider into NotionBackupService — defer to separate plan if reported.
3. **Concurrent column moves on same epic**: Two simultaneous drag-and-drops on subtasks of the same epic could interleave read-modify-write cycles in `_regenerateEpicFile` and lose one update. Low probability (user-driven, sequential) and self-correcting. No transactional change needed (per plan's race-condition audit).
