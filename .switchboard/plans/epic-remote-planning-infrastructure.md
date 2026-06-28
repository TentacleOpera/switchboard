# Epic: Remote Planning Infrastructure

## Goal

Enable full Switchboard planning workflows from remote sessions (Claude Code on the web, claude.ai) without requiring the local machine or IDE to be running. Plans are read from and written directly to Linear/Notion via MCP — no git branches, no pull requests, no repo file writes for the planning phase.

### Problem & Background

Currently Switchboard plans are `.md` files in `.switchboard/plans/`. All column transitions are executed by the Switchboard VS Code extension on the local machine. This creates two blockers for remote sessions:

1. **Branch/git dependency**: A remote agent (Claude Code web) must commit plan files to a branch and open a PR. The user must pull and review before any work lands in the kanban board.
2. **No async column transitions**: If a remote agent improves a plan and wants to advance the kanban card, the extension must be running. Without it, the card stays stuck in its current column until the user manually moves it.

The fix is to make Linear/Notion the source of truth for plans during the remote phase, using the existing two-way sync infrastructure. The extension already maps Linear statuses to kanban columns — so a remote agent updating a Linear issue status is equivalent to moving a kanban card, picked up on next IDE startup via a new reconciliation step.

---

## Phase 1 — Remote Plan Improvement (no git)

**Goal**: A remote agent can improve plans and advance kanban columns entirely via Linear/Notion MCP, with no git involvement.

**Child plans:**
- `improve-remote-plan-skill.md` — New `/improve-remote-plan` skill: reads plan from Linear/Notion, applies improve-plan logic, writes content and status back via MCP
- `sw-remote-entry-skill.md` — New `/sw-remote` skill: entry point for remote sessions, orients agent to remote-mode workflow (supersedes `add-switchboard-remote-skill.md`)
- `kanban-startup-reconciler.md` — Extension feature: on startup, query Linear/Notion for status changes made during offline period and reconcile kanban.db

**Dependency**: Phase 1 requires the Linear/Notion remote control to already be configured and a board mapped. No new sync infrastructure needed.

---

## Phase 2 — Repo Mapping & Live Doc Sync

**Goal**: Detailed codebase documentation lives in Linear/Notion, maintained continuously by the extension. Enables pure claude.ai + Notion connector planning sessions with no Claude Code remote, no GitHub MCP, no branches.

**Child plans:** TBD — requires a design session on:
- Rate limit management for continuous sync (Notion: ~3 req/s, Linear: similar)
- Doc granularity strategy (file summaries, module docs, ADRs)
- Leveraging existing notebooklm integration folder as a base
- Sync state tracking (what changed, what was already pushed)

**Outcome**: User opens claude.ai, attaches Notion, asks Claude to write a plan. Claude reads live codebase docs from Notion, authors a plan, writes it back to Notion with the trigger status. Extension picks it up on startup. Zero git.

---

## Out of Scope (this epic)

- Changes to the existing `/sw` (switchboard-chat) skill — it remains for users without remote integration
- ClickUp support in Phase 1 (Linear/Notion only, ClickUp can follow)
- Automated plan creation from scratch remotely (Phase 1 covers improvement only)

---

## Metadata

**Complexity:** 7
**Tags:** infrastructure, backend, cli, feature, devops
