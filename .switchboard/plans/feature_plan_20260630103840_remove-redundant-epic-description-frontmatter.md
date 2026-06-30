# Remove Redundant `description` Frontmatter from Epic Files

## Goal

### Problem
Epic files (e.g. `.switchboard/epics/tickets-tab-improvements-68d315df-ed86-4637-9eb9-43bfc32d4b41.md`) are written with a YAML frontmatter block whose `description` key is set to the **epic name** — the exact same string that appears as the `# H1` heading two lines later:

```markdown
---
description: 'Tickets tab improvements'
---

# Tickets tab improvements
```

This is confusing and serves no purpose: the frontmatter `description` is a verbatim repeat of the H1, not the user-supplied description. The actual description (when provided) is correctly placed in the markdown body under `## Goal`, never in the frontmatter.

### Root Cause
There are **two** epic-creation code paths, and both share the same bug — they write `description: '${yamlSafeName}'` (the *name*, not the *description*) into the frontmatter:

1. **`src/services/KanbanProvider.ts:8548`** — `createEpicFromPlanIds` (the authoritative path used by the webview, the `/kanban/epic` API, and `create-epic.js`):
   ```ts
   const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n${goalSection}`;
   ```
2. **`src/services/PlanningPanelProvider.ts:3332`** — the legacy `createEpic` message handler:
   ```ts
   const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${name}\n\n${description}`;
   ```

In both, `yamlSafeName` is the epic name (single-quote-escaped), and the real `description` is emitted into the body, not the frontmatter. So the frontmatter `description` is always a duplicate of the H1.

### Impact Analysis — Is the frontmatter read?
No. A full audit of frontmatter parsing in the codebase shows the `description` key is **never read** from epic files. Every consumer either:
- Strips the entire frontmatter block before use (`content.replace(/^---\n[\s\S]*?\n---\n?/, '')`), or
- Parses only specific keys (`kanbanColumn`, `status`, `parentId`, `listId`, `projectId`) — never `description`.

Confirmed read sites that parse frontmatter keys (none read `description`):
- `PlanningPanelProvider.ts:5203-5215` — reads `kanbanColumn`, `status`, `parentId`, `listId`/`projectId`
- `PlanningPanelProvider.ts:8349-8350` — reads `kanbanColumn` only
- `PlanningPanelCacheService.ts:300` — reads frontmatter for cache keying, not `description`

Therefore the `description` frontmatter is pure dead weight. Removing it is safe.

### Migration Note
This feature is **unreleased** — no migration or cleanup pass is needed. Existing epic files in the dev workspace can be regenerated or deleted manually. A clean break is acceptable per the project's unreleased-feature convention.

## Metadata
- **Tags:** epics, frontmatter, cleanup, ux
- **Complexity:** 2/10

## Complexity Audit
**Routine.** Two single-line template-literal edits to stop emitting the frontmatter, plus removal of the now-dead `yamlSafeName`/`yamlSafeDesc` variables. No DB schema changes, no external sync impact (epics never sync to Linear/ClickUp), no new dependencies, no migration. The only risk is a missed epic-creation code path leaving the bug in place — mitigated by the audit confirming exactly two write sites.

## Edge-Case & Dependency Audit
- **`refine_epic` / `group-into-epics` skills**: these route through `createEpicFromPlanIds`, so fixing the KanbanProvider path covers them. No separate skill edits needed.
- **Legacy `PlanningPanelProvider.ts` path**: still reachable via the `createEpic` webview message. Must be fixed in lockstep with the KanbanProvider path or new epics will still get the redundant frontmatter.
- **`_regenerateEpicFile`** (line 8327): only swaps the `<!-- BEGIN SUBTASKS -->…<!-- END SUBTASKS -->` block and preserves the rest of the file. Since new epics will no longer have frontmatter, regeneration will keep them frontmatter-free. No change needed here.
- **Plan watcher**: `registerPendingCreation` is already called before the initial write in both paths; removing the frontmatter does not affect watcher behavior.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — stop emitting redundant frontmatter (line ~8548)

Replace the `epicContent` construction so the file begins with the H1, with the optional `## Goal` section immediately following. Remove the now-unused `yamlSafeName` variable.

```ts
// BEFORE (line 8541-8548)
const yamlSafeName = epicName.replace(/'/g, "''");
const epicDesc = (description ? String(description).replace(/\r\n/g, '\n').trim() : '');
const goalSection = epicDesc ? `## Goal\n\n${epicDesc}\n` : '';
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n${goalSection}`;

// AFTER
const epicDesc = (description ? String(description).replace(/\r\n/g, '\n').trim() : '');
const goalSection = epicDesc ? `## Goal\n\n${epicDesc}\n` : '';
const epicContent = `# ${epicName}\n\n${goalSection}`;
```

### 2. `src/services/PlanningPanelProvider.ts` — stop emitting redundant frontmatter (line ~3330-3332)

Same change in the legacy path. Remove the now-unused `yamlSafeName` and `yamlSafeDesc` variables.

```ts
// BEFORE (line 3329-3332)
const description = msg.description ? String(msg.description).trim() : '';
const yamlSafeName = name.replace(/'/g, "''");
const yamlSafeDesc = description.replace(/'/g, "''");
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${name}\n\n${description}`;

// AFTER
const description = msg.description ? String(msg.description).trim() : '';
const epicContent = `# ${name}\n\n${description}\n`;
```

## Verification Plan
1. **New epic via webview**: Create a new epic via the webview "Create Epic" flow; confirm the resulting file in `.switchboard/epics/` begins with `# <name>` and contains **no** `---\ndescription:---` frontmatter block.
2. **New epic via `create-epic.js`**: Create an epic via the agent script; confirm the same frontmatter-free format.
3. **Subtask section preserved**: After adding subtasks to a new epic, confirm `_regenerateEpicFile` appends the `<!-- BEGIN SUBTASKS -->` block after the H1/Goal without re-introducing frontmatter.
4. **Board refresh**: Confirm the epic still appears on the Kanban board with the correct column, project, and subtask links — the DB record is untouched, only the file body changed.
5. **Type check**: Run `npm run compile` (webpack) to confirm no TypeScript errors from the removed `yamlSafeName`/`yamlSafeDesc` variables.
