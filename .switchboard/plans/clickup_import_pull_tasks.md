# ClickUp Import — Pull Tasks as Plans

## Goal

Add a VS Code command that fetches tasks from a ClickUp list and writes a `.md` plan file for each one into `.switchboard/plans/`. Each file is populated with the full ClickUp task details: name, description, priority, due date, assignees, tags, and URL. All remaining ticket fields (status, start date, time estimate, creator, checklists, custom fields, dependencies) are preserved verbatim in a `## ClickUp Ticket Notes` section — no mapping, just raw context for the agent or user. Subtasks are imported as independent plan files (same as top-level tasks), enabling the complexity system to route them cheaply to the intern coder. Each parent task's notes list its subtasks with links to their plan files. The existing `PlanFileImporter` automatically detects new files in that folder and populates the DB — no direct DB interaction needed. Switchboard remains the source of truth; ClickUp is the observation layer.

## Metadata

**Tags:** backend, UI
**Complexity:** 3

## User Review Required

> [!NOTE]
> - **Import direction only**: ClickUp → Switchboard, on-demand pull. Does not affect the existing Switchboard → ClickUp outbound sync.
> - **Deduplication**: File is named `clickup_import_{taskId}.md`. If the file already exists, it is skipped. Re-running import is safe.
> - **DB auto-population**: `PlanFileImporter` picks up new `.md` files automatically — no DB calls needed in this feature.
> - **Full task content**: Each plan file includes the ClickUp task description under `## Goal` (`markdown_description` preferred), a metadata block (URL, priority, due date, assignees, tags), and a `## ClickUp Ticket Notes` section with all remaining fields (status, start date, time estimate, creator, checklists, custom fields, linked tasks, dependencies) — unmodified, no mapping.
> - **Subtasks**: Fetched via `?subtasks=true` (returns a flat array; each subtask has a `parent` field). Each subtask becomes its own independent plan file — same treatment as top-level tasks. Subtasks show `> **Parent Task:** {name}` in their metadata block. Parent tasks list their subtasks in `## ClickUp Ticket Notes` with links to the subtask plan files.
> - **Status → column**: Only `backlog` status maps to the `BACKLOG` column. All other statuses land in `CREATED`. The implementer must verify the `extractKanbanState()` format in `PlanFileImporter.ts` to embed the correct `## Switchboard State` block.
> - **Tasks already pushed from Switchboard**: These have a `switchboard:` tag in ClickUp — skip them to avoid duplicates.

## Complexity Audit

### Routine
- **REST API call**: `GET /list/{listId}/task` — same pattern as existing `httpRequest()` calls
- **File write**: `fs.promises.writeFile` with full task content (name, description, URL, priority, due date, assignees, tags, plus `## ClickUp Ticket Notes` with all remaining fields) — skip if file already exists
- **VS Code command + QuickPick**: Standard pattern, reuses `config.columnMappings` for list selection
- **Pagination**: Loop with `page` param until response has fewer than 100 tasks

### Complex / Risky
- **Subtask flat array**: `?subtasks=true` returns all tasks and subtasks in one flat list. Two lookup Maps are built before the write loop: `taskNameById` (for parent name resolution) and `subtasksByParentId` (for listing subtasks on parent cards). Straightforward but requires one pre-pass over the array.

## Edge-Case & Dependency Audit

- **Already-imported tasks**: File `clickup_import_{taskId}.md` already exists → skip (idempotent). Works for both top-level tasks and subtasks since task IDs are globally unique.
- **Tasks pushed from Switchboard**: Have `switchboard:` tag → skip to avoid duplicates
- **Subtasks**: `?subtasks=true` returns a flat array. Pre-pass builds `taskNameById` and `subtasksByParentId` maps. Each subtask processed identically to top-level tasks — deduplication, file-existence check, and full content all apply.
- **Status → column**: `backlog` → `BACKLOG`, everything else → `CREATED`. Implementer must verify `extractKanbanState()` format in `PlanFileImporter.ts` before writing the `## Switchboard State` block.
- **Empty custom fields / checklists**: Arrays guarded with `|| []` — render nothing if absent
- **Empty list**: Count 0, user-facing info message, not an error
- **ClickUp not set up**: Guard at start — show prompt if `config.setupComplete` is false
- **Pagination**: `delay(200)` between pages (matches existing `setup()` pattern)
- **No workspace folder**: Guard — error message, return early

### Cross-Plan Dependencies & Conflicts
- **Depends on** `clickup_1_foundation.md` — provides `ClickUpSyncService`, `httpRequest()`, `loadConfig()`, `delay()`, `ClickUpConfig` interface
- **Depends on** `clickup_2_setup_flow.md` — provides the config file with `columnMappings` and `setupComplete` flag used by this plan
- **No conflict** with `clickup_3_sync_on_move.md` — outbound sync (Switchboard → ClickUp), different direction
- **No conflict** with `clickup_push_plan_content_to_tasks.md` — push direction with different trigger; if an imported task is later edited in Switchboard, the push watcher syncs it back to ClickUp (desired bidirectional flow)
- **Shared fix** with `linear_import_pull_issues.md` — both plans need the `VALID_COLUMNS` fix in `planStateUtils.ts` (missing `BACKLOG` and `CODED`). Either plan can land the fix; the other benefits automatically
- **`extension.ts` shared** — modified by multiple plans; imports and command registrations are additive (no merge conflicts expected)

## Proposed Changes

### Target File 1: Import Method
#### MODIFY `src/services/ClickUpSyncService.ts`

```typescript
/**
 * Fetch tasks from a ClickUp list and write a stub plan .md file for each.
 * The PlanFileImporter picks up new files automatically — no DB calls needed.
 * Skips tasks that already have a plan file or are owned by Switchboard (switchboard: tag).
 */
async importTasksFromClickUp(
  listId: string,
  plansDir: string
): Promise<{ success: boolean; imported: number; skipped: number; error?: string }> {
  const config = await this.loadConfig();
  if (!config?.setupComplete) {
    return { success: false, imported: 0, skipped: 0, error: 'ClickUp not set up' };
  }

  try {
    const tasks: any[] = [];
    let page = 0;

    // subtasks=true returns subtasks inline in the same flat array, each with a `parent` field
    while (true) {
      const result = await this.httpRequest('GET', `/list/${listId}/task?page=${page}&subtasks=true&include_closed=false`);
      if (result.status !== 200) {
        return { success: false, imported: 0, skipped: 0, error: `Failed to fetch tasks: ${result.status}` };
      }
      const pageTasks: any[] = result.data?.tasks || [];
      tasks.push(...pageTasks);
      if (pageTasks.length < 100) { break; }
      page++;
      await this.delay(200);
    }

    await fs.promises.mkdir(plansDir, { recursive: true });

    // Build lookup maps from the flat task list
    const taskNameById = new Map<string, string>(tasks.map((t: any) => [t.id, t.name]));
    const subtasksByParentId = new Map<string, any[]>();
    for (const task of tasks) {
      if (task.parent) {
        const siblings = subtasksByParentId.get(task.parent) || [];
        siblings.push(task);
        subtasksByParentId.set(task.parent, siblings);
      }
    }

    let imported = 0;
    let skipped = 0;

    for (const task of tasks) {
      // Skip tasks already owned by Switchboard
      const hasSwitchboardTag = (task.tags || []).some((t: any) => t.name?.toLowerCase().startsWith('switchboard:'));
      if (hasSwitchboardTag) { skipped++; continue; }

      const planFile = path.join(plansDir, `clickup_import_${task.id}.md`);

      // Skip if already imported
      try { await fs.promises.access(planFile); skipped++; continue; } catch { /* file doesn't exist, proceed */ }

      // Determine initial kanban column: backlog status → BACKLOG, everything else → CREATED
      const statusName = (task.status?.status || '').toLowerCase();
      const kanbanColumn = statusName === 'backlog' ? 'BACKLOG' : 'CREATED';

      // Core fields
      const priority = task.priority?.priority || '';
      const dueDate = task.due_date ? new Date(Number(task.due_date)).toLocaleDateString() : '';
      const assignees = (task.assignees || []).map((a: any) => a.username || a.email || a.id).join(', ');
      const tags = (task.tags || [])
        .map((t: any) => t.name)
        .filter((n: string) => n && !n.toLowerCase().startsWith('switchboard:'))
        .join(', ');
      const description = (task.markdown_description || task.description || '').trim();
      const parentName = task.parent ? (taskNameById.get(task.parent) || task.parent) : '';

      // Metadata block (top of file)
      const metaLines = [
        `> Imported from ClickUp task \`${task.id}\``,
        task.url   ? `> **URL:** ${task.url}`                       : '',
        parentName ? `> **Parent Task:** ${parentName}`             : '',
        priority   ? `> **Priority:** ${priority}`                  : '',
        dueDate    ? `> **Due:** ${dueDate}`                        : '',
        assignees  ? `> **Assignees:** ${assignees}`                : '',
        tags       ? `> **Tags:** ${tags}`                          : '',
      ].filter(Boolean).join('\n');

      // ClickUp Ticket Notes — all remaining fields, no mapping, just raw info
      const startDate = task.start_date ? new Date(Number(task.start_date)).toLocaleDateString() : '';
      const timeEstimate = task.time_estimate ? `${Math.round(task.time_estimate / 60000)}m` : '';
      const creator = task.creator ? (task.creator.username || task.creator.email || task.creator.id) : '';
      const linkedTasks = (task.linked_tasks || []).map((l: any) => l.task_id || l.id).join(', ');
      const dependencies = (task.dependencies || []).map((d: any) => d.task_id || d.id).join(', ');

      const checklistLines = (task.checklists || []).flatMap((cl: any) =>
        (cl.items || []).map((item: any) => `- [${item.resolved ? 'x' : ' '}] ${item.name}`)
      );

      const customFieldLines = (task.custom_fields || [])
        .filter((f: any) => f.value !== null && f.value !== undefined && f.value !== '')
        .map((f: any) => `- **${f.name}:** ${JSON.stringify(f.value)}`);

      // List subtasks on parent tasks (each subtask gets its own plan file)
      const subtasks = subtasksByParentId.get(task.id) || [];
      const subtaskLines = subtasks.map((s: any) => `- ${s.name} (\`${s.id}\`) — see \`clickup_import_${s.id}.md\``);

      const notesLines = [
        '## ClickUp Ticket Notes',
        '',
        `**Status:** ${task.status?.status || ''}`,
        startDate      ? `**Start Date:** ${startDate}`        : '',
        timeEstimate   ? `**Time Estimate:** ${timeEstimate}`  : '',
        creator        ? `**Creator:** ${creator}`             : '',
        linkedTasks    ? `**Linked Tasks:** ${linkedTasks}`    : '',
        dependencies   ? `**Dependencies:** ${dependencies}`   : '',
        ...(subtaskLines.length > 0 ? ['', '**Subtasks (each imported as a separate plan):**', ...subtaskLines] : []),
        ...(checklistLines.length > 0 ? ['', '**Checklists:**', ...checklistLines] : []),
        ...(customFieldLines.length > 0 ? ['', '**Custom Fields:**', ...customFieldLines] : []),
      ].filter(s => s !== '').join('\n');

      // Embed kanban column for PlanFileImporter (must match extractKanbanState() bold-markdown format)
      const switchboardState = `## Switchboard State\n\n**Kanban Column:** ${kanbanColumn}\n**Status:** active\n`;

      const stub = [
        `# ${task.name || `ClickUp Task ${task.id}`}`,
        '',
        metaLines,
        '',
        '## Goal',
        '',
        description || 'TODO',
        '',
        '## Proposed Changes',
        '',
        'TODO',
        '',
        notesLines,
        '',
        switchboardState,
      ].join('\n');

      await fs.promises.writeFile(planFile, stub, 'utf8');
      imported++;
    }

    return { success: true, imported, skipped };
  } catch (error) {
    return { success: false, imported: 0, skipped: 0, error: `Import failed: ${error}` };
  }
}
```

### Target File 2: VS Code Command
#### MODIFY `src/extension.ts`

> **Note:** `ClickUpSyncService` is already imported in `extension.ts` at line 15 (`import { ClickUpSyncService } from './services/ClickUpSyncService';`). `path` is also already imported. No new imports needed — only register the new command below.

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand('switchboard.importFromClickUp', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) { vscode.window.showErrorMessage('No workspace folder open.'); return; }

    const syncService = new ClickUpSyncService(workspaceRoot, context.secrets);
    const config = await syncService.loadConfig();

    if (!config?.setupComplete) {
      vscode.window.showWarningMessage('ClickUp is not set up. Run "Switchboard: Setup ClickUp Integration" first.');
      return;
    }

    const listOptions = Object.entries(config.columnMappings)
      .filter(([, listId]) => listId)
      .map(([column, listId]) => ({ label: column, description: `List ID: ${listId}`, listId }));

    if (listOptions.length === 0) { vscode.window.showErrorMessage('No ClickUp lists mapped. Re-run setup.'); return; }

    const selected = await vscode.window.showQuickPick(listOptions, { placeHolder: 'Select a ClickUp list to import tasks from' });
    if (!selected) { return; }

    const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Importing from ClickUp...', cancellable: false },
      async () => {
        const result = await syncService.importTasksFromClickUp(selected.listId, plansDir);
        if (!result.success) { vscode.window.showErrorMessage(`Import failed: ${result.error}`); return; }

        const msg = result.imported === 0
          ? `No new tasks to import (${result.skipped} already tracked).`
          : `Imported ${result.imported} task${result.imported !== 1 ? 's' : ''} as plan files.${result.skipped ? ` (${result.skipped} skipped)` : ''}`;
        vscode.window.showInformationMessage(msg);
      }
    );
  })
);
```

### Target File 3: Command Registration
#### MODIFY `package.json`

Add to `contributes.commands`:

```json
{
  "command": "switchboard.importFromClickUp",
  "title": "Switchboard: Import Tasks from ClickUp",
  "category": "Switchboard"
}
```

### Target File 4: Fix VALID_COLUMNS for import compatibility
#### MODIFY `src/services/planStateUtils.ts`

Add `'BACKLOG'` and `'CODED'` to the `VALID_COLUMNS` Set (line 9-12) so it matches `VALID_KANBAN_COLUMNS` in `KanbanDatabase.ts` and `CANONICAL_COLUMNS` in `ClickUpSyncService.ts`:

```typescript
const VALID_COLUMNS = new Set([
    'CREATED', 'BACKLOG', 'PLANNED', 'INTERN CODED', 'CODER CODED',
    'LEAD CODED', 'CODE REVIEWED', 'CODED', 'PLAN REVIEWED', 'COMPLETED'
]);
```

Without this fix, `extractKanbanState()` returns `null` for any plan with `**Kanban Column:** BACKLOG` or `CODED`, causing `PlanFileImporter` to silently default those tasks to `CREATED`. This affects both this plan and `linear_import_pull_issues.md`.

### Example Imported Plan File

Below is an example of what a generated plan file looks like, showing the correct `## Switchboard State` bold-markdown format:

```markdown
# Implement user search endpoint

> Imported from ClickUp task `abc123`
> **URL:** https://app.clickup.com/t/abc123
> **Priority:** high
> **Due:** 1/15/2025
> **Assignees:** jdoe
> **Tags:** api, search

## Goal

Add a GET /api/users/search endpoint that supports full-text search by name or email.

## Proposed Changes

TODO

## ClickUp Ticket Notes

**Status:** in progress
**Start Date:** 1/10/2025
**Time Estimate:** 120m
**Creator:** jdoe

## Switchboard State

**Kanban Column:** CREATED
**Status:** active
```

## Verification Plan

### Automated Tests
- Mock `httpRequest` returning 3 tasks → verify 3 `.md` files written
- Mock 1 parent task + 2 subtasks (with `parent` field set) → verify 3 files written; parent file lists subtasks in notes; subtask files show `**Parent Task:**` in metadata
- Mock task with `switchboard:sess_123` tag → verify file not written, skipped count = 1
- Re-run with existing files → verify skipped = 3, imported = 0 (idempotent)
- Mock 100-task page + 50-task page → verify both pages fetched (subtasks count toward page size)

### Manual Verification Steps
1. Run "Switchboard: Import Tasks from ClickUp" → QuickPick shows mapped column names
2. Select a list → `.md` files appear in `.switchboard/plans/`, cards appear in CREATED column; subtasks each get their own card
3. Import a list with an epic + subtasks → parent card shows subtask list in notes; each subtask is a separate card
4. Run again → notification shows 0 new imports
5. Move an imported card in Switchboard → verify it pushes to ClickUp (existing outbound sync)

## Files to Modify

1. `src/services/ClickUpSyncService.ts` — add `importTasksFromClickUp()` method
2. `src/extension.ts` — register `switchboard.importFromClickUp` command (import already exists at line 15)
3. `package.json` — add command to `contributes.commands`
4. `src/services/planStateUtils.ts` — add `'BACKLOG'` and `'CODED'` to `VALID_COLUMNS` Set (sync with `KanbanDatabase.ts`)

## Agent Recommendation

**Send to Coder** — Complexity 3. Fetch tasks, write files, skip duplicates. No DB, no webhooks, no new infrastructure.

---

## Adversarial Synthesis

### Grumpy Critique

1. **`## Switchboard State` format was WRONG** — The original plan wrote `kanbanColumn: BACKLOG` but `extractKanbanState()` in `planStateUtils.ts` expects bold-markdown format (`**Kanban Column:** BACKLOG`). Every imported task would silently land in CREATED regardless of its ClickUp status. The plan even documented "verify the `extractKanbanState()` format" — and then used the wrong format. **FIXED:** Changed to `**Kanban Column:** ${kanbanColumn}\n**Status:** active`.

2. **`BACKLOG` wasn't in `VALID_COLUMNS`** — Even with the format fix, `extractKanbanState()` validates columns against the `VALID_COLUMNS` Set in `planStateUtils.ts`, which only has `CREATED, PLANNED, INTERN CODED, CODER CODED, LEAD CODED, CODE REVIEWED, PLAN REVIEWED, COMPLETED`. No `BACKLOG`, no `CODED`. Both exist in `KanbanDatabase.ts` `VALID_KANBAN_COLUMNS` and `ClickUpSyncService.ts` `CANONICAL_COLUMNS`. So BACKLOG tasks would still default to CREATED even after the format fix. **FIXED:** Added `planStateUtils.ts` to Files to Modify with the column additions.

3. **`switchboard:` tag detection was case-sensitive** — The plan checked `tag.name?.startsWith('switchboard:')` but ClickUp tags are case-insensitive and may be normalized (e.g., `Switchboard:abc123`). The startsWith check would miss the capitalized variant. **FIXED:** Added `.toLowerCase()` to the startsWith check and the tag-filter line.

4. **File-existence dedup is correct for import direction** — The Linear import plan deduplicates via sync map (`syncMapIssueIds`), but that map is Switchboard→External direction. For ClickUp→Switchboard import, the sync map lookup would be reversed. File-existence check (`clickup_import_{taskId}.md`) is the right dedup strategy here. ✅ No change needed.

5. **`task.parent` field type is correct** — With `subtasks=true`, the `parent` field on a subtask is a string task ID (not an object). ✅

6. **Pagination with subtasks is handled correctly** — When `subtasks=true`, subtasks count toward page size. A page of 100 might contain 50 parents and 50 subtasks. The pre-pass lookup maps handle parent-subtask relationships regardless of page boundaries. ✅

### Balanced Response

| Issue | Severity | Resolution |
|---|---|---|
| Switchboard State format wrong | **Critical** — silent data-loss | Fixed to bold-markdown format matching `extractKanbanState()` regex |
| BACKLOG missing from VALID_COLUMNS | **Critical** — BACKLOG tasks default to CREATED | Added `planStateUtils.ts` to Files to Modify; add BACKLOG + CODED |
| Case-sensitive tag check | **Medium** — could cause duplicate imports | Added `.toLowerCase()` to both tag detection and tag filtering |
| File-existence dedup vs sync-map | **None** — file-existence is correct for import direction | No change needed |
| Subtask/pagination handling | **None** — correctly handled | No change needed |

### Remaining Risks

- **Rate limiting**: ClickUp API rate limits (100 req/min) could be hit with very large lists. The 200ms inter-page delay mitigates this for pagination, but a workspace with many lists imported in sequence could still trigger limits. Low risk for typical usage.
- **Markdown description availability**: `task.markdown_description` may be empty for tasks created via API or email. The fallback to `task.description` handles this. ✅
- **Tag normalization across ClickUp workspaces**: Different ClickUp workspaces may normalize tags differently. The `.toLowerCase()` fix handles the known case, but exotic unicode normalization is not addressed. Negligible risk.

---

## Review (Adversarial + Balanced)

**Reviewer:** Copilot (Claude Sonnet 4.6)
**Mode:** Light (findings in chat, fixes applied directly)

### Stage 1 — Grumpy Principal Engineer

| # | Severity | Finding |
|---|----------|---------|
| 1 | NIT | `notesLines.filter(s => s !== '')` removes blank-line separators after `## ClickUp Ticket Notes` header and between sub-sections (Subtasks, Checklists, Custom Fields) — cosmetic only, plan example shows blank lines that the code omits |
| 2 | NIT | `include_closed=false` in query URL silently excludes archived ClickUp tasks — reasonable default but undocumented |
| 3 | NIT | `**Status:** ${task.status?.status \|\| ''}` renders `**Status:** ` (trailing space) when status absent — inconsistent with all other fields that use falsy-gate |
| 4 | NIT | Mid-pagination failure returns `imported: 0, skipped: 0` — technically correct (no files written yet) but slightly misleading UX |

### Stage 2 — Balanced Synthesis

**Implemented Well:**
- `importTasksFromClickUp()` in ClickUpSyncService — exact plan signature, all logic correct
- Pagination loop with break guard and 200ms inter-page delay
- Switchboard-tag skip with `.toLowerCase()` (adversarial case-insensitive fix applied)
- File-existence dedup — idempotent re-runs
- `**Kanban Column:** ${kanbanColumn}\n**Status:** active` — bold-markdown format, `extractKanbanState()` compatible
- `VALID_COLUMNS` updated in `planStateUtils.ts` with `BACKLOG` and `CODED`
- Two lookup maps pre-pass — subtask relationships correct
- Full `## ClickUp Ticket Notes` section with checklists, custom fields, dependencies
- VS Code command + QuickPick + `package.json` registration all present

**Fixes Applied:** None — no CRITICAL or MAJOR findings

### Validation Results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | ✅ Pass (pre-existing ArchiveManager error only) |
| `npm run compile` | ✅ Pass (webpack compiled successfully) |
| `importTasksFromClickUp` in ClickUpSyncService.ts | ✅ Line 547 |
| `importFromClickUp` command in extension.ts | ✅ Line 1366 |
| `importFromClickUp` in package.json | ✅ Line 117 |
| `VALID_COLUMNS` includes BACKLOG, CODED | ✅ planStateUtils.ts lines 10–11 |

### Verdict: ✅ READY
