# Replace Switchboard MCP Server Tools with Skills

## Goal
Migrate agent invocation patterns from MCP API proxy tools to skill-based LocalApiServer invocations, updating documentation and agent instructions while preserving the MCP server for workflow coordination tools.

## Metadata
- **Tags:** [workflow, documentation, reliability]
- **Complexity:** 5

## User Review Required
- Confirm that the MCP server config should remain intact (workflow tools still need it)
- Confirm that `clickup_mcp.md` should be deprecated/redirected rather than deleted
- Confirm preference: should agents with native MCP access (e.g., Devin) still use MCP tools directly, or force skill usage for consistency?

## Complexity Audit

### Routine
- Update AGENTS.md skill table "replaces" notes (lines 74-87) — already present, verify accuracy
- Update `.cursorrules` MCP tool list to clarify which tools are API proxy vs workflow
- Add deprecation notice to `clickup_mcp.md` skill with redirect to LocalApiServer skills
- Update `docs/TECHNICAL_DOC.md` (lines 100-134) to reference skill-based patterns alongside MCP tool docs
- Search and update any remaining references to MCP API tool names in documentation

### Complex / Risky
- Agents with native MCP support (Devin, Cursor) lose direct function-call access to API tools when switching to skills — they must construct curl commands instead. This is a UX/capability regression for MCP-native agents.
- Transition period where some agents use MCP tools and others use skills could cause inconsistent behavior. No rollback plan if skills prove unreliable.
- The `clickup_mcp.md` skill (253 lines) is a comprehensive reference for MCP tool usage; deprecating it removes detailed parameter/error documentation that the individual skill files don't fully replicate (e.g., `resolve_assignees`, `filter_tasks`, time tracking, workspace hierarchy tools have no skill equivalents).

## Edge-Case & Dependency Audit

- **Race Conditions:** None. This is a documentation/preference change, not a runtime change.
- **Security:** Skills use LocalApiServer which requires `api-server-port.txt` and optionally `Authorization: Bearer $TOKEN`. The MCP server uses the same auth layer. No new attack surface.
- **Side Effects:** Removing MCP server config from `.vscode/mcp.json` / `.cursor/mcp.json` would break ALL MCP tools for external agents, including workflow coordination tools (`send_message`, `check_inbox`, `start_workflow`, etc.) that have NO skill replacements. The MCP server config MUST remain.
- **Dependencies & Conflicts:** The LocalApiServer and MCP server are both provided by the same VS Code extension. Removing the MCP server dependency is impossible without removing the extension. The plan should frame this as a *preference migration*, not a *removal*.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The plan originally conflated API proxy tools with workflow coordination tools — removing MCP config would break workflow tools with no replacements. (2) Several MCP tools (`resolve_assignees`, `filter_tasks`, time tracking, workspace hierarchy) have no skill equivalents, creating functionality gaps. (3) The migration is actually a preference shift, not an architectural removal, since both MCP server and LocalApiServer come from the same extension. Mitigations: Keep MCP server config intact, scope migration to documentation and agent instructions only, document uncovered MCP tools as future skill candidates.

## Overview
Replace agent invocation patterns for Switchboard MCP API proxy tools with equivalent skill-based implementations that use the LocalApiServer. This is a **preference migration** — the MCP server remains running for workflow coordination tools. Only the ClickUp/Linear/diagram API tool usage patterns change.

**Important scope clarification:** The switchboard MCP server provides TWO categories of tools:
1. **API proxy tools** (in scope): `call_clickup_api`, `clickup_fetch`, `clickup_modify_task`, `clickup_create_task`, `clickup_create_subpage`, `clickup_attach`, `call_linear_api`, `generate_architectural_diagram`
2. **Workflow/messaging tools** (out of scope): `send_message`, `check_inbox`, `get_team_roster`, `start_workflow`, `complete_workflow_phase`, `stop_workflow`, `get_workflow_state`, `run_in_terminal`, `set_agent_status`, `handoff_clipboard`

## MCP Tool to Skill Mapping

| MCP Tool | Skill Replacement | Status | Coverage Gap |
|----------|------------------|--------|--------------|
| `call_clickup_api` | `clickup_api` | ✅ Exists | Full coverage — generic API proxy |
| `clickup_attach` | `clickup_attach` | ✅ Exists | Full coverage |
| `clickup_create_subpage` | `clickup_create_subpage` | ✅ Exists | Full coverage |
| `clickup_create_task` | `clickup_create_task` | ✅ Exists | Full coverage |
| `clickup_fetch` | `clickup_fetch` | ✅ Exists | Full coverage |
| `clickup_modify_task` | `clickup_modify_task` | ✅ Exists | Full coverage |
| `call_linear_api` | `linear_api` | ✅ Exists | Full coverage — GraphQL/REST proxy |
| `generate_architectural_diagram` | `generate_diagram` | ✅ Exists | Full coverage |

### Uncovered MCP Tools (No Skill Equivalent)

The following MCP tools are available via the ClickUp MCP integration but have NO skill-based replacement. Agents needing these operations must continue using MCP tools directly:

| MCP Tool | Function | Notes |
|----------|----------|-------|
| `resolve_assignees` | Convert names/emails to numeric IDs | Critical for task creation/modification |
| `filter_tasks` | Multi-criteria task filtering | Heavily used for task discovery |
| `search` | Universal workspace search | Broad search across tasks/docs |
| `get_task` / `get_task_comments` | Detailed task read | Alternative to `clickup_fetch` |
| `create_task` / `update_task` / `delete_task` | Task CRUD | Alternative to skill equivalents |
| `move_task` / `add_task_to_list` | Task list management | No skill equivalent |
| `add_task_dependency` / `add_task_link` | Task relationships | No skill equivalent |
| `add_tag_to_task` / `remove_tag_from_task` | Tag management | Partially covered by `clickup_modify_task` |
| Time tracking tools (6 tools) | Time management | No skill equivalent |
| Workspace hierarchy tools (7 tools) | Structure management | No skill equivalent |
| Document tools (5 tools) | Doc management | Partially covered by `clickup_create_subpage` |
| Chat/Reminder tools (6 tools) | Communication | No skill equivalent |

## Migration Steps

### 1. Update Agent Instructions to Prefer Skills (NOT Remove MCP Config)
- **DO NOT remove** the switchboard MCP server entry from `.vscode/mcp.json` or `.cursor/mcp.json`
- The MCP server must remain available for workflow coordination tools
- Update `AGENTS.md` (lines 67-91) to add explicit preference guidance: "Prefer skill-based invocations over MCP API proxy tools for ClickUp/Linear/diagram operations"
- Add note: "MCP workflow tools (`send_message`, `check_inbox`, etc.) remain the primary interface for workflow coordination"

### 2. Update .cursorrules MCP Tool Documentation
- File: `.cursorrules` (lines 12-21)
- Clarify that "Available MCP Tools" refers to workflow coordination tools only
- Add section for "Available Skills" listing the API proxy skill replacements
- Remove or deprecate any references to MCP API proxy tools in this file

### 3. Deprecate clickup_mcp.md Skill
- File: `.agent/skills/clickup_mcp.md` (253 lines)
- Add deprecation notice at the top: "⚠️ DEPRECATED: This skill documents MCP tool usage. For new invocations, prefer the skill-based approach using `clickup_api`, `clickup_fetch`, etc."
- Keep the file as a reference for uncovered MCP tools (resolve_assignees, filter_tasks, time tracking, etc.)
- Add cross-reference section listing which skills replace which MCP tools

### 4. Update Technical Documentation
- File: `docs/TECHNICAL_DOC.md` (lines 100-134)
- Add skill-based invocation examples alongside existing MCP tool documentation
- Note that both patterns are supported but skills are preferred
- File: `docs/SECURITY-AUDIT.md` (lines 37-38, 139, 154, 162)
- Update references to `src/mcp-server/register-tools.js` to note that skills provide an alternative path
- File: `docs/terminal_creation_capability.md` (lines 6, 39, 42)
- Update MCP server references to clarify the dual-path architecture

### 5. Update CLIENT_CONFIG.md
- File: `.switchboard/CLIENT_CONFIG.md` (line 17)
- Add note that API proxy tools are also available via skills/LocalApiServer
- Keep MCP config documentation for workflow tool users

### 6. Verify Skills Are Documented in AGENTS.md
- Confirm all skills are listed in the Available Skills table (lines 73-87)
- Verify "replaces" notes are present for each skill (already done — verified present)
- Add explicit "prefer skills over MCP" guidance

### 7. Test Skill Functionality
- Verify LocalApiServer is running (check `.switchboard/api-server-port.txt`)
- Test each skill with a simple operation:
  - `clickup_api`: GET a known task
  - `clickup_fetch`: Resolve a task by name
  - `clickup_modify_task`: Update a test task status
  - `clickup_create_task`: Create a test task in a test list
  - `clickup_create_subpage`: Create a page in a test doc
  - `clickup_attach`: Attach a small test file
  - `linear_api`: Run a simple GraphQL query
  - `generate_diagram`: Generate a flowchart diagram
- Confirm authentication works (VS Code setting `switchboard.apiToken`)

### 8. Document Uncovered MCP Tools as Future Work
- Create a follow-up plan or section listing MCP tools that need skill equivalents
- Priority candidates: `resolve_assignees`, `filter_tasks`, `search`
- These tools are currently only accessible via MCP and have no LocalApiServer endpoint

## Skill Invocation Pattern

Skills use the LocalApiServer via curl commands:

```bash
# Get API server port
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -f "$CUR/.switchboard/api-server-port.txt" ]; do CUR=$(dirname "$CUR"); done
PORT=$(cat "$CUR/.switchboard/api-server-port.txt" 2>/dev/null)

if [ -z "$PORT" ]; then
    echo '{"error": "LocalApiServer not running"}' >&2
    exit 1
fi

# Get auth token (required for write operations)
TOKEN=$(curl -s http://localhost:$PORT/config/token 2>/dev/null || echo "")

# Call skill endpoint (example: clickup_api)
curl -s -X POST http://localhost:$PORT/api/clickup \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "method": "GET",
    "endpoint": "/v2/task/12345",
    "query": {},
    "body": null
  }'
```

## Prerequisites

- LocalApiServer must be running (started by VS Code extension)
- VS Code setting `switchboard.apiToken` configured for ClickUp operations
- Skills are located in `.agent/skills/` directory
- AGENTS.md documents skill usage patterns
- MCP server remains running for workflow coordination tools

## Benefits

- Agents without native MCP support can use skills via shell commands
- Skills are version-controlled with the codebase
- Easier to maintain and update skill implementations
- Consistent invocation pattern across all external integrations
- Removes need for MCP client configuration for API-only use cases

## Limitations

- Skills require LocalApiServer to be running (same dependency as MCP server — both come from the VS Code extension)
- Agents with native MCP support lose direct function-call UX (must construct curl commands)
- Several MCP tools have no skill equivalent (see Uncovered MCP Tools table)
- Both invocation patterns will coexist during transition

## Verification Checklist

- [x] Agent instructions updated to prefer skills over MCP API proxy tools
- [x] `.cursorrules` updated to clarify MCP tool categories
- [x] `clickup_mcp.md` deprecated with redirect notice
- [x] `docs/TECHNICAL_DOC.md` updated with skill-based examples
- [x] `docs/SECURITY-AUDIT.md` references updated
- [x] `docs/terminal_creation_capability.md` references updated
- [x] `.switchboard/CLIENT_CONFIG.md` updated with dual-path note
- [x] MCP server config LEFT INTACT in `.vscode/mcp.json` and `.cursor/mcp.json`
- [ ] LocalApiServer running and accessible *(runtime check — requires VS Code extension active)*
- [x] All skills documented in AGENTS.md with "replaces" notes
- [ ] Test each skill with a simple operation *(runtime check — requires LocalApiServer active)*
- [x] Uncovered MCP tools documented as future work *(documented in plan's Uncovered MCP Tools table; no separate follow-up plan created)*
- [x] Update any workflow documentation that references MCP API proxy tools

## Recommendation
**Send to Coder** — Multi-file documentation changes with moderate risk of agent confusion during transition. No source code changes required; all work is in markdown files and configuration documentation.

---

## Review Pass (2026-05-21)

### Reviewer: Direct in-place reviewer pass

### Findings

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| F1 | `clickup_mcp.md` line 23: stale intro contradicted deprecation notice, referenced `get_tickets.md` without skill-preference framing | MAJOR | **Fixed** — Rewrote intro to frame file as "reference for MCP-only operations" |
| F2 | `clickup_mcp.md` "When to Use" section (lines 26-36): no deprecation qualifiers, encouraged MCP-first usage | MAJOR | **Fixed** — Added `[!IMPORTANT]` callout and `(**no skill equivalent**)` annotations to each bullet |
| F3 | `clickup_mcp.md` "MCP vs LocalApiServer Boundary" section: preference order was backwards (MCP primary, skills secondary) | MAJOR | **Fixed** — Renamed to "Skill-Based vs MCP Tool Boundary", flipped preference order (skills primary, MCP fallback for uncovered ops) |
| F4 | `TECHNICAL_DOC.md` line 102: "Legacy/Alternative" label on MCP tools was misleading for uncovered operations | MAJOR | **Fixed** — Changed to "Alternative / Required for Uncovered Operations" |
| F5 | Plan verification checklist all unchecked despite implementation being substantially complete | NIT | **Fixed** — Updated checklist to reflect actual completion state |
| F6 | `get_tickets.md` referenced in `clickup_mcp.md` but not in AGENTS.md skill registry | NIT | **Fixed** — Added `get_tickets` to AGENTS.md Available Skills table |

### Files Changed During Review

| File | Change |
|------|--------|
| `.agent/skills/clickup_mcp.md` | Rewrote intro (line 23), added deprecation qualifiers to "When to Use" bullets, rewrote "Skill-Based vs MCP Tool Boundary" section with correct preference order |
| `docs/TECHNICAL_DOC.md` | Changed "Legacy/Alternative" to "Alternative / Required for Uncovered Operations" (line 102) |
| `AGENTS.md` | Added `get_tickets` to Available Skills table |
| `.switchboard/plans/replace-mcp-with-skills.md` | Updated verification checklist, added Review Pass section |

### Validation Results

- **Structural verification**: All stale text patterns (`"Use this skill for ClickUp operations via MCP"`, `"MCP Tools.*use for quick lookups"`, `"Legacy/Alternative"`) confirmed removed via grep
- **New text verification**: All replacement patterns (`"Alternative / Required for Uncovered"`, `"reference for MCP-only operations"`, `"Skill-Based vs MCP Tool Boundary"`) confirmed present via grep
- **MCP config integrity**: `.vscode/mcp.json` and `.cursor/mcp.json` confirmed intact (not removed)
- **TypeScript/build checks**: N/A — this plan is documentation-only, no source code changes
- **Runtime skill tests**: Not performed (requires VS Code extension and LocalApiServer to be active)

### Remaining Risks

1. **Runtime skill verification** (Step 7): Skills have not been tested with live API calls. This requires the VS Code extension to be running with `switchboard.apiToken` configured. If skills fail at runtime, agents will fall back to MCP tools, which still work.
2. **Uncovered MCP tools have no follow-up plan**: The priority candidates (`resolve_assignees`, `filter_tasks`, `search`) are documented in this plan but no dedicated plan exists for creating skill equivalents. This is acceptable as future work.
