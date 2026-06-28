# Split Kanban Board Export into Per-Column Markdown Files

## Goal

The single `kanban-board.md` file has grown to 276 KB+. Agents can work around this (grep for a column heading, then read forward), but that's a fragile two-step every time. This plan splits the export into one file per column so agents can read exactly what they need in a single operation, and converts `kanban-board.md` into a lightweight index that links to each per-column file.

### Core Problem

`exportStateToFile()` writes all columns into a single file. Targeted column access requires grepping for the heading and reading forward — workable but unnecessarily fiddly. Per-column files make the access pattern direct and self-evident.

### Solution

- Generate `.switchboard/kanban-state-{slug}.md` per column alongside the existing `kanban-board.md`.
- `kanban-board.md` becomes an index: header + table of links to each per-column file.
- All per-column files are `!`-negated in `.gitignore` so they are tracked like `kanban-board.md`.

---

## Metadata

**Tags:** backend, feature, performance
**Complexity:** 4

---

## User Review Required

Yes — before implementation, the user should confirm:

1. **Custom column bug fix scope**: The plan fixes a pre-existing bug where plans in custom columns (e.g., `QA REVIEW`, `custom_column_docs_ready`) are silently dropped from `kanban-board.md` because `VALID_KANBAN_COLUMNS` doesn't include them. The fix adds a custom-column pass that writes per-column files for these. Confirm this bug fix should be included in this plan rather than a separate bugfix plan.
2. **Sibling plan ordering**: This plan should be implemented **after** `keep-valid-kanban-columns-in-sync-with-defaults.md` (which fixes the column iteration source) and `remove-context-gatherer-splitter-code-researcher-agents.md` (which removes `CONTEXT GATHERER` from `VALID_KANBAN_COLUMNS`). If implemented first, the per-column file list will include `CONTEXT GATHERER` and miss 7 other built-in columns. Confirm the ordering.
3. **Stale per-column files**: If a column is ever renamed or removed (e.g., `CONTEXT GATHERER` removal in the sibling plan), the old per-column file (e.g., `kanban-state-context-gatherer.md`) will stop updating but remain on disk. The plan explicitly leaves stale-file cleanup out of scope. Confirm this is acceptable.

---

## Complexity Audit

### Routine
- Adding a `_columnSlug()` helper function — pure string transformation (lowercase + spaces → hyphens)
- Refactoring `exportStateToFile()` to loop over columns and write per-column files — reuses the existing `tmp → rename` atomic write pattern
- Building a new index markdown string for `kanban-board.md` — simple table format
- Adding one glob entry to `TARGETED_RULES` in `WorkspaceExcludeService.ts`
- Updating the committed `.gitignore` to match

### Complex / Risky
- **Custom column discovery pass**: Collecting plans whose `kanbanColumn` is not in `VALID_KANBAN_COLUMNS` into a separate `customColumns` map. This is new logic that handles a previously-silently-dropped edge case. The `if (list) list.push(plan)` guard on line 5471 currently discards these plans; the new code must catch them before that guard.
- **Concurrency model**: `exportStateToFile()` is called fire-and-forget (line 5544: `void this.exportStateToFile()`), NOT chained via `_writeTail`. Multiple concurrent calls could interleave per-column writes. The atomic `tmp → rename` pattern ensures no file corruption, and the index only contains file names (not contents), so brief inconsistency is acceptable. But the implementer must understand this is NOT `_writeTail`-chained.

---

## Edge-Case & Dependency Audit

**Race Conditions**
- `exportStateToFile()` is fire-and-forget, called after `_persist()` completes (line 5544). It is NOT chained via `_writeTail`. Two concurrent calls (from rapid column moves) could interleave: call A writes per-column files, call B writes per-column files, call A writes index, call B writes index. Each per-column file is atomically written (`tmp → rename`), so no corruption. The index lists only file names, so it's always valid regardless of write order. Worst case: a brief moment where per-column files reflect call A's snapshot while the index was written by call B — but both snapshots are nearly identical (same board, milliseconds apart). Acceptable.

**Security**
- No security implications. The per-column files contain the same plan data as the existing `kanban-board.md`, just split into smaller files. No new data is exposed.

**Side Effects**
- Disk usage increases slightly: instead of one 276 KB file, there are 9+ small files plus a tiny index. Total content is the same; only file system overhead (inodes, directory entries) increases marginally.
- The existing `kanban-board.md` path (`_stateFilePath`, line 1114) is unchanged — no rename, no migration. Agents that currently read `kanban-board.md` will now get a fast index instead of a 276 KB wall. This is a breaking change for any agent that expects full plan content in `kanban-board.md` — but the plan explicitly leaves "updating agent consumers" out of scope.

**Dependencies & Conflicts**
- **`keep-valid-kanban-columns-in-sync-with-defaults.md`**: That plan changes `exportStateToFile()` to iterate `DEFAULT_KANBAN_COLUMNS` sorted by `order` instead of `VALID_KANBAN_COLUMNS` (a `Set`, unordered). If implemented first, the per-column files will be generated in the correct visual order and will include all 14 built-in columns. If this plan is implemented first, it will iterate the current 9-entry `VALID_KANBAN_COLUMNS` `Set` (missing 7 columns). **Recommended ordering: sync plan first, then this plan.**
- **`remove-context-gatherer-splitter-code-researcher-agents.md`**: That plan removes `CONTEXT GATHERER` from `VALID_KANBAN_COLUMNS`. If implemented first, the per-column file `kanban-state-context-gatherer.md` will no longer be generated. If this plan is implemented first, the file will be generated but will become stale after the removal. **Recommended ordering: removal plan first, then this plan.**
- The `git-ignore-custom-default-regression.test.js` test does NOT assert `TARGETED_RULES` contents — it checks `DEFAULT_RULES` emptiness, `ignoreRules` defaults, `setup.html` initialization, and `workspace-id` exclusion. Adding a new glob to `TARGETED_RULES` will NOT break this test. **No test update needed.** (The original plan incorrectly stated this test asserts `TARGETED_RULES` contents.)

---

## Dependencies

- `keep-valid-kanban-columns-in-sync-with-defaults.md` — should be implemented first. It fixes the column iteration source in `exportStateToFile()` to use `DEFAULT_KANBAN_COLUMNS` (14 columns, ordered) instead of `VALID_KANBAN_COLUMNS` (9 columns, unordered). This plan's per-column file generation builds on that corrected iteration.
- `remove-context-gatherer-splitter-code-researcher-agents.md` — should be implemented first. It removes `CONTEXT GATHERER` from `VALID_KANBAN_COLUMNS`, so this plan doesn't generate a per-column file for a column that's being deleted.

---

## Adversarial Synthesis

Key risks: (1) the original plan claimed the regression test asserts `TARGETED_RULES` contents — it does not, making Step 4 a phantom task; (2) the plan said writes are "chained via `_writeTail`" — `exportStateToFile()` is actually fire-and-forget, not `_writeTail`-chained, which changes the concurrency reasoning; (3) the plan doesn't account for sibling plans that change the column iteration source and column set — implementing this plan first would generate per-column files for a stale column set. Mitigations: corrected the test claim, documented the actual concurrency model, and added explicit sibling-plan ordering dependencies.

---

## Proposed Changes

### `src/services/KanbanDatabase.ts` — Add `_columnSlug()` helper (Step 1)

**Context:** A pure string transformation function that maps a column name to its file-safe slug.

**Implementation:** Add a module-level function (or private static method) near the top of the file, after the constants section:

```typescript
function _columnSlug(columnName: string): string {
    return columnName.toLowerCase().replace(/\s+/g, '-');
}
```

**Edge Cases:** The current column set uses only uppercase letters and spaces — `lowercase + replace spaces with hyphens` covers all cases. Underscores in custom column names (e.g., `custom_column_docs_ready`) are preserved by this rule. If a custom column name contains special characters that pass `SAFE_COLUMN_NAME_RE` (which allows `[a-zA-Z0-9 _-]`), hyphens in the original name are preserved (no double-hyphen issue since we only replace spaces).

**Built-in column slug mapping (verified against current `VALID_KANBAN_COLUMNS`):**

| Column Name | Slug |
|---|---|
| CREATED | `created` |
| BACKLOG | `backlog` |
| CONTEXT GATHERER | `context-gatherer` |
| PLAN REVIEWED | `plan-reviewed` |
| LEAD CODED | `lead-coded` |
| CODER CODED | `coder-coded` |
| CODE REVIEWED | `code-reviewed` |
| CODED | `coded` |
| COMPLETED | `completed` |

Note: If the sibling plan `keep-valid-kanban-columns-in-sync-with-defaults.md` is implemented first, the column set will include 14 built-in columns (adding `RESEARCHER`, `CODE_RESEARCHER`, `SPLITTER`, `INTERN CODED`, `ORCHESTRATING`, `ACCEPTANCE TESTED`, `TICKET UPDATER`). The slug function handles all of these without special cases.

### `src/services/KanbanDatabase.ts` — Refactor `exportStateToFile()` (Step 2)

**Context:** The current method (lines 5451–5512) builds one big markdown string with all columns and atomic-writes it to `_stateFilePath` (`kanban-board.md`). It iterates `VALID_KANBAN_COLUMNS` (line 5466) and silently drops plans in custom columns via the `if (list) list.push(plan)` guard (line 5471).

**Implementation — New flow:**

1. **Build the columns map** (same as today, lines 5465–5472). If the sibling sync plan is implemented first, this will iterate `DEFAULT_KANBAN_COLUMNS` sorted by `order` instead.

2. **Collect custom columns** (NEW): After distributing plans into the built-in `columns` map, collect any plan whose `kanbanColumn` is not in the map into a separate `customColumns: Map<string, KanbanPlanRecord[]>`. This catches plans that the `if (list)` guard would silently drop:
   ```typescript
   const customColumns = new Map<string, KanbanPlanRecord[]>();
   for (const plan of allPlans) {
       if (!columns.has(plan.kanbanColumn)) {
           if (!customColumns.has(plan.kanbanColumn)) {
               customColumns.set(plan.kanbanColumn, []);
           }
           customColumns.get(plan.kanbanColumn)!.push(plan);
       }
   }
   ```

3. **Write per-column files** (NEW): Loop over all columns (built-in + custom) and write each to `.switchboard/kanban-state-{slug}.md` using the existing `tmpPath → rename` pattern:
   ```typescript
   const allColumns = [
       ...columns.entries(),
       ...customColumns.entries(),
   ];
   for (const [col, plans] of allColumns) {
       const perColPath = path.join(this._workspaceRoot, '.switchboard', `kanban-state-${_columnSlug(col)}.md`);
       let colMd = `## ${col}\n\n`;
       if (plans.length === 0) {
           colMd += `_No plans_\n\n`;
       } else {
           for (const plan of plans) {
               // Same plan-line format as today (lines 5482–5494)
               const filePath = path.isAbsolute(plan.planFile)
                   ? plan.planFile
                   : path.join(this._workspaceRoot, plan.planFile);
               const parts = [`planId:${plan.planId}`];
               if (plan.isEpic) { parts.push('epic'); }
               if (plan.epicId) {
                   const epicTopic = epicTopicById.get(plan.epicId);
                   parts.push(epicTopic ? `subtask-of:"${epicTopic}"` : `subtask-of:${plan.epicId}`);
               }
               colMd += `- [${plan.planFile}](${filePath}) — ${plan.topic} <!-- ${parts.join(' ')} -->\n`;
           }
           colMd += `\n`;
       }
       const tmpPath = perColPath + '.tmp';
       await fs.promises.writeFile(tmpPath, colMd, 'utf8');
       await fs.promises.rename(tmpPath, perColPath);
   }
   ```

4. **Write the index** (`kanban-board.md`): Build a new index markdown string and atomic-write it to `_stateFilePath`:
   ```typescript
   let md = `# Kanban Board\n\n`;
   md += `*Workspace: ${workspaceId}* · *Updated: ${new Date().toISOString()}*\n\n`;
   md += `| Column | File |\n|---|---|\n`;
   for (const [col, plans] of allColumns) {
       const slug = _columnSlug(col);
       md += `| ${col} | [kanban-state-${slug}.md](./kanban-state-${slug}.md) |\n`;
   }
   const tmpPath = this._stateFilePath + '.tmp';
   await fs.promises.writeFile(tmpPath, md, 'utf8');
   await fs.promises.rename(tmpPath, this._stateFilePath);
   ```

5. **One-time cleanup** (preserved from current code, lines 5500–5504): The old `kanban-state.json` cleanup remains unchanged.

**Edge Cases:**
- **Concurrency**: `exportStateToFile()` is called fire-and-forget (line 5544: `void this.exportStateToFile()`), NOT chained via `_writeTail`. Multiple concurrent calls could interleave per-column writes. The atomic `tmp → rename` pattern ensures no file corruption. The index lists only file names, so it's always valid. This is the same concurrency model as today — the only difference is more files are written per call.
- **Empty columns**: Per-column files for empty columns still get written (containing `_No plans_`). This matches the current behavior where `kanban-board.md` includes empty column headings.
- **Custom column naming**: Custom column names validated by `SAFE_COLUMN_NAME_RE = /^[a-zA-Z0-9 _-]{1,128}$/` are slugified by the same lowercase + spaces-to-hyphens rule. A column named `QA REVIEW` → `kanban-state-qa-review.md`. A column named `custom_column_docs_ready` → `kanban-state-custom_column_docs_ready.md` (underscores preserved).

### `src/services/WorkspaceExcludeService.ts` — Add gitignore glob (Step 3)

**Context:** The `.gitignore` managed block is regenerated from `TARGETED_RULES` (lines 9–28) every time a user runs setup. The existing `'!.switchboard/kanban-board.md'` entry is at line 18.

**Implementation:** Add `'!.switchboard/kanban-state-*.md'` to `TARGETED_RULES` immediately after line 18:

```typescript
'!.switchboard/kanban-board.md',
'!.switchboard/kanban-state-*.md',
```

The glob covers all per-column files without listing them individually. `WorkspaceExcludeService.apply()` will write this into the managed block on the next setup invocation.

**Edge Cases:** The glob `kanban-state-*.md` is specific enough to not accidentally match other files. The only files in `.switchboard/` starting with `kanban-state-` will be the per-column exports.

### `.gitignore` — Manual update (Step 3b)

**Context:** The committed `.gitignore` has a managed block (lines 72–91) that mirrors `TARGETED_RULES`. The existing `'!.switchboard/kanban-board.md'` is at line 81.

**Implementation:** Add `'!.switchboard/kanban-state-*.md'` immediately after line 81:

```
!.switchboard/kanban-board.md
!.switchboard/kanban-state-*.md
```

This ensures new contributors get the negation without needing to run setup first.

### `src/test/git-ignore-custom-default-regression.test.js` — NO CHANGES NEEDED (Step 4)

**Context:** The original plan stated this test "asserts the exact contents of `TARGETED_RULES`" and instructed adding the new glob to the expected array. **This is incorrect.** A read of the test file (92 lines) confirms it does NOT reference `TARGETED_RULES` at all. It checks:
- `DEFAULT_RULES` is empty (line 58)
- `ignoreRules` defaults to `[]` (lines 25–29)
- `setup.html` initialization and hydration (lines 31–40)
- `workspace-id` is NOT re-included (lines 66–73)
- `.vscode/settings.json` doesn't override defaults (lines 75–82)

None of these assertions are affected by adding `'!.switchboard/kanban-state-*.md'` to `TARGETED_RULES`. **No test update is needed.**

---

## What Was Missing from the Original Plan

Step 3 originally said "update `.gitignore` directly." That is wrong — the managed block is owned by `WorkspaceExcludeService.TARGETED_RULES` and regenerated on setup. A direct `.gitignore` edit would be overwritten. The fix is to update `TARGETED_RULES` (which drives both generation and the setup.html preview display), then also patch the committed `.gitignore` to match. (Preserved from original plan's correction section.)

Step 4 originally said the regression test asserts `TARGETED_RULES` contents. It does not. The test checks `DEFAULT_RULES`, `ignoreRules` defaults, and `workspace-id` exclusion — none of which are affected by the new glob. No test update is needed. (Corrected from original plan.)

The original plan said "All writes are fire-and-forget and chained via `_writeTail`." This is partially incorrect — `exportStateToFile()` is fire-and-forget but NOT chained via `_writeTail`. The `_persist()` method chains its DB write via `_writeTail` (lines 5539–5540), then calls `exportStateToFile()` as a separate `void` fire-and-forget (line 5544). The per-column writes inherit this same fire-and-forget model. (Corrected from original plan.)

---

## What Stays the Same

- `kanban-board.md` path (`_stateFilePath`, line 1114) and its git tracking — no renames, no migration.
- Atomic write pattern (`tmp → rename`) — reused verbatim for each new file.
- Plan-line format in per-column files — identical to the current `kanban-board.md` format (including `planId` and epic HTML comments).
- The `epicTopicById` lookup (lines 5459–5464) — reused for per-column plan lines.
- All existing agent consumers that read `kanban-board.md` continue to work; they now get a fast index instead of a 276 KB wall.

---

## Out of Scope

- Updating agent consumers to read per-column files directly (can be a follow-on once files exist and agents are updated to prefer them).
- Pruning/archiving old per-column files if a column is ever renamed or removed (extremely rare; file would simply stop updating). See `remove-context-gatherer-splitter-code-researcher-agents.md` for a case where `kanban-state-context-gatherer.md` would become stale.
- The `kanban-state.json` one-time cleanup (lines 5500–5504) — preserved as-is, unrelated to this change.

---

## Recommendation

Complexity 4 → **Send to Coder**
