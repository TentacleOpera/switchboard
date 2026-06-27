# Fix: Epic Files Have No Content — Improve Epic Generation Prompt

## Goal

Epic files created by `createEpicFromPlanIds` contain almost no content — just a YAML frontmatter description, an H1 title, and a one-line description. They lack a meaningful description of what the epic is about, why the plans are grouped together, and how each subtask contributes to the epic's goal. The orchestrator agent opening an epic file has no idea what the epic is or what needs to be done.

### Root Cause

Two problems:

1. **The suggest-epics prompt doesn't instruct the agent to write epic descriptions.** The `_buildSuggestEpicsPrompt` method (line 8797) tells the agent to propose epics with "epic name, member plans with planId and one-line summary" (line 8828) — but doesn't ask for a Goal statement or per-subtask narrative. The `create-epic.js` call at line 8839 only passes the epic name and plan IDs, not a description. The script already accepts a description as the 4th positional argument (line 26: `process.argv[5]`) and the API endpoint passes it through (`LocalApiServer.ts` line 304 → `createEpicFromPlanIds` 4th param) — the plumbing exists, the prompt just doesn't use it.

2. **The epic file content template is a bare stub.** `createEpicFromPlanIds` (line 8624) writes only:
```typescript
const epicDesc = (description ? String(description).replace(/[\r\n]+/g, ' ').trim() : '');
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n${epicDesc}`;
```
(lines 8717–8718). Even when a description IS passed, it's a single line with no structure. The `_regenerateEpicFile` method appends subtask links but no summaries.

### What the Epic File Should Contain

The epic file should follow this structure (matching the hand-written epics in the current board):

```markdown
---
description: 'Epic Name'
---

# Epic Name

## Goal

<Full problem statement — what's broken today, what the epic solves, why these plans are grouped together. 2-4 sentences.>

## How the Subtasks Achieve This

- **Subtask Plan Name**: <What this plan does and how it contributes to the epic's goal. 1-2 sentences.>
- **Subtask Plan Name**: <What this plan does and how it contributes to the epic's goal. 1-2 sentences.>

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Subtask Name](../plans/plan-file.md)
<!-- END SUBTASKS -->
```

The `## Goal` and `## How the Subtasks Achieve This` sections are written by the agent at proposal time — they require understanding what each subtask does and how it relates to the epic's theme. The code can't generate these automatically; the prompt must instruct the agent to write them.

## Metadata

**Complexity:** 3
**Tags:** bugfix, feature, backend

## User Review Required

Yes — the prompt-text changes and the epic-file template change should be reviewed before implementation to confirm the desired epic-file structure matches the team's hand-written epics. No database migrations or breaking changes are involved.

## Complexity Audit

### Routine
- Editing prompt text in `_buildSuggestEpicsPrompt` (string array, no logic change)
- Editing the `epicContent` template string in `createEpicFromPlanIds` (2-line change)
- Verifying `_regenerateEpicFile` already preserves content outside the subtask markers (read-only confirmation — no code change needed)
- The description plumbing (create-epic.js → LocalApiServer → createEpicFromPlanIds) already exists and is confirmed working

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `createEpicFromPlanIds` writes the epic file (line 8723) then immediately calls `_regenerateEpicFile` (line 8729), which reads the just-written file. The `registerPendingCreation` call before `writeFile` (line 8722) ensures the file watcher skips this file. No concurrent-writer risk introduced by this change.
- **Security:** The description is stripped of newlines (`replace(/[\r\n]+/g, ' ')`, line 8717) before being inserted into the file, preventing YAML/frontmatter injection. The `yamlSafeName` already escapes single quotes (line 8716). The description is placed under a `## Goal` heading in the markdown body (not in frontmatter), so even if it contained `---` it cannot break the frontmatter block.
- **Side Effects:** The template change affects BOTH the webview `createEpic` path (line 8070, passes `msg.description`) and the agent/API path (TaskViewerProvider line 940 → `createEpicFromPlanIds`). When no description is passed (e.g. webview UI doesn't collect one), `epicDesc` is empty and the `## Goal` section is omitted — the file degrades gracefully to just H1 + subtask block, identical to today's behavior.
- **Dependencies & Conflicts:** None. No new dependencies. The create-epic.js script already accepts the description arg (line 26); no script change required.

## Dependencies

None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) stale line numbers in the original plan would have led an implementer to edit the wrong lines — corrected to actual values after re-reading the source; (2) the manual agent step of writing `## How the Subtasks Achieve This` into the file is fragile and unvalidated — if the agent skips it, the epic file has a Goal but no subtask narrative; (3) shell-quoting of the description in the bash command can break if the goal text contains double quotes, `$`, or backticks. Mitigations: line numbers corrected to actual values; the prompt now explicitly instructs the agent to escape double quotes and avoid `$`/backticks in the description arg (or rephrase to avoid them); the manual write step is kept because the structural separation (Goal via script, How-Subtasks via manual edit) is intentional and `_regenerateEpicFile` preserves it on subsequent regenerations.

## Proposed Changes

### `src/services/KanbanProvider.ts` — `_buildSuggestEpicsPrompt` (line 8797)

**Update the prompt to instruct the agent to write epic descriptions and pass them to create-epic.js.**

The current step 3 (PROPOSE, lines 8823–8829) says:
```
For each proposed epic: epic name, member plans with planId and one-line summary.
```

The current step 5 (EXECUTE, lines 8836–8840) says:
```
node .agents/skills/kanban_operations/create-epic.js "<epic name>" '["planId1","planId2",...]' "${workspaceRoot}"
```

Both need to change:

```typescript
// Step 3 — PROPOSE (lines 8823–8829):
// Before:
'3. PROPOSE (single message, all groups at once)',
'   Group by underlying capability theme, not by surface keyword.',
'   Cross-provider plans that address the same capability go into one epic.',
'   Minimum 2 plans per epic. Single-plan "groups" go in the Standalone section.',
'   Flag POSSIBLE OVERLAP / REDUNDANCY / GAP where detected.',
'   For each proposed epic: epic name, member plans with planId and one-line summary.',
'   List genuinely standalone plans separately. Then stop and wait.',

// After:
'3. PROPOSE (single message, all groups at once)',
'   Group by underlying capability theme, not by surface keyword.',
'   Cross-provider plans that address the same capability go into one epic.',
'   Minimum 2 plans per epic. Single-plan "groups" go in the Standalone section.',
'   Flag POSSIBLE OVERLAP / REDUNDANCY / GAP where detected.',
'   For each proposed epic, write:',
'     - Epic name',
'     - Goal: 2-4 sentences describing what the epic achieves, what problem it',
'       solves, and why these plans are grouped together.',
'     - How the Subtasks Achieve This: one bullet per member plan explaining what',
'       it does and how it contributes to the epic\'s goal. Format:',
'         - **Plan Name**: <what it does and how it contributes>',
'     - Member plans with planId and one-line summary',
'   List genuinely standalone plans separately. Then stop and wait.',
```

```typescript
// Step 5 — EXECUTE (lines 8836–8840):
// Before:
'5. EXECUTE',
'   For each approved group:',
'   ```bash',
`   node .agents/skills/kanban_operations/create-epic.js "<epic name>" '["planId1","planId2",...]' "${workspaceRoot}"`,
'   ```',

// After:
'5. EXECUTE',
'   For each approved group, pass the Goal text as the description argument.',
'   Escape any double quotes in the Goal text (replace " with \") or rephrase to',
'   avoid them, so the bash command does not break. Also avoid $ and backticks',
'   in the Goal text — these are shell metacharacters inside double quotes.',
'   ```bash',
`   node .agents/skills/kanban_operations/create-epic.js "<epic name>" '["planId1","planId2",...]' "${workspaceRoot}" "<goal text with escaped quotes>"`,
'   ```',
'   The description becomes the ## Goal section in the epic file.',
'   After all epics are created, write the ## How the Subtasks Achieve This section',
'   into each epic file manually (the create-epic script only writes the Goal).',
'   Use the text from your step 3 proposal — paste it between the Goal and the',
'   <!-- BEGIN SUBTASKS --> marker. This section is preserved by _regenerateEpicFile',
'   on subsequent subtask changes, so it only needs to be written once.',
```

### `src/services/KanbanProvider.ts` — `createEpicFromPlanIds` epic template (lines 8717–8718)

**Improve the epic file template to use the description as a proper Goal section:**

```typescript
// Before (lines 8717–8718):
const epicDesc = (description ? String(description).replace(/[\r\n]+/g, ' ').trim() : '');
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n${epicDesc}`;

// After:
const epicDesc = (description ? String(description).replace(/[\r\n]+/g, ' ').trim() : '');
const goalSection = epicDesc ? `## Goal\n\n${epicDesc}\n` : '';
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n${goalSection}`;
```

This puts the description under a `## Goal` heading instead of as a bare paragraph after the H1. If no description is passed, the file has just the H1 and the auto-generated subtask section (identical to today's behavior). The subsequent `_regenerateEpicFile` call (line 8729) appends the subtask block after the Goal section — since there are no BEGIN/END SUBTASKS markers yet, it takes the else branch (line 8607) and appends `\n\n` + subtask section, producing the correct final structure.

### `src/services/KanbanProvider.ts` — `_regenerateEpicFile` (line 8584)

**No change needed.** The current implementation (lines 8600–8609) already preserves all content outside the `<!-- BEGIN SUBTASKS -->` / `<!-- END SUBTASKS -->` markers by slicing on the marker indices (line 8606). This means the `## Goal` and `## How the Subtasks Achieve This` sections written by the agent will survive every subsequent subtask regeneration. Confirmed by reading the actual code — do NOT apply the conditional code block from the original plan draft; it would be a no-op at best and a regression risk at worst.

## Verification Plan

### Automated Tests
(SKIP — per session directive, automated tests are run separately by the user.)

### Manual Verification
- Click "Suggest Epics" on the board → the copied prompt must instruct the agent to write Goal and How-Subtasks-Achieve-This text for each proposed epic
- Agent proposes epics → each proposal must include a Goal statement and per-subtask narrative bullets
- Agent executes create-epic.js with the description argument → epic file must contain `## Goal` section with the passed text
- Agent writes the How-Subtasks-Achieve-This section into the file → file must have both `## Goal` and `## How the Subtasks Achieve This` sections
- Move a subtask to a different column → `_regenerateEpicFile` must NOT clobber the Goal or How-Subtasks-Achieve-This sections (only the subtask block between the markers should be updated) — this is already the case and requires no code change
- Create an epic via the webview UI without a description → epic file must degrade gracefully to H1 + subtask block only (no empty `## Goal` heading)

## Recommendation

Complexity 3 → **Send to Coder**.
