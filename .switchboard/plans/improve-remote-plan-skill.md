# Add /improve-remote-plan Skill for Linear/Notion-Native Plan Improvement

## Goal

Create an `/improve-remote-plan` skill that improves a Switchboard plan living in Linear or Notion — reading content from the issue/page, deepening it with improve-plan logic, writing the result back via MCP, and advancing the card's status — all without touching the git repo or local filesystem.

### Problem & Background

The existing `/improve-plan` workflow reads `.md` plan files from `.switchboard/plans/` and writes back to the same files. In a remote session (Claude Code web, claude.ai) with no local machine running, this creates a git dependency: the agent must commit to a branch and open a PR before any improvement lands in the kanban board. There is also a timing race where the extension starts before the branch is pulled, so column transitions are missed.

The root fix is to treat Linear/Notion as the canonical plan store during the remote phase. The extension's existing two-way sync already maps Linear statuses to kanban columns — so writing content and updating a status in Linear is functionally equivalent to editing the plan file and moving the card, picked up by the startup reconciler (see `kanban-startup-reconciler.md`).

This skill is the agent-side half of that fix.

---

## Implementation Tasks

### 1. Create skill file

**Path:** `.claude/skills/improve-remote-plan/SKILL.md`

**Frontmatter:**
```
---
name: improve-remote-plan
description: Improve a Switchboard plan stored in Linear or Notion — reads, deepens, and writes back via MCP without touching git
---
```

### 2. Skill instruction content

The skill must orient the agent on the following workflow:

**Pre-flight**
- Confirm Linear or Notion MCP is connected before proceeding
- If neither is available, abort and tell the user to use `/improve-plan` instead (requires local session)
- Use `list_issue_statuses` (Linear) or equivalent Notion query to identify the column-trigger status names before writing — never guess

**Read phase**
- Locate the target plan: accept an issue ID/URL directly, or if none provided, query for issues in the "Created" / backlog status within the Switchboard-mapped project
- Read the full issue description (Linear: `get_issue`; Notion: read the page body)
- If description is empty or missing a `## Goal` section, warn the user — the plan may not have been authored yet

**Improve phase**
Apply the same logic as `/improve-plan`:
- Sharpen and expand the `## Goal` section with problem analysis and root cause if missing
- Identify and document edge cases not covered by the current tasks
- Deepen implementation tasks with specific file paths, method names, and constraints where inferable from the description
- Add or improve `## Edge Cases & Risks` and `## Out of Scope` sections
- Do NOT change the plan's intent or introduce scope the user hasn't approved

**Write phase**
- Write the improved content back to the issue description (Linear: `save_issue`; Notion: update page body)
- Update the issue status to the "Improved" / next-column trigger state as configured in the remote control mapping
- Do NOT move the Linear issue to a status that triggers local execution (e.g. "Coded") unless the user explicitly instructs it — the purpose of this skill is improvement, not dispatch

**Confirmation**
- Report back: issue ID, what was changed (summary), and what status it was set to
- Remind the user that the kanban card will advance on next IDE startup via the reconciler

### 3. Register the skill in CLAUDE.md

Add a row to the `### 📚 Available Skills` table:

```
| `improve-remote-plan` | Improve a plan stored in Linear/Notion via MCP — reads, deepens, writes back, and advances status without touching git. Use in remote sessions. |
```

---

## Edge Cases & Risks

- **No MCP connected**: Skill must detect this and abort gracefully with a clear message
- **Multiple Switchboard projects in Linear**: Agent must use `list_projects` to identify the correct one, not assume
- **Status name mismatch**: The "next column" status name must be read from the remote control config, not hardcoded. Incorrect status = silent no-op or wrong column advance
- **Plan has no content yet**: If the issue description is a stub, the skill should warn rather than silently produce a minimal improvement
- **Notion vs Linear branch**: The skill should detect which MCP is available and use the appropriate tool calls — don't assume Linear
- **Reconciler not yet deployed**: If the startup reconciler (see `kanban-startup-reconciler.md`) hasn't been implemented yet, the status update will be written to Linear/Notion but won't advance the kanban card until the user manually moves it. The skill should note this caveat until the reconciler ships.

---

## Out of Scope

- Creating new plans from scratch (read-phase requires existing plan content)
- Dispatching local execution (that's a separate status transition the user controls)
- ClickUp support (follow-on)
- Modifying the `/improve-plan` skill (local session variant stays unchanged)

---

## Metadata

**Complexity:** 3
**Tags:** cli, infrastructure, feature, docs
