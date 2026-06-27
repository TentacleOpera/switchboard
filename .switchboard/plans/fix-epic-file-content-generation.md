# Fix: Epic Files Have No Content — Improve Epic Generation Prompt

## Goal

Epic files created by `createEpicFromPlanIds` contain almost no content — just a YAML frontmatter description, an H1 title, and a one-line description. They lack a meaningful description of what the epic is about, why the plans are grouped together, and how each subtask contributes to the epic's goal. The orchestrator agent opening an epic file has no idea what the epic is or what needs to be done.

### Root Cause

Two problems:

1. **The suggest-epics prompt doesn't instruct the agent to write epic descriptions.** The `_buildSuggestEpicsPrompt` method (line 8615) tells the agent to propose epics with "epic name, member plans with planId and one-line summary" (line 8646) — but doesn't ask for a Goal statement or per-subtask narrative. The `create-epic.js` call at line 8657 only passes the epic name and plan IDs, not a description. The script already accepts a description as the 4th argument (line 26) and the API endpoint passes it through — the plumbing exists, the prompt just doesn't use it.

2. **The epic file content template is a bare stub.** `createEpicFromPlanIds` (line 8536) writes only:
```typescript
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n${epicDesc}`;
```
Even when a description IS passed, it's a single line with no structure. The `_regenerateEpicFile` method appends subtask links but no summaries.

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
**Tags:** feature, backend, kanban, epic, agent-prompt

## Files to Modify

### 1. `src/services/KanbanProvider.ts` — `_buildSuggestEpicsPrompt` (line 8615)

**Update the prompt to instruct the agent to write epic descriptions and pass them to create-epic.js.**

The current step 3 (PROPOSE) says:
```
For each proposed epic: epic name, member plans with planId and one-line summary.
```

The current step 5 (EXECUTE) says:
```
node .agents/skills/kanban_operations/create-epic.js "<epic name>" '["planId1","planId2",...]' "${workspaceRoot}"
```

Both need to change:

```typescript
// Step 3 — PROPOSE (line 8641-8647):
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
// Step 5 — EXECUTE (line 8654-8658):
// Before:
'5. EXECUTE',
'   For each approved group:',
'   ```bash',
`   node .agents/skills/kanban_operations/create-epic.js "<epic name>" '["planId1","planId2",...]' "${workspaceRoot}"`,
'   ```',

// After:
'5. EXECUTE',
'   For each approved group, pass the Goal text as the description argument:',
'   ```bash',
`   node .agents/skills/kanban_operations/create-epic.js "<epic name>" '["planId1","planId2",...]' "${workspaceRoot}" "<goal text>"`,
'   ```',
'   The description becomes the ## Goal section in the epic file.',
'   After all epics are created, write the ## How the Subtasks Achieve This section',
'   into each epic file manually (the create-epic script only writes the Goal).',
'   Use the text from your step 3 proposal — paste it between the Goal and the',
'   <!-- BEGIN SUBTASKS --> marker.',
```

### 2. `src/services/KanbanProvider.ts` — `createEpicFromPlanIds` (line 8536)

**Improve the epic file template to use the description as a proper Goal section:**

```typescript
// Before (line 8536):
const epicDesc = (description ? String(description).replace(/[\r\n]+/g, ' ').trim() : '');
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n${epicDesc}`;

// After:
const epicDesc = (description ? String(description).replace(/[\r\n]+/g, ' ').trim() : '');
const goalSection = epicDesc ? `## Goal\n\n${epicDesc}\n` : '';
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n${goalSection}`;
```

This puts the description under a `## Goal` heading instead of as a bare paragraph after the H1. If no description is passed, the file has just the H1 and the auto-generated subtask section.

### 3. `src/services/KanbanProvider.ts` — `_regenerateEpicFile` (line 8403)

**Preserve the `## How the Subtasks Achieve This` section during regeneration.**

`_regenerateEpicFile` rewrites the epic file on every subtask change. It must NOT clobber the `## Goal` or `## How the Subtasks Achieve This` sections — only the `<!-- BEGIN SUBTASKS -->` block should be replaced.

Check the current implementation — if it already preserves content outside the subtask block (by splitting on the markers), no change needed. If it rewrites the whole file, fix it to only replace the subtask block:

```typescript
// If _regenerateEpicFile rewrites the whole file, change it to:
const beginMarker = '<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->';
const endMarker = '<!-- END SUBTASKS -->';
const beginIdx = existingContent.indexOf(beginMarker);
const endIdx = existingContent.indexOf(endMarker);
if (beginIdx !== -1 && endIdx !== -1) {
    // Replace only the subtask block, preserve everything else
    const before = existingContent.slice(0, beginIdx);
    const after = existingContent.slice(endIdx + endMarker.length);
    const newContent = before + newSubtaskBlock + after;
} else {
    // No existing subtask block — append it
    const newContent = existingContent + '\n' + newSubtaskBlock;
}
```

## Verification

- Click "Suggest Epics" on the board → the copied prompt must instruct the agent to write Goal and How-Subtasks-Achieve-This text for each proposed epic
- Agent proposes epics → each proposal must include a Goal statement and per-subtask narrative bullets
- Agent executes create-epic.js with the description argument → epic file must contain `## Goal` section with the passed text
- Agent writes the How-Subtasks-Achieve-This section into the file → file must have both `## Goal` and `## How the Subtasks Achieve This` sections
- Move a subtask to a different column → `_regenerateEpicFile` must NOT clobber the Goal or How-Subtasks-Achieve-This sections (only the subtask block between the markers should be updated)
