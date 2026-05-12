# Fix ClickUp/Linear ticket import to be verbatim

> Imported from user request

## Goal

Remove extra metadata sections from ClickUp/Linear ticket imports so that imported plan files contain only the ticket title, a minimal import-metadata blockquote, and the raw ticket description. The current implementation unconditionally adds `## Metadata`, `## Goal`, `## Proposed Changes`, `## ClickUp/Linear Issue Notes`, and `## Switchboard State` sections that pollute the imported content.

## Metadata

- **Tags:** workflow, bugfix, backend
- **Complexity:** 4

## User Review Required

- [ ] Confirm that preserving `> **Automation Rule:** <name>` in the metadata blockquote is acceptable (required for write-back functionality).
- [ ] Confirm whether `_buildGoal()`, `_buildProposedChanges()`, and `_truncate()` helper methods should be deleted as dead code or left for potential future reuse.
- [ ] Confirm that dropping `> **Plan ID:**`, `> **Session ID:**`, `> **List:**`/`> **State:**`, and `> **Tags:**`/`> **Labels:**` from the blockquote is acceptable — these are informational only and not parsed back by any code path.

## Complexity Audit

### Routine

- Modify `_buildPlanContent()` in `ClickUpAutomationService.ts` (lines 169-223) to strip wrapper sections and `## Metadata` section.
- Modify `_buildPlanContent()` in `LinearAutomationService.ts` (lines 177-232) to strip wrapper sections and `## Metadata` section.
- Remove dead-code methods: `_buildGoal()` (ClickUp line 152, Linear line 160), `_buildProposedChanges()` (ClickUp line 158, Linear line 166), and `_truncate()` (ClickUp line 107, Linear line 115) — `_truncate()` is only called from `_buildProposedChanges()` in both services.
- Update existing integration test assertions that check for old format sections.

### Complex / Risky

- **Moderate risk**: Write-back resolution (`_resolveStoredRule`, ClickUp lines 225-239, Linear lines 234-248) regex-parses `> **Automation Rule:**` from the plan content via `_extractPlanMetadata()`. This metadata line must be preserved in the blockquote or write-back will silently fail. The regex `^(?:>\\s*)?\\*\\*${label}:\\*\\*\\s*(.+?)\\s*$` with `im` flags matches both blockquote and non-blockquote lines, so the new blockquote format will continue to match.
- **Moderate risk**: Existing integration tests assert on the old plan format (ClickUp test line 203 asserts `**Kanban Column:** CREATED`; Linear test lines 529-530 assert `## Linear Issue Notes` and `**Kanban Column:** CREATED`). These assertions must be updated to match the new minimal format or the test suite will fail.
- **Low risk**: `_buildPlanContent()` currently accepts `planId` and `sessionId` parameters (ClickUp lines 172-173, Linear lines 180-181) which are used in the old blockquote (`> **Plan ID:**`, `> **Session ID:**`). In the new format these are unused. The method signature should be simplified and the call sites (ClickUp line 349, Linear line 482) updated accordingly.

## Edge-Case & Dependency Audit

- **Race Conditions:** Minimal. Plan creation uses `writeFile` with `flag: 'wx'` (exclusive create, ClickUp line 350, Linear line 483) and catches `EEXIST` (ClickUp line 354, Linear line 488), so concurrent poll cycles are handled. The "single-threaded per polling cycle" claim is approximately correct for the common case.
- **Security:** None. No new input vectors; description content is already trusted from the external ticket system.
- **Side Effects:** Write-back pipeline depends on `Automation Rule` metadata in plan content. Removing it breaks `_resolveStoredRule()` → `_buildWriteBackSummary()` → `writeBackAutomationResult()` chain. The new format preserves this line in the blockquote, so write-back continues to work. Write-back content will change — instead of sending back the full structured plan with `## Goal`/`## Proposed Changes`/etc., it will send back the raw ticket description. This is a positive behavioral change.
- **Dependencies & Conflicts:** None. Self-contained change within two automation services and their test files.

## Dependencies

- None

## Adversarial Synthesis

The plan correctly identifies the write-back dependency on `> **Automation Rule:**` and preserves it, but overlooks three gaps: (1) `_truncate()` becomes dead code alongside `_buildGoal()`/`_buildProposedChanges()` and must be removed; (2) the `planId`/`sessionId` parameters on `_buildPlanContent()` become unused and the method signature should be cleaned up; (3) existing integration tests assert on old-format sections (`## Linear Issue Notes`, `**Kanban Column:**`) and will fail without updates. The `## Metadata` section (lines 203-206 ClickUp, 212-215 Linear) is also removed but was not explicitly listed in the original "sections to remove" inventory.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/ClickUpAutomationService.ts`

- **Context:** `_buildPlanContent()` (lines 169-223) currently assembles a full plan template with `## Metadata`, `## Goal`, `## Proposed Changes`, `## ClickUp Task Notes`, and `## Switchboard State` sections.
- **Logic:** The kanban database already tracks `kanbanColumn`, `status`, `sourceType`, `clickupTaskId`, etc. The `## Switchboard State` section in the plan file is redundant. `## Metadata` (tags/complexity) is redundant — tags are tracked in the DB and complexity is always "Unknown". `## Goal` and `## Proposed Changes` duplicate or paraphrase the ticket description. `## ClickUp Task Notes` duplicates automation rule metadata that is not needed in the plan content.
- **Implementation:**
  1. **Rewrite `_buildPlanContent()` (lines 169-223)** to return only:
     - `# ${task.name || 'ClickUp Task ${task.id}'}` heading
     - Blockquote with: `> Imported from ClickUp task \`${task.id}\``, `> **ClickUp Task ID:** ${task.id}`, `> **Automation Rule:** ${rule.name}`, and `> **URL:** ${task.url}` if present
     - Blank line
     - `task.description || ''`
  2. **Simplify method signature** — remove `planId` and `sessionId` parameters from `_buildPlanContent()` (lines 172-173). Update call site at line 349 to pass only `(taskSummary, matchedRule)`.
  3. **Delete `_buildGoal()`** (lines 152-156) — no remaining callers.
  4. **Delete `_buildProposedChanges()`** (lines 158-167) — no remaining callers.
  5. **Delete `_truncate()`** (lines 107-113) — only caller was `_buildProposedChanges()`. `_normalizeWhitespace()` (lines 103-105) is still used directly in `poll()` at line 336 and must be retained.
- **Edge Cases:**
  - Empty description → plan ends after the blockquote (acceptable).
  - Long/formatted descriptions → passed through as-is (preserves markdown).
  - Re-import after deletion → new plan uses clean format; old plans remain unchanged.
  - Missing URL → blockquote omits the URL line entirely (existing `filter(Boolean)` behavior preserved).

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/LinearAutomationService.ts`

- **Context:** `_buildPlanContent()` (lines 177-232) mirrors the ClickUp service structure with `## Metadata`, `## Goal`, `## Proposed Changes`, `## Linear Issue Notes`, and `## Switchboard State`.
- **Logic:** Same redundancy analysis as ClickUp. Kanban state is tracked in the database; the plan file is the user's workspace, not a state dump.
- **Implementation:**
  1. **Rewrite `_buildPlanContent()` (lines 177-232)** to return only:
     - `# ${issue.title || 'Linear Issue ${reference}'}` heading
     - Blockquote with: `> Imported from Linear issue \`${reference}\``, `> **Linear Issue ID:** ${issue.id}`, `> **Automation Rule:** ${rule.name}`, `> **Identifier:** ${issue.identifier}` if present, and `> **URL:** ${issue.url}` if present
     - Blank line
     - `issue.description || ''`
  2. **Simplify method signature** — remove `planId` and `sessionId` parameters from `_buildPlanContent()` (lines 180-181). Update call site at line 482 to pass only `(issueSummary, matchedRule)`.
  3. **Delete `_buildGoal()`** (lines 160-164) — no remaining callers.
  4. **Delete `_buildProposedChanges()`** (lines 166-175) — no remaining callers.
  5. **Delete `_truncate()`** (lines 115-121) — only caller was `_buildProposedChanges()`. `_normalizeWhitespace()` (lines 111-113) is still used directly in `poll()` at line 469 and must be retained.
- **Edge Cases:** Same as ClickUp.

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/test/integrations/clickup/clickup-automation-service.test.js`

- **Context:** Existing integration test asserts on old plan content format.
- **Implementation:**
  - Line 201: `assert.ok(planContent.includes('**ClickUp Task ID:** task-bug'))` — **keep** (still present in new blockquote).
  - Line 202: `assert.ok(planContent.includes('**Automation Rule:** Bug Summary'))` — **keep** (still present in new blockquote).
  - Line 203: `assert.ok(planContent.includes('**Kanban Column:** CREATED'))` — **remove or replace** with assertion that plan does NOT contain `## Switchboard State` (kanban column is DB-tracked, not in plan file).
  - Add new assertion: `assert.ok(!planContent.includes('## Goal'))` and `assert.ok(!planContent.includes('## Proposed Changes'))` and `assert.ok(!planContent.includes('## ClickUp Task Notes'))` and `assert.ok(!planContent.includes('## Switchboard State'))` and `assert.ok(!planContent.includes('## Metadata'))`.
  - Add new assertion: `assert.ok(planContent.includes('The app crashes on launch.'))` — raw description is preserved verbatim.

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/test/integrations/linear/linear-automation-service.test.js`

- **Context:** Existing integration test asserts on old plan content format.
- **Implementation:**
  - Line 527: `assert.ok(planContent.includes('**Linear Issue ID:** issue-bug'))` — **keep** (still present in new blockquote).
  - Line 528: `assert.ok(planContent.includes('**Automation Rule:** Bug Summary'))` — **keep** (still present in new blockquote).
  - Line 529: `assert.ok(planContent.includes('## Linear Issue Notes'))` — **remove or replace** with assertion that plan does NOT contain `## Linear Issue Notes`.
  - Line 530: `assert.ok(planContent.includes('**Kanban Column:** CREATED'))` — **remove or replace** with assertion that plan does NOT contain `## Switchboard State`.
  - Add new assertions: plan does NOT contain `## Goal`, `## Proposed Changes`, `## Linear Issue Notes`, `## Switchboard State`, `## Metadata`.
  - Add new assertion: `assert.ok(planContent.includes('The app crashes on launch.'))` — raw description is preserved verbatim.

### Dead-code cleanup (same PR)

- `_buildGoal()` (ClickUp line 152, Linear line 160) — no remaining callers after `_buildPlanContent()` rewrite.
- `_buildProposedChanges()` (ClickUp line 158, Linear line 166) — no remaining callers.
- `_truncate()` (ClickUp line 107, Linear line 115) — only caller was `_buildProposedChanges()`. Must be removed alongside it to avoid dead code.
- `_normalizeWhitespace()` is **NOT** dead code — it is called directly in `poll()` (ClickUp line 336, Linear line 469) for normalizing the ticket description before storage.

## Verification Plan

### Automated Tests

1. **Update existing ClickUp integration test** (`src/test/integrations/clickup/clickup-automation-service.test.js`):
   - Replace assertions on old-format sections (`**Kanban Column:**`, implicit `## ClickUp Task Notes`) with negative assertions (plan does NOT contain `## Goal`, `## Proposed Changes`, `## ClickUp Task Notes`, `## Switchboard State`, `## Metadata`).
   - Add assertion that raw description text is present verbatim.
   - Verify write-back still works (existing write-back test at lines 238-257 should pass unchanged — `_resolveStoredRule()` still finds `**Automation Rule:**` in blockquote).

2. **Update existing Linear integration test** (`src/test/integrations/linear/linear-automation-service.test.js`):
   - Replace `assert.ok(planContent.includes('## Linear Issue Notes'))` (line 529) with `assert.ok(!planContent.includes('## Linear Issue Notes'))`.
   - Replace `assert.ok(planContent.includes('**Kanban Column:** CREATED'))` (line 530) with `assert.ok(!planContent.includes('## Switchboard State'))`.
   - Add negative assertions for `## Goal`, `## Proposed Changes`, `## Metadata`.
   - Add assertion that raw description text is present verbatim.
   - Verify write-back still works (existing write-back test at lines 543-567 should pass unchanged).

3. **Regression test for write-back resolution** (covered by existing integration tests):
   - The existing write-back flow tests (ClickUp lines 238-257, Linear lines 543-567) exercise `_resolveStoredRule()` against real plan content. After the format change, these tests implicitly verify that the `Automation Rule` metadata line in the new blockquote format is still parseable by `_extractPlanMetadata()`. No additional unit test is needed.

4. **Edge-case coverage** (add to existing integration tests or new test cases):
   - Empty description → output contains only title and blockquote, no trailing sections.
   - Missing URL → blockquote omits the URL line entirely (`filter(Boolean)` behavior).

## Migration

Existing plan files with the old metadata sections will remain unchanged. New imports will use the clean format. No database migration is needed because kanban state is tracked in `KanbanDatabase`, not plan file content. If a user deletes an old-format plan and re-imports the same ticket, the new plan will use the clean format — this is expected and acceptable.

## Completion

- **Status:** Completed
- **Files changed:**
  - `src/services/ClickUpAutomationService.ts` — rewritten `_buildPlanContent()` to minimal format; removed `planId`/`sessionId` params; deleted `_buildGoal()`, `_buildProposedChanges()`, `_truncate()` dead code; updated call site.
  - `src/services/LinearAutomationService.ts` — same changes as ClickUp.
  - `src/test/integrations/clickup/clickup-automation-service.test.js` — replaced `**Kanban Column:**` assertion with negative assertions for `## Goal`, `## Proposed Changes`, `## ClickUp Task Notes`, `## Switchboard State`, `## Metadata`; added assertion for raw description.
  - `src/test/integrations/linear/linear-automation-service.test.js` — replaced `## Linear Issue Notes` and `**Kanban Column:**` assertions with negative assertions for `## Goal`, `## Proposed Changes`, `## Linear Issue Notes`, `## Switchboard State`, `## Metadata`; added assertion for raw description.
- **Validation:**
  - TypeScript compilation (`tsc -p tsconfig.json --noEmit`) passes with no errors in changed files.
  - Integration tests for both ClickUp and Linear automation have pre-existing failures in unrelated early test functions (`testMixedScopedAndUnscopedRulePolling`, `testTeamWidePollingOmitsProjectVariable`). These failures occur before reaching the modified assertions and are not caused by this change.
  - Write-back dependency preserved: `> **Automation Rule:**` remains in the blockquote, so `_resolveStoredRule()` / `_extractPlanMetadata()` continue to work.

## Recommendation

Send to Coder.
