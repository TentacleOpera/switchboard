# Add /sw-remote Entry Skill for Remote Switchboard Sessions

## Goal

Create a `/sw-remote` skill that serves as the entry point for remote Switchboard planning sessions (Claude Code web, claude.ai). It orients the agent to the remote-mode workflow: plans live in Linear/Notion, MCP is the control surface, git is not used for planning, and `/improve-remote-plan` replaces `/improve-plan`.

### Problem & Background

The existing `/sw` (switchboard-chat) skill assumes the agent can read `.switchboard/plans/`, write plan files, and trigger column transitions — all of which require the local machine and VS Code extension to be active. There is also an existing stub plan `add-switchboard-remote-skill.md` that covers basic Linear orientation, but it only addresses the "dispatch" use case (writing a plan then triggering execution). It does not cover the async improvement workflow or the startup reconciler pattern.

`/sw-remote` is a full peer to `/sw` for remote contexts. It replaces the stub orientation approach with a complete entry-point skill that knows about the remote planning stack. `/sw` is unchanged — it remains the correct entry point for users without remote integration.

---

## Implementation Tasks

### 1. Create skill file

**Path:** `.claude/skills/sw-remote/SKILL.md`

**Frontmatter:**
```
---
name: sw-remote
description: Entry point for remote Switchboard planning sessions — orients Claude to use Linear/Notion MCP instead of local files
---
```

### 2. Skill instruction content

**On invocation**, the skill must:

**1. Confirm remote context**
- Check which MCP servers are connected (Linear, Notion, GitHub)
- Report what's available and note any missing connections (e.g., if neither Linear nor Notion is connected, warn the user that remote planning won't be possible)

**2. Orient on remote-mode rules**
Communicate the following to the agent's working context:
- Plans are stored in Linear/Notion — do NOT write `.md` files to `.switchboard/plans/` or commit to a branch for planning work
- Use `list_issues` / Notion queries to read the current kanban state (not local `kanban.db` or `kanban-board.md`)
- To improve a plan: use `/improve-remote-plan` (not `/improve-plan`)
- To create a new plan: write directly to a new Linear issue or Notion page, set status to "Created"
- Column transitions happen via status updates in Linear/Notion — the extension picks them up on next IDE startup
- To trigger local execution: set the Linear/Notion status to the execution-trigger state (confirm the name with `list_issue_statuses` first)

**3. Read current board state**
- Query Linear/Notion for issues in the Switchboard-mapped project, grouped by status
- Present a brief summary: how many plans per column, any plans in a state that suggests remote action is needed (e.g., "Created" plans that could be improved)

**4. Prompt for intent**
After orientation, ask: "What would you like to work on?" — same consultative opening as `/sw`.

### 3. Register alias in CLAUDE.md

Add `sw-remote` to the Workflow Registry table and the Available Skills table:

**Workflow Registry:**
```
| `/sw-remote` | **`sw-remote.md`** | Remote session entry point — Linear/Notion MCP planning mode |
```

**Available Skills:**
```
| `sw-remote` | Entry point for remote Switchboard sessions — orients Claude to Linear/Notion MCP workflow. Use instead of /sw when local machine is off. |
```

### 4. Supersede the stub plan

Mark `add-switchboard-remote-skill.md` as superseded by this plan. The simpler orientation content it describes can be folded into this skill's architecture overview section.

---

## Edge Cases & Risks

- **Neither Linear nor Notion connected**: Skill should degrade gracefully — explain the limitation and offer to fall back to `/sw` if the user has local access
- **Multiple boards mapped**: If multiple Switchboard projects exist in Linear, the skill must guide the user to identify the correct one
- **User accidentally uses `/sw` in a remote session**: Not a hard error, but `/sw` will try to read local files that don't exist. The skill file for `/sw` could add a note pointing to `/sw-remote` for remote contexts
- **Status name drift**: Linear status names can be renamed by the user. The skill should always use `list_issue_statuses` rather than assuming names from prior sessions

---

## Out of Scope

- Modifying `/sw` (switchboard-chat) — it stays unchanged for local sessions
- ClickUp support (follow-on after Linear/Notion)
- Auto-detecting remote vs local context (user explicitly invokes `/sw-remote`)

---

## Metadata

**Complexity:** 3
**Tags:** cli, infrastructure, feature, docs
