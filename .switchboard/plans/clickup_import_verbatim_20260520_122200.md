---
created: 2026-05-20T02:22:00.000Z
kanbanColumn: CREATED
---

# ClickUp Ticket Import: Enforce Verbatim Import

## Goal

Remove artificial section headers and metadata from ClickUp and Linear ticket import paths so that imported plan files contain only the ticket title, a minimal provenance blockquote, and the raw ticket description — matching the precedent set by the prior AutomationService fix.

## Problem

ClickUp ticket imports are adding artificial section headers and metadata that are not present in the original ClickUp tickets:

- "## Goal" header
- "## Proposed Changes" header  
- "## ClickUp Ticket Notes" header
- "TODO" section
- "**Status:**" metadata
- "**Attachments:**" metadata

These artifacts are being added by the import process and should not be present. Switchboard must import ClickUp tickets VERBATIM without adding any artificial structure or metadata.

## Requirements

**Import Behavior**
- Import ClickUp ticket content exactly as it appears in ClickUp
- Do NOT add section headers like "Goal", "Proposed Changes", "ClickUp Ticket Notes"
- Do NOT add "TODO" sections
- Do NOT include status or attachments metadata at the bottom of tickets
- Preserve original formatting and structure from ClickUp

**Current Import Artifacts to Remove**
- Remove "## Goal" header (keep the goal text as plain content)
- Remove "## Proposed Changes" header and "TODO" section
- Remove "## ClickUp Ticket Notes" header
- Remove "**Status:**" and "**Attachments:**" metadata blocks

## Metadata

- **Tags:** bugfix, backend
- **Complexity:** 4

## User Review Required

- [ ] Confirm that removing the `## ClickUp Ticket Notes` / `## Linear Issue Notes` sections (which contain subtask references, checklists, custom fields, comments, and attachments) is acceptable. The blockquote metadata at the top already captures the most important fields (task ID, URL, priority, due date, assignees, tags). This is consistent with the prior AutomationService fix precedent.
- [ ] Confirm that the Linear import path should also be fixed in the same pass for consistency (same artificial headers exist there).

## Complexity Audit

### Routine
- Remove `## Goal`, `## Proposed Changes`, `TODO` from `_buildClickUpImportPlanContent()` in TaskViewerProvider.ts (lines 4253-4259)
- Remove `## ClickUp Ticket Notes` section and `notesLines` assembly from `_buildClickUpImportPlanContent()` (lines 4236-4245)
- Remove `## Goal`, `## Proposed Changes`, placeholder text from `_buildLinearImportPlanContent()` in TaskViewerProvider.ts (lines 3954-3962)
- Remove `## Linear Issue Notes` section and `notesLines` assembly from `_buildLinearImportPlanContent()` (lines 3937-3946)
- Remove `## Goal`, `## Proposed Changes`, `TODO` from `importTasksFromClickUp()` in ClickUpSyncService.ts (lines 2459-2465)
- Remove `## ClickUp Ticket Notes` section and `notesLines` assembly from `importTasksFromClickUp()` (lines 2437-2449)
- Update integration test assertions in `clickup-import-flow.test.js`

### Complex / Risky
- **Moderate risk**: The `notesLines` section in ClickUpSyncService contains subtask cross-references (`clickup_import_${s.id}.md`), checklists, and custom fields that users may rely on for navigating imported subtask plans. Removing this section means subtask plan files still exist but the parent plan won't list them. The blockquote metadata does not include subtask references.
- **Low risk**: The TaskViewerProvider `_buildClickUpImportPlanContent` path has no integration test coverage. Changes there are untestable without writing new tests.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Both import paths write files synchronously with exclusive-create semantics.
- **Security:** None. No new input vectors; description content is already trusted from the external ticket system.
- **Side Effects:** Removing `## ClickUp Ticket Notes` from the SyncService path means parent plans will no longer list their subtask plan file references inline. Subtask plans are still created and linked in the database, but the parent plan file won't have a "see `clickup_import_xxx.md`" reference. This is consistent with the AutomationService fix precedent.
- **Dependencies & Conflicts:** Prior plan `feature_plan_20260509_195000_fix_ticket_import_metadata.md` already fixed the AutomationService import paths (ClickUpAutomationService, LinearAutomationService). This plan addresses the remaining two import paths (ClickUpSyncService, TaskViewerProvider). The AutomationService files must NOT be modified again.

## Dependencies

- `feature_plan_20260509_195000_fix_ticket_import_metadata` — prior fix for AutomationService import paths (precedent for minimal format: title + blockquote + raw description)

## Adversarial Synthesis

Key risks: (1) Removing `## ClickUp Ticket Notes` / `## Linear Issue Notes` discards subtask cross-references, checklists, custom fields, comments, and attachments that some users may rely on. (2) The plan originally only scoped ClickUp but the Linear path has identical artificial headers — fixing only ClickUp creates inconsistency. (3) The TaskViewerProvider import path has no test coverage. Mitigations: Follow the AutomationService precedent (already shipped), fix both ClickUp and Linear in one pass, and add negative assertions to the existing ClickUp test.

## Proposed Changes

### `src/services/ClickUpSyncService.ts`

- **Context:** `importTasksFromClickUp()` (lines 2380-2480) is the bulk import path. The `stub` assembly at lines 2454-2469 adds `## Goal`, `## Proposed Changes`, `TODO`, and `notesLines` (the `## ClickUp Ticket Notes` section).
- **Logic:** The kanban database already tracks `kanbanColumn`, `status`, `sourceType`, `clickupTaskId`. The `## ClickUp Ticket Notes` section duplicates data already in the blockquote or tracked in the DB. `## Goal` and `## Proposed Changes` are artificial wrappers around the raw description.
- **Implementation:**
  1. **Remove the `notesLines` assembly** (lines 2437-2449) — the entire `## ClickUp Ticket Notes` section including `**Status:**`, `**Start Date:**`, `**Time Estimate:**`, `**Creator:**`, `**Linked Tasks:**`, `**Dependencies:**`, subtask references, checklists, and custom fields.
  2. **Remove the variables only used by `notesLines`** (lines 2419-2435): `startDate`, `timeEstimate`, `creator`, `linkedTasks`, `dependencies`, `checklistLines`, `customFieldLines`, `subtaskLines` (the local one at line 2435, not the earlier subtasksByParentId usage).
  3. **Rewrite the `stub` assembly** (lines 2454-2469) to:
     ```
     const stub = [
       `# ${task.name || `ClickUp Task ${task.id}`}`,
       '',
       metaLines,
       '',
       description || '',
     ].join('\n');
     ```
  4. **Remove the `'TODO'` fallback** — if description is empty, the plan ends after the blockquote (acceptable, matching AutomationService precedent).
- **Edge Cases:**
  - Empty description → plan ends after blockquote (acceptable).
  - Subtask cross-references lost → subtask plans still exist and are linked in DB; parent plan just doesn't list them inline.
  - Re-import after deletion → new plan uses clean format.

### `src/services/TaskViewerProvider.ts` — `_buildClickUpImportPlanContent()`

- **Context:** `_buildClickUpImportPlanContent()` (lines 4190-4263) is the single-task UI import path. The return value at lines 4247-4262 adds `## Goal`, `## Proposed Changes`, `TODO`, and `notesLines` (the `## ClickUp Ticket Notes` section).
- **Logic:** Same redundancy analysis as ClickUpSyncService. The blockquote metadata already captures the essential fields.
- **Implementation:**
  1. **Remove the `notesLines` assembly** (lines 4236-4245) — the entire `## ClickUp Ticket Notes` section including `**Status:**`, `**Start Date:**`, `**Time Estimate:**`, subtask references, comments, and attachments.
  2. **Remove variables only used by `notesLines`** (lines 4208-4234): `startDate`, `timeEstimate`, `subtaskLines`, `commentLines`, `attachmentLines`.
  3. **Rewrite the return value** (lines 4247-4262) to:
     ```
     return [
         yamlFrontmatter,
         `# ${task.name || `ClickUp Task ${task.id}`}`,
         '',
         metaLines,
         '',
         description || '',
     ].join('\n');
     ```
  4. **Remove the `'TODO'` fallback** for empty description.
- **Edge Cases:** Same as ClickUpSyncService. Note: comments and attachments from the API response are no longer written to the plan file.

### `src/services/TaskViewerProvider.ts` — `_buildLinearImportPlanContent()`

- **Context:** `_buildLinearImportPlanContent()` (lines 3901-3965) is the Linear single-task UI import path. The return value at lines 3948-3964 adds `## Goal`, `## Proposed Changes` (with placeholder text), and `notesLines` (the `## Linear Issue Notes` section).
- **Logic:** Same redundancy analysis. The blockquote metadata already captures state, assignee, labels. The `## Linear Issue Notes` section duplicates state info and adds comments/attachments.
- **Implementation:**
  1. **Remove the `notesLines` assembly** (lines 3937-3946) — the entire `## Linear Issue Notes` section including `**Current State:**`, `**Project:**`, `**Created:**`, subtask references, comments, and attachments.
  2. **Remove variables only used by `notesLines`** (lines 3925-3936): `subtaskLines`, `commentLines`, `attachmentLines`.
  3. **Rewrite the return value** (lines 3948-3964) to:
     ```
     return [
         yamlFrontmatter,
         `# ${issue.title || `Linear Issue ${issue.identifier || issue.id}`}`,
         '',
         metadataLines,
         '',
         issue.description || '',
     ].join('\n');
     ```
  4. **Remove the fallback text** `'Translate this Linear issue into an executable Switchboard plan.'` for empty description — just use empty string, matching ClickUp precedent.
- **Edge Cases:** Same as ClickUp paths.

### `src/test/integrations/clickup/clickup-import-flow.test.js`

- **Context:** Existing integration test asserts on old plan content format from `ClickUpSyncService.importTasksFromClickUp()`.
- **Implementation:**
  - Line 89: `assert.ok(parentContent.includes('## ClickUp Ticket Notes'))` — **remove or replace** with `assert.ok(!parentContent.includes('## ClickUp Ticket Notes'))`.
  - Line 90: `assert.ok(parentContent.includes('**ClickUp Task ID:** task-parent'))` — **keep** (still present in blockquote).
  - Line 91: `assert.ok(parentContent.includes('**Subtasks (each imported as a separate plan):**'))` — **remove** (subtask references no longer in plan).
  - Line 92: `assert.ok(parentContent.includes('clickup_import_task-child.md'))` — **remove** (subtask cross-reference no longer in plan).
  - Line 93: `assert.ok(parentContent.includes('**Custom Fields:**'))` — **remove** (custom fields no longer in plan).
  - Line 94: `assert.ok(parentContent.includes('**Kanban Column:** CREATED'))` — **remove** (kanban column tracked in DB, not plan file).
  - Line 97: `assert.ok(childContent.includes('## Goal'))` — **replace** with `assert.ok(!childContent.includes('## Goal'))`.
  - Add new negative assertions: plan does NOT contain `## Proposed Changes`, `## ClickUp Ticket Notes`, `TODO`.
  - Add new assertion: `assert.ok(parentContent.includes('TODO'.replace('TODO', '')))` or verify raw description text is present (depends on fixture data).

## Verification Plan

### Automated Tests

1. **Update existing ClickUp integration test** (`src/test/integrations/clickup/clickup-import-flow.test.js`):
   - Replace positive assertions on old-format sections with negative assertions (plan does NOT contain `## Goal`, `## Proposed Changes`, `## ClickUp Ticket Notes`, `TODO`).
   - Keep assertions on blockquote metadata (`**ClickUp Task ID:**`).
   - Remove assertions on `**Subtasks**`, `**Custom Fields:**`, `**Kanban Column:**` (no longer in plan file).
   - Verify raw description text is preserved verbatim.

2. **TaskViewerProvider import path** — no existing integration test. The method is private and called only from `importClickUpTask()`. Manual verification or a new test would be needed for full coverage. Given the simplicity of the change (removing lines, not adding logic), static inspection is acceptable.

3. **Linear import path** — no existing integration test for `_buildLinearImportPlanContent()`. Same rationale as above.

4. **Regression check**: Ensure the AutomationService import paths (already fixed in prior plan) are NOT modified. The `ClickUpAutomationService._buildPlanContent()` and `LinearAutomationService._buildPlanContent()` methods should remain in their current minimal format.

## Technical Work

**Locate Import Code**
- Find the ClickUp import function in Switchboard codebase
- Identify where artificial headers are being added
- Identify where metadata (status, attachments) is being appended

**Fix Import Logic**
- Remove code that adds "## Goal" header
- Remove code that adds "## Proposed Changes" header
- Remove code that adds "## ClickUp Ticket Notes" header
- Remove code that appends status and attachments metadata
- Ensure only the ClickUp ticket description content is imported

**Test**
- Import a sample ClickUp ticket
- Verify no artificial headers are present
- Verify no metadata is appended
- Verify content matches ClickUp exactly

## Key Files

- Switchboard import code (location to be determined)
- Test with existing imported tickets to verify fix

## Complexity Analysis

Scope: Small — Remove artificial header generation from import logic
Net new integrations: None
Complexity score: 4/10

## Recommendation

Complexity is 4 → **Send to Coder**

---

## Reviewer Pass (2026-05-21)

### Stage 1: Grumpy Principal Engineer Findings

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Dead code: `subtasksByParentId` Map in ClickUpSyncService (lines 2322-2328) — populated but never read after `notesLines` removal | MAJOR | **Fixed** |
| 2 | Dead code: `kanbanColumn` variable in ClickUpSyncService (line 2393) — computed but never used (no YAML frontmatter in bulk import stub) | MAJOR | **Fixed** |
| 3 | Unused parameters in `_buildClickUpImportPlanContent`: `subtasks`, `comments`, `attachments` — vestigial from removed `notesLines` section | MAJOR | **Fixed** |
| 4 | Inconsistent frontmatter: ClickUpSyncService writes no YAML frontmatter; TaskViewerProvider methods include `created`/`kanbanColumn` frontmatter | NIT | **Deferred** (intentional architectural difference) |
| 5 | Test doesn't verify raw description content preservation — only checks for absence of artificial headers | NIT | **Deferred** (code clearly passes `description \|\| ''` without transformation) |

### Stage 2: Balanced Synthesis

- **Fix now (MAJOR):** Findings 1-3 are dead code left behind after the `notesLines` removal. All are in private methods/internal code with no API contract implications. Safe to remove, improves readability, eliminates confusion.
- **Defer (NIT):** Findings 4-5 are cosmetic/test-coverage gaps. The frontmatter inconsistency is intentional (bulk import tracks kanban via DB; single-task import uses frontmatter). The description preservation is self-evident from the code.

### Code Fixes Applied

**File: `src/services/ClickUpSyncService.ts`**
- Removed `subtasksByParentId` Map declaration and population loop (was lines 2322-2328)
- Removed dead `kanbanColumn` variable (was line 2393)
- Updated comment from "Build lookup maps" to "Build lookup map" (singular)

**File: `src/services/TaskViewerProvider.ts`**
- Removed unused parameters `subtasks`, `comments`, `attachments` from `_buildClickUpImportPlanContent` signature
- Updated caller at line ~4091: `this._buildClickUpImportPlanContent(task, createdAt)` (was passing `subtasks, details.comments, details.attachments`)
- Updated caller at line ~4111: `this._buildClickUpImportPlanContent(subtask, subtaskCreatedAt)` (was passing `[], [], []`)

### Verification Results

- **ClickUp integration test** (`clickup-import-flow.test.js`): **PASS** — negative assertions confirm no `## ClickUp Ticket Notes`, `## Goal`, `## Proposed Changes`, `TODO` in imported plans; blockquote metadata (`**ClickUp Task ID:**`) still present.
- **Linear integration test** (`linear-import-flow.test.js`): **PASS** — negative assertions confirm no `## Linear Issue Notes`, `## Goal`, `## Proposed Changes`, `TODO` in imported plans.
- **TypeScript check**: Pre-existing errors only (unrelated `import('./KanbanDatabase')` extension resolution and `ArchiveManager` import in KanbanProvider). No new errors from this plan's changes.
- **AutomationService regression**: `ClickUpAutomationService._buildPlanContent()` and `LinearAutomationService._buildPlanContent()` confirmed in minimal format, NOT modified. ✅
- **ClickUp automation service test**: Pre-existing failure (unrelated to this plan — about unscoped rule polling, not import content format).

### Remaining Risks

1. **Subtask cross-references removed**: Parent plans no longer list subtask plan file references inline. Subtask plans still exist and are linked in the DB. Consistent with AutomationService precedent.
2. **No YAML frontmatter in bulk import**: ClickUpSyncService stub has no `kanbanColumn` frontmatter. Kanban column is tracked via DB defaults during discovery. If DB discovery fails, imported plans default to CREATED column.
3. **TaskViewerProvider import paths untested**: `_buildClickUpImportPlanContent` and `_buildLinearImportPlanContent` have no dedicated integration tests. Static inspection confirms correct minimal format.
