# Linear Integration — Import Issues as Plans

## Goal

Add a VS Code command that fetches issues from a Linear team (optionally scoped to a project) and writes a `.md` plan file for each one into `.switchboard/plans/`. Full issue content is preserved: title, description, URL, identifier, priority, due date, assignees, labels, and all remaining fields in a `## Linear Issue Notes` section. Sub-issues are imported as independent plan files. `PlanFileImporter` auto-detects new files and populates the DB — no direct DB interaction needed.

## Metadata

**Tags:** backend, ui
**Complexity:** 4

## User Review Required

> [!NOTE]
> - **Mirrors ClickUp import**: Same file-write approach as `clickup_import_pull_tasks.md`. DB auto-populates via `PlanFileImporter`.
> - **Sub-issues**: Fetched via `children { nodes { ... } }` on each issue. Each sub-issue becomes its own plan file with `> **Parent Issue:** {title} ({identifier})` in the metadata block. Parent file lists sub-issues in `## Linear Issue Notes`.
> - **Deduplication**: File named `linear_import_{issueId}.md`. If file exists → skip. Re-running is safe.
> - **Already-synced issues**: Issues in `linear-sync.json` (pushed from Switchboard) are skipped.
> - **State → column**: `backlog` state type → `BACKLOG` column; all other state types → `CREATED`. Implementer must verify `extractKanbanState()` format in `PlanFileImporter.ts` before writing `## Switchboard State` block.
> - **Cursor pagination**: Linear uses `pageInfo.hasNextPage` + `endCursor`, not page numbers.
> - **MCP tools**: The `mcp4_list_issues` and `mcp4_get_issue` tools can be used by Cascade directly to query Linear. This import command is for automated use within the extension without AI involvement.

## Complexity Audit

### Routine
- **File write**: Same stub-generation pattern as ClickUp import
- **Deduplication**: File-existence check + sync map check
- **VS Code command + QuickPick**: Same pattern as ClickUp import

### Complex / Risky
- **GraphQL query with sub-issues**: Need `children { nodes { ... } }` nested in the issue query. Must build `taskNameById` and `subtasksByParentId` maps from the flat-resolved list.
- **Cursor-based pagination**: Linear doesn't use page numbers. Loop using `pageInfo { hasNextPage endCursor }` and pass `after: $cursor` in subsequent queries.

## Edge-Case & Dependency Audit

**Dependencies:**
- `linear_1_foundation.md` — **prerequisite**: creates `LinearSyncService` class with `graphqlRequest()`, `loadConfig()`, `loadSyncMap()`
- `linear_2_setup_flow.md` — **prerequisite**: creates config with `teamId`, `projectId` from setup flow

**Edge Cases:**
- **Already-synced issues**: Check `linear-sync.json` — if `sessionId` exists for this issueId, skip
- **Sub-issues**: Appear in `children { nodes }` of parent — NOT as separate top-level results. Must collect sub-issues from parent nodes and process them separately.
- **File already exists**: `fs.promises.access` check → skip
- **Empty team**: Count 0, info notification
- **State type → column**: `state.type === 'backlog'` → BACKLOG; all others → CREATED
- **Cancelled state type**: Issues in `cancelled` or `completed` states → skip (don't import closed work)

## Cross-Plan Conflict Analysis

| Plan | Relationship | Shared Files | Resolution |
|:-----|:-------------|:-------------|:-----------|
| `linear_1_foundation.md` | **Prerequisite** | `LinearSyncService.ts` | Plan 1 creates the class; this plan adds `importIssuesFromLinear()` method |
| `linear_2_setup_flow.md` | **Prerequisite** | `LinearSyncService.ts` | Plan 2 creates setup flow with `teamId`/`projectId`; this plan reads that config |
| `linear_3_sync_on_move.md` | No conflict | Different functionality | Sync-on-move writes TO Linear; import reads FROM Linear |
| `clickup_import_pull_tasks.md` | **Parallel** | `extension.ts`, `package.json` | Different service, different files. `extension.ts` changes are additive (separate command registrations). `package.json` command array additions are additive. |

**Shared-file note:** `extension.ts` is modified by multiple plans — each adds a new `registerCommand()` call. These are additive and order-independent. `package.json` contributes entries are also additive to the commands array.

## Adversarial Synthesis

### Grumpy Reviewer Findings

1. **`## Switchboard State` format was WRONG** (CRITICAL — now fixed): The plan originally wrote `kanbanColumn: BACKLOG` but `extractKanbanState()` in `planStateUtils.ts` expects `**Kanban Column:** BACKLOG`. Every imported issue would have defaulted to CREATED regardless of its Linear state. Silent data-loss bug — embarrassing for a plan that specifically calls out "State → column" mapping as a key feature.

2. **Missing `**Status:**` field** (now fixed): `extractKanbanState()` also parses `**Status:** active|completed`. Without it, the status defaults to `active` anyway (line 39 of planStateUtils.ts), but the field should be explicitly present for correctness. Now included.

3. **`BACKLOG` not in `planStateUtils.ts` VALID_COLUMNS** (pre-existing gap): `planStateUtils.ts` line 9-12 defines `VALID_COLUMNS` as `CREATED, PLANNED, INTERN CODED, CODER CODED, LEAD CODED, CODE REVIEWED, PLAN REVIEWED, COMPLETED` — no `BACKLOG`. However, `KanbanDatabase.ts` line 163-164 includes `BACKLOG` in `VALID_KANBAN_COLUMNS`, and `ClickUpSyncService.ts` includes it in `CANONICAL_COLUMNS`. This means `extractKanbanState()` would return `null` for BACKLOG even with the format fix. **Implementer must add `'BACKLOG'` and `'CODED'` to `planStateUtils.ts` VALID_COLUMNS to match `KanbanDatabase.ts`**, or file a separate bug fix.

4. **Missing import for `LinearSyncService` in `extension.ts`**: The command creates `new LinearSyncService(workspaceRoot, context.secrets)` but no import was shown. TypeScript won't compile without it. Now noted with explicit import statement.

5. **`path` import in `extension.ts`**: Verified — `extension.ts` line 2 already has `import * as path from 'path';`. No additional import needed.

6. **Duplicate sub-issues in `allTasks`** (now fixed): Sub-issues appeared in BOTH `allIssues` (as `children.nodes` of their parent) AND `subIssues` (extracted via flatMap). When merged into `allTasks = [...allIssues, ...subIssues]`, sub-issues appeared twice. The file-existence check prevented double-writing, but `skipped` count was inflated. Fixed with Map-based dedup: `[...new Map([...allIssues, ...subIssues].map(t => [t.id, t])).values()]`.

7. **GraphQL query string interpolation**: The query uses `${config.projectId ? '...' : ''}` to conditionally include the project filter. If `config.projectId` is an empty string (not `undefined`), the truthiness check correctly excludes the filter. `undefined` is also falsy. This is correct as-is.

### Resolution Summary

| Finding | Severity | Status |
|:--------|:---------|:-------|
| Switchboard State format | **Critical** | ✅ Fixed in code |
| Missing Status field | Medium | ✅ Fixed in code |
| BACKLOG not in VALID_COLUMNS | **High** | ⚠️ Pre-existing bug — note for implementer |
| Missing LinearSyncService import | Medium | ✅ Import note added |
| Duplicate sub-issues | Low | ✅ Dedup added |
| GraphQL interpolation safety | Low | ✅ Already correct |

## Step Breakdown by Complexity

### Routine Changes
1. **`package.json`** — Add command entry to `contributes.commands` array
2. **`src/extension.ts`** — Register `switchboard.importFromLinear` command (add import + `registerCommand` block)

### Complex Changes
3. **`src/services/LinearSyncService.ts`** — Add `importIssuesFromLinear()` method:
   - GraphQL query with cursor pagination (`pageInfo.hasNextPage` + `endCursor`)
   - Sub-issue flattening via `children { nodes { ... } }` with Map-based deduplication
   - State-to-column mapping with `## Switchboard State` block in bold-markdown format
   - File generation with dedup (sync map check + file existence check)

### Pre-existing Fix Required
4. **`src/services/planStateUtils.ts`** — Add `'BACKLOG'` and `'CODED'` to `VALID_COLUMNS` set (aligns with `KanbanDatabase.ts`). Without this, BACKLOG column assignment is silently ignored by `extractKanbanState()`.

## Proposed Changes

### Target File 1: Import Method
#### MODIFY `src/services/LinearSyncService.ts`

```typescript
async importIssuesFromLinear(plansDir: string): Promise<{ success: boolean; imported: number; skipped: number; error?: string }> {
  const config = await this.loadConfig();
  if (!config?.setupComplete) {
    return { success: false, imported: 0, skipped: 0, error: 'Linear not set up' };
  }

  try {
    const syncMap = await this.loadSyncMap();
    const syncMapIssueIds = new Set(Object.values(syncMap));

    // Fetch all issues (and their sub-issues) with cursor pagination
    const allIssues: any[] = [];
    let cursor: string | null = null;

    const QUERY = `
      query($teamId: String!, $projectId: String, $after: String) {
        issues(
          filter: {
            team: { id: { eq: $teamId } }
            ${config.projectId ? 'project: { id: { eq: $projectId } }' : ''}
          }
          after: $after
          first: 50
        ) {
          nodes {
            id identifier title description url priority
            state { name type }
            assignee { name email }
            labels { nodes { name } }
            dueDate createdAt estimate
            parent { id title identifier }
            children { nodes { id identifier title description url priority state { name type } assignee { name email } labels { nodes { name } } dueDate createdAt estimate parent { id } } }
            project { name }
            cycle { name number }
            comments { nodes { body user { name } createdAt } }
            attachments { nodes { title url } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    while (true) {
      const result = await this.graphqlRequest(QUERY, {
        teamId: config.teamId,
        projectId: config.projectId,
        after: cursor
      });
      const page = result.data.issues;
      allIssues.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) { break; }
      cursor = page.pageInfo.endCursor;
      await this.delay(200);
    }

    // Flatten: collect sub-issues from children into the same list for uniform processing
    const subIssues = allIssues.flatMap((issue: any) => issue.children?.nodes || []);
    // Deduplicate: sub-issues appear in both allIssues (as children) and subIssues (extracted)
    const allTasks = [...new Map([...allIssues, ...subIssues].map((t: any) => [t.id, t])).values()];

    // Build lookup maps
    const issueNameById = new Map<string, string>(allTasks.map((t: any) => [t.id, `${t.title} (${t.identifier})`]));
    const subIssuesByParentId = new Map<string, any[]>();
    for (const task of allTasks) {
      if (task.parent?.id) {
        const siblings = subIssuesByParentId.get(task.parent.id) || [];
        siblings.push(task);
        subIssuesByParentId.set(task.parent.id, siblings);
      }
    }

    await fs.promises.mkdir(plansDir, { recursive: true });
    let imported = 0;
    let skipped = 0;

    for (const issue of allTasks) {
      // Skip already synced from Switchboard
      if (syncMapIssueIds.has(issue.id)) { skipped++; continue; }

      // Skip closed/cancelled work
      const stateType = (issue.state?.type || '').toLowerCase();
      if (stateType === 'completed' || stateType === 'cancelled') { skipped++; continue; }

      const planFile = path.join(plansDir, `linear_import_${issue.id}.md`);
      try { await fs.promises.access(planFile); skipped++; continue; } catch { /* proceed */ }

      // Column assignment
      const kanbanColumn = stateType === 'backlog' ? 'BACKLOG' : 'CREATED';

      // Core fields
      const priority = ['', 'urgent', 'high', 'normal', 'low'][issue.priority] || '';
      const dueDate = issue.dueDate || '';
      const assignee = issue.assignee ? (issue.assignee.name || issue.assignee.email) : '';
      const labels = (issue.labels?.nodes || []).map((l: any) => l.name).filter((n: string) => n !== 'switchboard').join(', ');
      const description = (issue.description || '').trim();
      const parentRef = issue.parent?.id ? (issueNameById.get(issue.parent.id) || issue.parent.id) : '';

      // Metadata block
      const metaLines = [
        `> Imported from Linear issue \`${issue.identifier}\``,
        issue.url      ? `> **URL:** ${issue.url}`                     : '',
        parentRef      ? `> **Parent Issue:** ${parentRef}`            : '',
        priority       ? `> **Priority:** ${priority}`                 : '',
        dueDate        ? `> **Due:** ${dueDate}`                       : '',
        assignee       ? `> **Assignee:** ${assignee}`                 : '',
        labels         ? `> **Labels:** ${labels}`                     : '',
        issue.state?.name ? `> **State:** ${issue.state.name}`        : '',
      ].filter(Boolean).join('\n');

      // Sub-issues section
      const subIssues = subIssuesByParentId.get(issue.id) || [];
      const subIssueLines = subIssues.map((s: any) =>
        `- ${s.title} (\`${s.identifier}\`) — see \`linear_import_${s.id}.md\``
      );

      // Comments
      const commentLines = (issue.comments?.nodes || []).map((c: any) =>
        `- **${c.user?.name || 'Unknown'} (${c.createdAt?.slice(0, 10) || ''}):** ${c.body}`
      );

      // Attachments
      const attachmentLines = (issue.attachments?.nodes || []).map((a: any) =>
        `- [${a.title}](${a.url})`
      );

      const notesLines = [
        '## Linear Issue Notes',
        '',
        `**State:** ${issue.state?.name || ''} (${stateType})`,
        issue.estimate !== null && issue.estimate !== undefined ? `**Estimate:** ${issue.estimate} points` : '',
        issue.project?.name ? `**Project:** ${issue.project.name}` : '',
        issue.cycle?.name   ? `**Cycle:** ${issue.cycle.name} (#${issue.cycle.number})` : '',
        `**Created:** ${issue.createdAt?.slice(0, 10) || ''}`,
        ...(subIssueLines.length > 0 ? ['', '**Sub-issues (each imported as a separate plan):**', ...subIssueLines] : []),
        ...(commentLines.length > 0 ? ['', '**Comments:**', ...commentLines] : []),
        ...(attachmentLines.length > 0 ? ['', '**Attachments:**', ...attachmentLines] : []),
      ].filter(s => s !== '').join('\n');

      // Embed kanban column for PlanFileImporter (uses extractKanbanState() bold-markdown format)
      const switchboardState = `## Switchboard State\n\n**Kanban Column:** ${kanbanColumn}\n**Status:** active\n`;

      const stub = [
        `# ${issue.title || `Linear Issue ${issue.identifier}`}`,
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

> **Import required:** Add `import { LinearSyncService } from './services/LinearSyncService';` to the imports section. `path` and `fs` are already imported.

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand('switchboard.importFromLinear', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) { vscode.window.showErrorMessage('No workspace folder open.'); return; }

    const service = new LinearSyncService(workspaceRoot, context.secrets);
    const config = await service.loadConfig();

    if (!config?.setupComplete) {
      vscode.window.showWarningMessage('Linear is not set up. Run "Switchboard: Setup Linear Integration" first.');
      return;
    }

    const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Importing from Linear...', cancellable: false },
      async () => {
        const result = await service.importIssuesFromLinear(plansDir);
        if (!result.success) { vscode.window.showErrorMessage(`Import failed: ${result.error}`); return; }

        const msg = result.imported === 0
          ? `No new issues to import (${result.skipped} already tracked or closed).`
          : `Imported ${result.imported} issue${result.imported !== 1 ? 's' : ''} as plan files.${result.skipped ? ` (${result.skipped} skipped)` : ''}`;
        vscode.window.showInformationMessage(msg);
      }
    );
  })
);
```

### Target File 3: Command Registration
#### MODIFY `package.json`

```json
{
  "command": "switchboard.importFromLinear",
  "title": "Switchboard: Import Issues from Linear",
  "category": "Switchboard"
}
```

## What Goes in Each Imported Plan File

```markdown
# Fix login timeout bug

> Imported from Linear issue `ENG-123`
> **URL:** https://linear.app/team/issue/ENG-123
> **Priority:** high
> **Due:** 2026-04-15
> **Assignee:** patrickvuleta
> **Labels:** backend, auth
> **State:** Backlog

## Goal

[full markdown description from Linear issue]

## Proposed Changes

TODO

## Linear Issue Notes

**State:** Backlog (backlog)
**Estimate:** 3 points
**Project:** Mobile App
**Cycle:** Sprint 12 (#12)
**Created:** 2026-04-01

**Sub-issues (each imported as a separate plan):**
- Add token refresh logic (`ENG-124`) — see `linear_import_abc123.md`
- Update session timeout config (`ENG-125`) — see `linear_import_def456.md`

**Comments:**
- **Alice (2026-04-02):** This affects all mobile clients

## Switchboard State

**Kanban Column:** BACKLOG
**Status:** active
```

## Verification Plan

- Mock GraphQL returning 3 issues → verify 3 `.md` files written
- Mock 1 parent + 2 sub-issues (in `children.nodes`) → verify 3 files; parent notes list sub-issues; sub-issues show `**Parent Issue:**`
- Issue in `linear-sync.json` → verify skipped
- `completed` or `cancelled` state → verify skipped
- `hasNextPage: true` → verify cursor loop fetches next page
- Re-run with existing files → all skipped, count = 0

## Files to Modify

1. `src/services/LinearSyncService.ts` — MODIFY (add `importIssuesFromLinear()`)
2. `src/extension.ts` — MODIFY (register `switchboard.importFromLinear`, add import for `LinearSyncService`)
3. `package.json` — MODIFY (add command)
4. `src/services/planStateUtils.ts` — MODIFY (add `'BACKLOG'` and `'CODED'` to `VALID_COLUMNS` — pre-existing gap)

## Agent Recommendation

**Send to Coder** — Complexity 4. Same fetch-and-write pattern as ClickUp import, with cursor pagination instead of page numbers and nested sub-issues via GraphQL `children` field.

## Implementation Review (2026-04-09)

### Stage 1: Grumpy Principal Engineer

*Leans back, arms crossed.* Well, well. Let's see what horrors await.

1. **NIT — Shadowed variable `subIssues`**: The plan code (line 166) uses `const subIssues = allIssues.flatMap(...)` for the flatMap extraction. The implementation (line 433) does the same. But inside the per-issue loop, the plan (line 220) uses `const subIssues = subIssuesByParentId.get(issue.id) || [];` — SHADOWING the outer `subIssues` variable. The implementation (line 478) correctly renames this to `const subIssuesList = ...`. *Someone actually fixed the plan's naming bug during implementation.* I'm grudgingly impressed.

2. **NIT — `planStateUtils.ts` VALID_COLUMNS already fixed**: The plan's adversarial synthesis flagged BACKLOG and CODED as missing from `VALID_COLUMNS` and listed `planStateUtils.ts` as a file to modify. The current file (line 9-11) already includes both. Either this was fixed as part of this implementation or was fixed by a prior plan. Either way, the prerequisite is satisfied.

3. **NIT — `## Switchboard State` block format**: The implementation (line 519) writes `\`## Switchboard State\n\n**Kanban Column:** ${kanbanColumn}\n**Status:** active\n\`` — note the `\n\n` between header and first field, matching `extractKanbanState()`'s regex `## Switchboard State\s*\n([\s\S]*?)`. This is correct. The `\n` after `active` ensures the file doesn't end mid-line. No issues.

4. **NIT — No `switchboardState` section at end-of-file isolation**: The `stub` array joins with `\n` (line 520). The last element is the switchboard state string which already contains its own `\n`. The resulting file ends with `active\n\n` (one from the state string, one from the `join`). The `extractKanbanState` regex handles trailing whitespace fine. Acceptable.

### Stage 2: Balanced Synthesis

| Finding | Severity | Action |
|:--------|:---------|:-------|
| Shadowed variable fix | NIT (improvement) | ✅ Already fixed in implementation |
| planStateUtils.ts VALID_COLUMNS | NIT | ✅ Already includes BACKLOG and CODED |
| Switchboard State format | NIT | ✅ Correct bold-markdown format |
| End-of-file newlines | NIT | ✅ Acceptable — parser handles it |

**No code changes required.** Implementation is faithful to plan with minor improvements.

### Validation Results

- `npx tsc --noEmit`: ✅ Pass (only pre-existing ArchiveManager error)
- `npm run compile`: ✅ webpack compiled successfully
- All 4 target files verified:
  - `src/services/LinearSyncService.ts` — ✅ `importIssuesFromLinear()` present (line 379) with cursor pagination, Map-based dedup, bold-markdown state format, cancelled/completed skip logic
  - `src/extension.ts` — ✅ `importFromLinear` command registered (line 1507) with progress UI and result messaging
  - `package.json` — ✅ Command entry present (line 122)
  - `src/services/planStateUtils.ts` — ✅ VALID_COLUMNS already includes BACKLOG and CODED (no change needed)

### Remaining Risks

- None. Implementation faithfully follows plan with minor improvements (variable rename, VALID_COLUMNS already fixed).
