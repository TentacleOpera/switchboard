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
2. **`src/services/PlanningPanelProvider.ts:3333`** — the legacy `createEpic` message handler:
   ```ts
   const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${name}\n\n${description}`;
   ```

In both, `yamlSafeName` is the epic name (single-quote-escaped), and the real `description` is emitted into the body, not the frontmatter. So the frontmatter `description` is always a duplicate of the H1.

A third `case 'createEpic'` handler exists at `KanbanProvider.ts:7822`, but it delegates to `createEpicFromPlanIds` — it is not a separate write path.

### Impact Analysis — Is the frontmatter read?
No. A full audit of frontmatter parsing in the codebase shows the `description` key is **never read** from epic files. Every consumer either:
- Strips the entire frontmatter block before use (`content.replace(/^---\n[\s\S]*?\n---\n?/, '')`), or
- Parses only specific keys (`kanbanColumn`, `status`, `parentId`, `listId`, `projectId`) — never `description`.

Confirmed read sites that parse frontmatter keys (none read `description` from epic files):
- `PlanningPanelProvider.ts:5203-5215` — reads `kanbanColumn`, `status`, `parentId`, `listId`/`projectId` (from ticket files, not epic files)
- `PlanningPanelProvider.ts:8349-8350` — reads `kanbanColumn` only (from ticket files via `_scanLocalTicketFiles`)
- `PlanningPanelCacheService.ts:300` — reads `docId`/`docName` for cache keying (from cached source docs, not epic files)
- `ClaudeCodeMirrorService.ts:183` — reads `description:` from frontmatter, but only from **SKILL.md** files during mirror generation, not from epic files
- `KanbanDatabase.ts:3313` — strips entire frontmatter block for content hashing (applies to all plan/epic files but never reads `description` key)
- Webview JS (`src/webview/*.js`, `src/webview/*.html`) — no frontmatter key parsing for `description` confirmed via search

The universal frontmatter-stripping pattern (`replace(/^---\n[\s\S]*?\n---\n?/, '')`) is used at 16+ sites across `PlanningPanelProvider.ts`, `KanbanDatabase.ts`, `PlannerPromptWriter.ts`, `TaskViewerProvider.ts`, and `KanbanProvider.ts` before any content display or processing. None of these read the `description` key individually.

Therefore the `description` frontmatter is pure dead weight. Removing it is safe.

### Migration Note
This feature is **unreleased** — no migration or cleanup pass is needed for the published install base. A clean break is acceptable per the project's unreleased-feature convention.

**Clarification on existing dev-workspace epic files:** `_regenerateEpicFile` (`KanbanProvider.ts:8327`) only swaps the `<!-- BEGIN SUBTASKS -->…<!-- END SUBTASKS -->` block and preserves the rest of the file. This means regeneration does **not** strip frontmatter from existing epic files — only newly created epics will be frontmatter-free. Existing dev epic files can be deleted manually or cleaned with a one-time `sed` pass if desired; this is optional and out of scope for this change.

## Metadata
- **Tags:** refactor, backend, ui
- **Complexity:** 2/10

## User Review Required
No. The change removes dead frontmatter that is never read. Both write paths are confirmed, no consumers parse the `description` key from epic files, and the feature is unreleased (no migration needed). The only user-visible effect is that new epic files will begin with `# <name>` instead of a YAML frontmatter block.

## Complexity Audit

### Routine
- Two single-line template-literal edits to stop emitting the frontmatter block.
- Removal of the now-dead `yamlSafeName` variable (both paths) and `yamlSafeDesc` variable (PlanningPanelProvider path only).
- Removal of the orphaned comment on `KanbanProvider.ts:8541` ("Quote YAML values to prevent frontmatter breakage…") which references the deleted `yamlSafeName` variable.
- No DB schema changes, no external sync impact (epics never sync to Linear/ClickUp), no new dependencies.

### Complex / Risky
- None. The only risk — a missed epic-creation code path leaving the bug in place — is mitigated by the audit confirming exactly two write sites (the third `case 'createEpic'` in KanbanProvider delegates to `createEpicFromPlanIds`).

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `registerPendingCreation` is called before the file write in both paths; removing the frontmatter does not affect watcher behavior or timing.
- **Security:** None. The removed `yamlSafeName` was a YAML-quoting escape for the frontmatter; with no frontmatter, there is no injection surface. The epic name is emitted as a markdown H1 (`# ${epicName}`), which is the existing behavior for the H1 line and carries no new risk.
- **Side Effects:** `_regenerateEpicFile` (`KanbanProvider.ts:8327`) preserves existing content and only swaps the SUBTASKS block — new frontmatter-free epics stay frontmatter-free through regeneration. No change needed there.
- **Dependencies & Conflicts:**
  - `refine_epic` / `group-into-epics` skills: these route through `createEpicFromPlanIds` (via `create-epic.js` → `/kanban/epic` API → `TaskViewerProvider.createEpic` → `KanbanProvider.createEpicFromPlanIds`), so fixing the KanbanProvider path covers them. No separate skill edits needed.
  - Legacy `PlanningPanelProvider.ts` path: still reachable via the `createEpic` webview message from `project.js:2683`. Must be fixed in lockstep with the KanbanProvider path or new epics created via the project panel will still get the redundant frontmatter.
  - Plan watcher: `registerPendingCreation` is already called before the initial write in both paths; removing the frontmatter does not affect watcher behavior.

## Dependencies
- None. This is a self-contained two-file edit with no prerequisite plans.

## Adversarial Synthesis
Key risks: (1) orphaned comment on `KanbanProvider.ts:8541` referencing the deleted `yamlSafeName` variable — must be removed in the same edit; (2) existing dev-workspace epic files will retain their frontmatter since `_regenerateEpicFile` only swaps the SUBTASKS block — this is acceptable for an unreleased feature but the Migration Note has been updated to avoid misleading expectations; (3) a pre-existing body-format inconsistency between the two paths (KanbanProvider wraps description in `## Goal`, PlanningPanelProvider emits raw description) is preserved as-is and is out of scope. Mitigations: remove the orphaned comment, update the Migration Note, and confirm both write paths are fixed in lockstep.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — stop emitting redundant frontmatter (line ~8541-8548)

Replace the `epicContent` construction so the file begins with the H1, with the optional `## Goal` section immediately following. Remove the now-unused `yamlSafeName` variable **and** the orphaned comment on line 8541 that references it.

```ts
// BEFORE (line 8541-8548)
// Quote YAML values to prevent frontmatter breakage from names containing ---, :, etc.
const yamlSafeName = epicName.replace(/'/g, "''");
// The description lives in the markdown body under ## Goal (after the closed
// frontmatter block), so newlines are safe and preserve the agent's multi-line
// goal formatting. Only normalize CRLF and trim — no flattening.
const epicDesc = (description ? String(description).replace(/\r\n/g, '\n').trim() : '');
const goalSection = epicDesc ? `## Goal\n\n${epicDesc}\n` : '';
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n${goalSection}`;

// AFTER
// The description lives in the markdown body under ## Goal, so newlines are safe
// and preserve the agent's multi-line goal formatting. Only normalize CRLF and
// trim — no flattening. No frontmatter is emitted — the file begins with the H1.
const epicDesc = (description ? String(description).replace(/\r\n/g, '\n').trim() : '');
const goalSection = epicDesc ? `## Goal\n\n${epicDesc}\n` : '';
const epicContent = `# ${epicName}\n\n${goalSection}`;
```

### 2. `src/services/PlanningPanelProvider.ts` — stop emitting redundant frontmatter (line ~3330-3333)

Same change in the legacy path. Remove the now-unused `yamlSafeName` and `yamlSafeDesc` variables.

```ts
// BEFORE (line 3330-3333)
const description = msg.description ? String(msg.description).trim() : '';
const yamlSafeName = name.replace(/'/g, "''");
const yamlSafeDesc = description.replace(/'/g, "''");
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${name}\n\n${description}`;

// AFTER
const description = msg.description ? String(msg.description).trim() : '';
const epicContent = `# ${name}\n\n${description}\n`;
```

**Clarification (pre-existing, out of scope):** The PlanningPanelProvider path emits the raw `description` string in the body (no `## Goal` wrapper), while the KanbanProvider path wraps it in `## Goal\n\n…\n`. This inconsistency exists in the current code and is not introduced by this change. Aligning the two body formats is a separate refinement outside this plan's scope.

## Verification Plan

### Automated Tests
Automated tests are skipped for this session per directive. The test suite will be run separately by the user. No new test files are required — this is a template-literal change with no new logic branches.

### Manual Verification
1. **New epic via webview (Kanban board):** Create a new epic via the Kanban board "Create Epic" flow; confirm the resulting file in `.switchboard/epics/` begins with `# <name>` and contains **no** `---\ndescription:---` frontmatter block.
2. **New epic via project panel:** Create an epic via the project panel's "Create Epic" flow (the `PlanningPanelProvider` path); confirm the same frontmatter-free format.
3. **New epic via `create-epic.js`:** Create an epic via the agent script; confirm the same frontmatter-free format (this path routes through `createEpicFromPlanIds`).
4. **Subtask section preserved:** After adding subtasks to a new epic, confirm `_regenerateEpicFile` appends the `<!-- BEGIN SUBTASKS -->` block after the H1/Goal without re-introducing frontmatter.
5. **Board refresh:** Confirm the epic still appears on the Kanban board with the correct column, project, and subtask links — the DB record is untouched, only the file body changed.
6. **Type check (skipped):** Compilation is skipped per directive. The user should run `npm run compile` separately to confirm no TypeScript errors from the removed `yamlSafeName`/`yamlSafeDesc` variables and the orphaned comment removal.

---

**Recommendation:** Complexity is 2/10 → **Send to Intern**. This is a routine two-file template-literal edit with no logic changes, no DB impact, and no migration requirements.
