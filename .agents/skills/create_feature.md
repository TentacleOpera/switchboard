---
name: create-feature
description: Create a Switchboard feature from a remote session by writing the feature file directly — use when the VS Code extension is not running and create-feature.js is unreachable
---

# Create Feature (Remote Session)

Create a Switchboard feature by writing the feature file directly to
`.switchboard/features/`. Use this skill when you are in a **remote session**
(Claude Code web, claude.ai) and the VS Code extension is not running —
`create-feature.js` routes through the extension's LocalApiServer and has no
direct-DB fallback, so it fails when the extension is unreachable.

## When to Use

- You are in a remote session (no VS Code extension running).
- The user asks to create a new feature (grouping plans together, or a standalone feature).
- Do NOT use this skill if the extension IS running — call `create-feature.js` instead
  (it's authoritative: does DB upsert, subtask linking, file write, and board refresh
  atomically).

## How to Detect Whether the Extension Is Running

1. Check for `.switchboard/api-server-port.txt` in the workspace root.
2. If present and the health endpoint responds
   (`GET http://127.0.0.1:{port}/health`), the extension is live — use `create-feature.js`.
3. If absent or health check fails, proceed with direct file write.

## Feature File Format

Feature files live in `.switchboard/features/` and follow this structure:

```markdown
---
description: '{Feature Name}'
---

# {Feature Name}

## Goal

{Description of what this feature achieves and why it matters.}

## How the Subtasks Achieve This

{Narrative connecting the subtasks to the goal. Written once by the agent;
preserved by _regenerateFeatureFile on subsequent subtask changes.}

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] (no subtasks)
<!-- END SUBTASKS -->
```

**Format notes (verified against source):**
1. **YAML frontmatter** — the extension writes `---\ndescription: '{name}'\n---\n\n# {name}\n\n...`
   (see `createFeatureFromPlanIds` at `KanbanProvider.ts` line 8771). The `description` field is
   quoted to prevent YAML breakage from names containing `:`, `---`, etc. The watcher extracts
   the topic from the H1 title, so frontmatter is not strictly required for import — but it IS
   the canonical format and should be included for consistency.
2. **Full SUBTASKS marker** — use `<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->`
   (see `_regenerateFeatureFile` at `KanbanProvider.ts` line 8648), not the shorter
   `<!-- BEGIN SUBTASKS -->`. The regeneration search uses the prefix `<!-- BEGIN SUBTASKS`,
   so the shorter marker would technically work — but use the full marker to match
   extension-generated files.
3. **No `## Metadata` section** — the extension writes `complexity: 'Unknown'` and `tags: ''`
   directly to the DB (`createFeatureFromPlanIds` lines 8741–8742), NOT via a `## Metadata` section
   in the file. Real feature files do NOT contain a Metadata section. An optional `## Metadata`
   section MAY be added (the watcher will parse it if present), but it is not part of the
   extension-generated format.

The `<!-- BEGIN SUBTASKS ... -->` / `<!-- END SUBTASKS -->` block is managed by the extension.
Write it with the `## Subtasks` heading and `- [ ] (no subtasks)` placeholder — the extension
replaces this when subtasks are linked via `_regenerateFeatureFile`.

## Filename Convention

```
{slug}-{planId}.md
```

- `slug`: lowercase, hyphens only, max 60 chars (e.g. `auth-refactor`)
- `planId`: a fresh UUID v4 (generate with
  `node -e "const {randomUUID}=require('crypto');console.log(randomUUID())"`)
- Full path: `.switchboard/features/{slug}-{planId}.md`
- **Never omit the planId from the filename** — the watcher derives the `plan_id` from this
  trailing UUID on re-import. A bare slug would mint a fresh random ID on re-import and orphan
  every subtask.

## Linking Existing Plans as Subtasks

After writing the feature file, to link existing plans (identified by their `planId` from
`kanban-board.md`):

```bash
node .agents/skills/kanban_operations/assign-to-feature.js "{featurePlanId}" '["subtaskPlanId1","subtaskPlanId2"]' "{workspaceRoot}"
```

This also routes through the extension; in a remote session it will fail and the agent should
note that subtask linking will need to be done when VS Code is next opened, OR the user can
drag-and-drop in the kanban UI.

## Sourcing Existing Suggest-Feature Content

The kanban UI's "Suggest Features" button generates a detailed prompt (see
`_buildSuggestFeaturesPrompt` in `KanbanProvider.ts`) that:
- Scans `kanban-board.md` for ungrouped plans in pre-coding columns
- Groups them by theme
- Proposes feature names and goals for user approval
- Then calls `create-feature.js`

If the user has not specified which plans to group, read `kanban-board.md`, propose groupings,
get approval, then create the feature files.

## After Writing

- Commit the new file to git (the features folder will be tracked once
  `expose-features-folder-in-gitignore.md` is deployed).
- Note to the user that the extension will automatically import the feature into the kanban DB on
  next activation via the GlobalPlanWatcherService.
