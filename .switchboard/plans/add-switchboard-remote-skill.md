# Add /switchboard-remote Orientation Skill for Claude Web Sessions

## Goal

Create a `/switchboard-remote` skill that orients Claude at the start of a web session on how to use the Linear Remote Control feature as a Switchboard control surface.

### Problem & Background

Switchboard's Linear Remote Control feature allows driving the Kanban board from any Linear client — moving a Linear issue between states dispatches the corresponding local Kanban column agent; comments are routed to the current column's agent. This makes Linear an async message bus between the remote world and the local machine, requiring no SSH or cloud session.

Three control surfaces exist:
1. **Linear app** — user moves cards manually, limited to status transitions
2. **Claude.ai web + Linear MCP** — Claude reads the repo (via GitHub MCP), writes rich implementation plans into Linear issue descriptions, and triggers execution via status changes
3. **Linear native agents** — natural language, but no code analysis capability

Surface #2 is the highest-value option for web sessions because Claude can analyse the codebase and author thorough plans before anything runs locally. The gap is that neither Claude nor users have a concise orientation document explaining this workflow — the information exists only in the README and how-to guide, not as an invocable skill.

---

## Implementation Tasks

### 1. Read source documentation
Before authoring the skill, the implementer must read:
- `README.md` §"Linear Remote Control" (line 166–167)
- `README.md` §"ClickUp & Linear Sync" (lines 145–152)
- `README.md` §"Live Sync Mode" (lines 169–172)
- `docs/how_to_use_switchboard.md` §"4. Automated Triage & Remote Control → Linear Remote Control" (lines 69–71)

### 2. Create skill file

**Path:** `.claude/skills/switchboard-remote/SKILL.md`

**Required content sections:**

**Frontmatter**
```
---
name: switchboard-remote
description: Orient Claude on using Linear MCP as a remote control surface for Switchboard
---
```

**Architecture overview**
- Linear is a two-way sync message bus: Switchboard polls Linear every 30–120s (configurable) and mirrors state changes locally
- Moving a Linear issue to a new state → dispatches the Kanban column agent for that state on the local machine
- Comments posted on a Linear issue → routed to the current column's agent as input
- Plan content lives in the issue description; no special format is required — the dispatched agent reads whatever is there
- Config is stored in the Kanban DB under key `remote.config`, not in `settings.json`; toggle is in the toolbar remote control button; configuration is in the Kanban REMOTE tab (board selection, ping mode: manual/constant, frequency: 30–120s)

**The three control surfaces** (brief table or list)
Surface #2 note: Claude's value here is reading the repo via GitHub MCP, writing a detailed implementation plan into the issue description, and setting the trigger status — giving the local agent far richer instructions than a manually written Linear ticket.

**Linear MCP workflow for Claude**
Step-by-step orientation:
1. Use `list_projects` / `list_teams` to locate the synced Switchboard project
2. Use `list_issues` to find the target issue (or `save_issue` to create one)
3. Use `list_issue_statuses` to identify the status name that triggers local execution
4. Read the repo / analyze code as needed (GitHub MCP)
5. Write the implementation plan into the issue description via `save_issue`
6. Set the trigger status via `save_issue` to dispatch the local agent
7. On a future session: use `get_issue` to read results written back by the local agent

**Configuration pre-flight**
Remind Claude to confirm remote control is enabled (toolbar button) and the correct board is mapped in the REMOTE tab before attempting to trigger via status change.

**Reference links**
- `README.md` §"Linear Remote Control"
- `README.md` §"ClickUp & Linear Sync"
- `docs/how_to_use_switchboard.md` §"Automated Triage & Remote Control"

### 3. Register the skill in CLAUDE.md

Add a row to the `### 📚 Available Skills` table:

```
| `switchboard_remote` | Orient Claude on using Linear MCP as a remote control for Switchboard — use at session start when working from Claude.ai web |
```

---

## Edge Cases & Risks

- **Remote not enabled:** The skill should remind Claude to verify the remote toggle is on and the board is mapped before attempting status-driven dispatch. A status change on an unmapped board is a no-op.
- **Status name mismatch:** Linear status names must match what Switchboard expects. The skill should instruct Claude to use `list_issue_statuses` rather than guessing names.
- **Multiple boards:** If the user has multiple Switchboard boards synced to Linear, Claude needs to identify the right project. The skill should guide using `list_projects` first.
- **Plan format:** The local agent reads whatever is in the description — no special format is enforced — but the skill should recommend using the standard Switchboard plan structure (Goal, Tasks, etc.) for consistency with local plans.
- **Read-back latency:** Results written by the local agent appear in the Linear issue after the next Kanban → Linear sync cycle (up to 30s). Claude should note this when checking results in a follow-up session.

---

## Out of Scope

- No changes to the Switchboard extension backend
- No changes to the Linear sync logic
- No new UI or configuration options

---

## Metadata

**Complexity:** 2
**Tags:** docs, cli, infrastructure
