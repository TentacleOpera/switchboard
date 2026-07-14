---
created: 2026-07-14T00:00:00.000Z
---

# [Chore] [Docs/Copy] Correct Claude Desktop connection wording — Code mode is not MCP-only

## Goal

Fix inaccurate in-repo metadata and Setup UI copy that claim Claude Desktop can only reach the Switchboard board through the MCP bridge. Claude Desktop's **Code mode** drives the board directly, exactly like any CLI agent: add the workspace folder that holds the scaffolding (`.claude/` + `.switchboard/`) and use `/switchboard` (and the other slash commands) — **no MCP**. The MCP bridge is only for Claude Desktop's **chat / Home (cowork) mode** and other hosts with no filesystem, and it is **localhost-only** (Claude Desktop must run on the same machine as the IDE — it is not remote control).

### Problem Analysis

**Background.** The switchboard-site docs were corrected to this model. The extension repo's own skill metadata and Setup panel still carry the old assumption that Claude Desktop is an "MCP-only chat host with no shell/filesystem." Confirmed inaccurate by the maintainer (screenshot): Claude Desktop Code mode + an added repo folder runs `/switchboard` against the live board (auto-discovers the local API port), with no MCP involved.

**Root cause.** The `switchboard-mcp` skill and registry rows were written treating Claude Desktop as MCP-only. That is true only for its chat/Home mode; Code mode has shell + filesystem and behaves like Claude Code / Antigravity.

## Work Items (exact locations)

1. **`CLAUDE.md:145` and `AGENTS.md:114`** — the `switchboard-mcp` skill-registry row. Delete "Claude Desktop reaches the management surface via this MCP server, not shell." Reframe: the MCP bridge serves MCP-only hosts and Claude Desktop's **chat/Home mode**; in **Code mode** Claude Desktop uses the added folder + slash commands directly (no MCP). State the bridge is localhost-only (same machine as the IDE).

2. **`.agents/skills/switchboard-mcp/SKILL.md` and `.claude/skills/switchboard-mcp/SKILL.md`** — the "When to Use" line currently frames Claude Desktop as "MCP-only chat host that has no shell/filesystem." Qualify it: this applies to Claude Desktop's **chat/Home mode**; in **Code mode** it has a filesystem and should just add the workspace folder and use the slash commands (no bridge).
   - ⚠️ Propagation: the loaded workspace copies under `Gitlab/.claude` / `Gitlab/.agents` were installed with `overwrite:false` and are frozen — a version bump will not refresh them. Reconcile the loaded copies too (content-hash refresh / rsync), not just the dev-repo source.

3. **`src/webview/setup.html:592-594`** — the "Claude Desktop bridge" card. Clarify that the bridge is for Claude Desktop **chat/cowork mode** (or other no-filesystem hosts); in **Code mode**, add this workspace folder in Claude Desktop and use `/switchboard` — no bridge needed. Add the localhost / same-machine caveat.

## Acceptance Criteria

- No file in the repo states or implies Claude Desktop can only reach the board via MCP.
- The `switchboard-mcp` skill (registry rows + both SKILL.md copies) distinguishes Code mode (direct, no MCP) from chat/cowork mode (MCP bridge), and notes the localhost-only constraint.
- The setup.html "Claude Desktop bridge" card reflects the same distinction.
- `claude.ai` is not asserted as a working path anywhere (untested).

## Out of Scope

- The switchboard-site docs (already corrected).
- Any change to the MCP server code itself — this is wording/metadata only.
