# Fix: Epic Files Have No Content — Improve Epic Generation Prompt

## Goal

Epic files created by `createEpicFromPlanIds` contain almost no content — just a YAML frontmatter description, an H1 title, and a one-line description. They lack a meaningful description of what the epic is about, why the plans are grouped together, and a list of subtasks with context. The orchestrator agent opening an epic file has no idea what the epic is or what needs to be done.

### Root Cause

`createEpicFromPlanIds` in `KanbanProvider.ts` (line 8536) generates the epic file content as:

```typescript
const epicDesc = (description ? String(description).replace(/[\r\n]+/g, ' ').trim() : '');
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n${epicDesc}`;
```

This is a bare-minimum stub. The `description` parameter is the one-line description passed by the caller (e.g., "Making epic parent/child relationships work round-trip across Linear, ClickUp, and Notion"). No subtask information, no goal statement, no context about why these plans are grouped, and no subtask list is included in the initial file write.

The `_regenerateEpicFile` method (line 8403) does append a `## Subtasks` section with checkbox links, but it only runs AFTER the initial file write, and it only includes subtask names and file links — no summaries of what each subtask does.

The result is an epic file that looks like:

```markdown
---
description: 'Cross-Provider Epic Structure (Import, Sync, Mirroring)'
---

# Cross-Provider Epic Structure (Import, Sync, Mirroring)

Making epic parent/child relationships work round-trip across Linear, ClickUp, and Notion

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Plan: Linear Import — Parent-with-Subtasks Always Becomes Epic](../plans/linear-import-epic-linking.md)
...
<!-- END SUBTASKS -->
```

This is useless to an orchestrator agent. It needs a description of the epic's purpose, the capability it represents, and a list of subtasks with one-line summaries of what each does.

## Metadata

**Complexity:** 4
**Tags:** feature, backend, kanban, epic, agent-prompt

## Files to Modify

### 1. `src/services/KanbanProvider.ts`

**a. Enrich the initial epic file content** (line 8536) — include a goal section, a subtask summary table, and the subtask links:

```typescript
// Before (line 8536):
const epicDesc = (description ? String(description).replace(/[\r\n]+/g, ' ').trim() : '');
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n${epicDesc}`;

// After:
const epicDesc = (description ? String(description).replace(/[\r\n]+/g, ' ').trim() : '');

// Build subtask summary table for the initial content
const subtaskSummaryRows = subtasks.map(st => {
    const basename = path.basename(st.planFile);
    const topic = st.topic || basename;
    const complexity = st.complexity || 'Unknown';
    const column = st.kanbanColumn || 'CREATED';
    return `| ${topic} | ${complexity} | ${column} | [plan](../plans/${basename}) |`;
}).join('\n');

const subtaskSummaryTable = subtasks.length > 0
    ? `## Subtask Summary\n\n| Plan | Complexity | Column | Link |\n|------|-----------|--------|------|\n${subtaskSummaryRows}\n`
    : '';

const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n## Goal\n\n${epicDesc}\n\n${subtaskSummaryTable}`;
```

**b. Enrich `_regenerateEpicFile`** (line 8403) — include subtask complexity and column in the subtask links:

```typescript
// Before (line 8412-8416):
const subtaskLines = subtasks.map(st => {
    const basename = path.basename(st.planFile);
    const topic = st.topic || basename;
    return `- [ ] [${topic}](../plans/${basename})`;
});

// After:
const subtaskLines = subtasks.map(st => {
    const basename = path.basename(st.planFile);
    const topic = st.topic || basename;
    const complexity = st.complexity || 'Unknown';
    const column = st.kanbanColumn || 'CREATED';
    return `- [ ] [${topic}](../plans/${basename}) — ${complexity} · ${column}`;
});
```

**c. Add a `## Context` section placeholder** — after the goal, add a prompt for the orchestrator to fill in or read:

```typescript
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n## Goal\n\n${epicDesc}\n\n## Context\n\nThis epic groups ${subtasks.length} plan(s) that share a common capability. See the subtask summary below for what each plan covers.\n\n${subtaskSummaryTable}`;
```

### 2. `src/services/KanbanProvider.ts` — `buildEpicOrchestrationPrompt`

**Enrich the orchestrator prompt** — the `buildEpicOrchestrationPrompt` method (line 3114) already reads the epic file and appends subtask plans. Ensure the prompt includes the subtask summary table and column status so the orchestrator knows what needs to be done:

```typescript
// After line 3128 (after fetching subtasks):
const subtaskStatusLines = subtasks.map(st => {
    return `- ${st.topic} — ${st.complexity || 'Unknown'} · ${st.kanbanColumn || 'CREATED'}`;
}).join('\n');

// Add to the prompt plans or as a preamble:
const statusSummary = `\n## Subtask Status\n\n${subtaskStatusLines}\n`;
```

## Verification

- Create an epic via `create-epic.js` with a description and 3 subtask plans
- Open the epic file — it must contain:
  - YAML frontmatter with description
  - H1 title
  - `## Goal` section with the description text
  - `## Context` section explaining the grouping
  - `## Subtask Summary` table with plan name, complexity, column, and link for each subtask
  - `## Subtasks` section (auto-generated) with checkbox links including complexity and column
- The subtask summary table must have the correct plan names, complexity values, and current columns
- After moving a subtask to a different column and regenerating the epic file, the table and subtask links must reflect the new column
