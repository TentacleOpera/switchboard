---
created: 2026-05-28T09:09:00.000Z
kanbanColumn: CREATED
---

# Fix Literal Import: Remove Template Headings from ClickUp/Linear Task Imports

## Goal
Prevent `_createInitiatedPlan` from appending template headings (Goal, Proposed Changes, Verification Plan, Open Questions) when importing ClickUp or Linear tasks, so that imported plan content is a literal representation of the source task.

## Metadata
- **Tags:** [bugfix, backend]
- **Complexity:** 3

## User Review Required
- Confirm that clipboard/bulk import should continue adding template headings (current behavior is intentional for user-authored content).
- Confirm the flag name `skipTemplateHeadings` is acceptable (alternative: `treatAsFullPlan`).

## Complexity Audit

### Routine
- Adding one optional boolean property to an existing options object (backward-compatible, no breaking change)
- Modifying a single conditional expression to OR in the new flag
- Passing the flag at three existing call sites (Linear import, ClickUp parent, ClickUp subtask)
- All changes are in a single file (`TaskViewerProvider.ts`)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `_createInitiatedPlan` is called synchronously per import; no concurrent state mutation.
- **Security:** No security implications. The flag only controls whether template text is appended to a locally-written file.
- **Side Effects:** None. The flag is opt-in and defaults to `false`, preserving all existing behavior for callers that don't pass it.
- **Dependencies & Conflicts:** No other files or services depend on the template headings being present in imported plans. The `_buildDraftPlanContent` method (line 15043) already includes `## Goal` and `## Proposed Changes` in its output, so the `isFullPlan` heuristic correctly skips template headings for draft plans — no conflict.

## Dependencies
- None

## Adversarial Synthesis
Key risks: the underlying `isFullPlan` heuristic (string-contains check) remains fragile for any future caller not using the flag; clipboard/bulk import paths could produce the same bug for non-plan content. Mitigations: the flag explicitly covers the reported import paths; clipboard/bulk import behavior is intentional (template headings are desirable scaffolding for user-authored content); the heuristic can be refactored separately if needed.

## Problem
When clicking "Import Task" for ClickUp or Linear tasks in `implementation.html`, the import adds useless template headings (Goal, Proposed Changes, Verification Plan, Open Questions) to the bottom of the plan. This has been reported 5 times and is still not fixed. The import must be LITERAL with NO additional data added.

## Root Cause
In `src/services/TaskViewerProvider.ts`, the `_createInitiatedPlan` method (lines 15264-15306) checks if the content is a "full plan" by looking for `## Proposed Changes` or `## Goal` headings:

```typescript
const isFullPlan = idea.includes('## Proposed Changes') || idea.includes('## Goal');
const content = isFullPlan
    ? idea
    : `# ${title}\n\n${headerText}${idea}\n\n## Goal\n- Clarify expected outcome and scope.\n\n## Proposed Changes\n- TODO\n\n## Verification Plan\n- TODO\n\n## Open Questions\n- TODO\n`;
```

The Linear and ClickUp import content builders (`_buildLinearImportPlanContent` at line 3981 and `_buildClickUpImportPlanContent` at line 4239) return content with only:
- YAML frontmatter
- Title (H1)
- Metadata block (import source, IDs, URLs, etc.)
- Task description

Since this content doesn't include `## Proposed Changes` or `## Goal`, it's treated as NOT a full plan, and the template headings are appended.

## Proposed Changes

### File: `src/services/TaskViewerProvider.ts`

#### Change 1: Add a flag to `_createInitiatedPlan` to skip template headings

Add an optional `skipTemplateHeadings` parameter to the method signature (line 15268-15272):

```typescript
private async _createInitiatedPlan(
    title: string,
    idea: string,
    isAirlock: boolean,
    options: {
        skipBrainPromotion?: boolean;
        suppressIntegrationSync?: boolean;
        createdAt?: string;
        skipTemplateHeadings?: boolean;  // NEW
    } = {}
): Promise<{ planFileAbsolute: string; }>
```

- **Context:** The options object already exists with optional properties; adding another is backward-compatible.
- **Logic:** When `skipTemplateHeadings` is true, treat the content as complete regardless of the `isFullPlan` heuristic.
- **Edge Cases:** Default is `undefined` (falsy), so all existing callers continue to behave identically.

#### Change 2: Update the content building logic to respect the flag

Modify the content building logic (line 15291-15295):

```typescript
const isFullPlan = idea.includes('## Proposed Changes') || idea.includes('## Goal');
const headerText = isAirlock ? '## Notebook Plan\n\n' : '';
const content = (isFullPlan || options.skipTemplateHeadings)
    ? idea
    : `# ${title}\n\n${headerText}${idea}\n\n## Goal\n- Clarify expected outcome and scope.\n\n## Proposed Changes\n- TODO\n\n## Verification Plan\n- TODO\n\n## Open Questions\n- TODO\n`;
```

- **Context:** The `headerText` variable is computed but unused when `skipTemplateHeadings` is true (and `isAirlock` is false for all import paths). This is harmless dead code.
- **Logic:** The OR condition means the flag overrides the heuristic. When `skipTemplateHeadings` is true, the raw `idea` string is written verbatim — no title prefix, no header text, no template headings.
- **Implementation:** Single-line change to the ternary condition.
- **Edge Cases:** If both `isFullPlan` and `skipTemplateHeadings` are true, the result is the same (`idea` is used as-is). No conflict.

#### Change 3: Pass the flag when importing Linear tasks

Update the call in `_createImportedLinearPlan` (line 4025-4034):

```typescript
const { planFileAbsolute } = await this._createInitiatedPlan(
    node.issue.title || this._describeLinearIssue(node.issue),
    this._buildLinearImportPlanContent(node, parentIssue, createdAt),
    false,
    {
        skipBrainPromotion: true,
        createdAt,
        suppressIntegrationSync: true,
        skipTemplateHeadings: true  // NEW
    }
);
```

- **Context:** This is the only call site for Linear import. The content from `_buildLinearImportPlanContent` already includes YAML frontmatter, title, metadata, and description — it should be written as-is.
- **Edge Cases:** If a Linear issue description happens to contain `## Goal` or `## Proposed Changes`, the `isFullPlan` heuristic would already skip template headings. The flag makes this moot by always skipping for imports.

#### Change 4: Pass the flag when importing ClickUp tasks

Update the call in `importClickUpTask` for the parent task (line 4171-4180):

```typescript
const { planFileAbsolute: rootPlanFile } = await this._createInitiatedPlan(
    task.name || `ClickUp Task ${task.id}`,
    planContent,
    false,
    {
        skipBrainPromotion: true,
        suppressIntegrationSync: true,
        createdAt,
        skipTemplateHeadings: true  // NEW
    }
);
```

Update the call for subtasks (line 4191-4196):

```typescript
const { planFileAbsolute: subtaskPlanFile } = await this._createInitiatedPlan(
    subtask.name || `ClickUp Subtask ${subtask.id}`,
    subtaskContent,
    false,
    { 
        skipBrainPromotion: true, 
        suppressIntegrationSync: true, 
        createdAt: subtaskCreatedAt,
        skipTemplateHeadings: true  // NEW
    }
);
```

- **Context:** Both parent and subtask imports use `_buildClickUpImportPlanContent` which produces complete content with frontmatter, title, metadata, and description.
- **Edge Cases:** Same as Linear — the flag makes the `isFullPlan` heuristic irrelevant for import paths.

#### Other callers (NO CHANGE REQUIRED)

The following callers should continue using default behavior (template headings added when content lacks `## Goal`/`## Proposed Changes`):

- **Line 15085** (`_createNewDraftPlan`): Calls `_buildDraftPlanContent` which already includes `## Goal` and `## Proposed Changes` — the `isFullPlan` check is true, so template headings are never appended. No change needed.
- **Line 15149** (`importPlanFromClipboard`): User-authored clipboard content — template headings are desirable scaffolding. No change needed.
- **Line 15239** (bulk plan import): Imported plans with pre-existing content — template headings are desirable scaffolding if content is incomplete. No change needed.

## Verification Plan

### Automated Tests
- SKIP: Per session directive, automated tests are not run as part of this verification plan.

### Manual Verification

1. **Manual Test - Linear Import**
   - Open implementation.html
   - Navigate to Linear tab
   - Select a Linear issue
   - Click "IMPORT TASK" button
   - Verify the created plan contains ONLY:
     - YAML frontmatter
     - Title (H1)
     - Metadata block (import source, IDs, URLs, etc.)
     - Task description
   - Verify NO "Goal", "Proposed Changes", "Verification Plan", or "Open Questions" headings are present

2. **Manual Test - ClickUp Import**
   - Open implementation.html
   - Navigate to ClickUp tab
   - Select a ClickUp task
   - Click "IMPORT TASK" button
   - Verify the created plan contains ONLY:
     - YAML frontmatter
     - Title (H1)
     - Metadata block (import source, IDs, URLs, etc.)
     - Task description
   - Verify NO "Goal", "Proposed Changes", "Verification Plan", or "Open Questions" headings are present

3. **Regression Test - Draft Plan Creation**
   - Create a new draft plan via the UI
   - Verify it still includes the template headings (Goal, Proposed Changes, etc.)
   - This ensures the change doesn't break normal plan creation

4. **Regression Test - Clipboard Import**
   - Import a plan from clipboard that doesn't have template headings
   - Verify template headings are still added (existing behavior preserved)

## Open Questions
None

## Recommendation
Complexity 3 → **Send to Intern**

---
## Direct Reviewer Pass

### Stage 1: Grumpy Review (Adversarial Findings)
*I've looked at the changes. They match the plan perfectly. You actually managed to add a boolean flag and plumb it through the options object without breaking the entire type system or duplicating a 500-line method. I guess adding `skipTemplateHeadings` to `_createInitiatedPlan` and hooking it up to `_createImportedLinearPlan` and `importClickUpTask` is exactly what I asked for. The ternary logic is clean, and the default behavior remains untouched for the clipboard imports.*

- **NIT**: I don't love the name `skipTemplateHeadings`—it's a bit wordy, but it explicitly tells me what it does. I can live with it.

### Stage 2: Balanced Synthesis
The implementation aligns flawlessly with the proposed plan. The new optional `skipTemplateHeadings` property was correctly added to the `options` parameter of `_createInitiatedPlan`, and the fallback template string logic now uses an OR condition (`isFullPlan || options.skipTemplateHeadings`) to skip the appending of template headings. The three necessary call sites (Linear import, ClickUp parent task import, and ClickUp subtask import) were successfully updated to pass this flag as `true`. No other callers were modified, preserving existing functionality where template headings are still required. 

No material code fixes are needed.

### Execution & Validation
- **Files Changed**: `src/services/TaskViewerProvider.ts`
- **Validation**: Static analysis confirmed the proper logic and TypeScript types. Compilation and automated tests were skipped per the session directive. 
- **Remaining Risks**: None identified. The fallback heuristic remains in place securely for un-flagged callers.
