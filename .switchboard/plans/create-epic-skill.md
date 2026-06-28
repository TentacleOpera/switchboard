# Add `/create-epic` Skill for Remote Agent Epic Creation

## Goal

Create a `.claude/skills/create-epic/SKILL.md` skill that teaches agents how to create epics from a remote session (where the Switchboard VS Code extension is not running and `create-epic.js` cannot be used). The skill should tell the agent how to write an epic file directly to `.switchboard/epics/`, in the correct format, so the extension picks it up via the GlobalPlanWatcherService when VS Code reconnects.

**Background:** `create-epic.js` routes through the running extension's LocalApiServer (`POST /kanban/epic`) and explicitly has no direct-DB fallback — it fails with a clear error if the extension is unreachable. This is by design for the local-VS Code case, but it means remote agents have no way to create epics today. The skill bridges this gap by teaching agents to write the file directly in the correct format.

**Key constraint:** The epic file embeds the `planId` UUID in the filename (e.g. `my-epic-{uuid}.md`) so the watcher can derive the plan_id on re-import and preserve subtask→epic links. A bare slug would mint a fresh random ID on re-import and orphan every subtask. The skill must enforce this.

## Metadata

**Complexity:** 3
**Tags:** cli, docs, infrastructure, reliability

## Proposed Changes

### [CREATE] `.claude/skills/create-epic/SKILL.md`

The skill should cover the following, in order:

**1. When to use this skill**
- Agent is working in a remote session (no VS Code extension running)
- User asks to create a new epic (grouping plans together, or creating a standalone epic)
- Do NOT use this skill if the extension IS running — call `create-epic.js` instead (it's authoritative: does DB upsert, subtask linking, file write, and board refresh atomically)

**2. How to detect whether the extension is running**
- Check for `.switchboard/api-server-port.txt` in the workspace root
- If present and the health endpoint responds (`GET http://127.0.0.1:{port}/health`), the extension is live — use `create-epic.js`
- If absent or health check fails, proceed with direct file write

**3. Epic file format**

Epic files live in `.switchboard/epics/` and follow this structure:

```markdown
# {Epic Name}

## Goal

{Description of what this epic achieves and why it matters.}

## How the Subtasks Achieve This

{Narrative connecting the subtasks to the goal. Written once by the agent;
preserved by _regenerateEpicFile on subsequent subtask changes.}

<!-- BEGIN SUBTASKS -->
<!-- END SUBTASKS -->

## Metadata

**Complexity:** {1–10}
**Tags:** {comma-separated from standard tag list}
```

The `<!-- BEGIN SUBTASKS -->` / `<!-- END SUBTASKS -->` block is managed by the extension. Write it empty — the extension fills it in when the epic's subtasks are linked.

**4. Filename convention**

```
{slug}-{planId}.md
```

- `slug`: lowercase, hyphens only, max 60 chars (e.g. `auth-refactor`)
- `planId`: a fresh UUID v4 (generate with `node -e "const {randomUUID}=require('crypto');console.log(randomUUID())"`)
- Full path: `.switchboard/epics/{slug}-{planId}.md`
- **Never omit the planId from the filename** — the watcher derives the plan_id from this trailing UUID on re-import.

**5. Linking existing plans as subtasks**

After writing the epic file, to link existing plans (identified by their `planId` from `kanban-board.md`):

```bash
node .agents/skills/kanban_operations/assign-to-epic.js "{epicPlanId}" '["subtaskPlanId1","subtaskPlanId2"]' "{workspaceRoot}"
```

This also routes through the extension; in a remote session it will fail and the agent should note that subtask linking will need to be done when VS Code is next opened, OR the user can drag-and-drop in the kanban UI.

**6. Sourcing existing suggest-epic content**

The kanban UI's "Suggest Epics" button generates a detailed prompt (see `_buildSuggestEpicsPrompt` in `KanbanProvider.ts`) that:
- Scans `kanban-board.md` for ungrouped plans in pre-coding columns
- Groups them by theme
- Proposes epic names and goals for user approval
- Then calls `create-epic.js`

The skill should reference this flow: if the user has not specified which plans to group, tell the agent to read `kanban-board.md`, propose groupings, get approval, then create the epic files.

**7. After writing**

- Commit the new file to git (the epics folder will be tracked once Plan `expose-epics-folder-in-gitignore.md` is deployed)
- Note to the user that the extension will automatically import the epic into the kanban DB on next activation via the GlobalPlanWatcherService

### [VERIFY] GlobalPlanWatcherService watches epics/

Before finalising the skill, confirm that `GlobalPlanWatcherService.ts` sets up a file watcher on `.switchboard/epics/` (not just `.switchboard/plans/`). If it doesn't, the direct-file-write path is incomplete and the plan needs an additional task to add that watcher. Check for references to `epics` in `src/services/GlobalPlanWatcherService.ts`.

## Verification Plan

1. Read `GlobalPlanWatcherService.ts` to confirm `epics/` is watched — escalate to a separate plan if not.
2. In a remote session (or with extension stopped), run the skill manually: generate a UUID, write an epic file following the format, confirm the file is valid markdown.
3. Open VS Code → confirm the epic appears in the kanban board (GlobalPlanWatcherService import).
4. Run the suggest-epics flow in the kanban UI → confirm it still works independently (this skill doesn't change the extension code).

## Success Criteria

1. `.claude/skills/create-epic/SKILL.md` exists with the format, filename convention, detection logic, and subtask-linking notes.
2. An agent following the skill can produce a valid epic file that the extension imports on activation.
3. Skill is registered in the skills table in `CLAUDE.md`.
