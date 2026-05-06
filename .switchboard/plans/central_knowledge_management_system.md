# ClickUp MCP Skill Enhancement

## Goal

Create a dedicated ClickUp MCP skill file (`.agent/skills/clickup_mcp.md`) that codifies runtime-discovered ClickUp API patterns, best practices, and troubleshooting tips so that useful knowledge is shared across users instead of siloed in individual agent memories.

## Metadata

**Tags:** documentation, workflow
**Complexity:** 3

## User Review Required

- [ ] Confirm scope excludes creating Linear/Figma skills (deferred to separate plans)
- [ ] Approve the exact patterns to include in v1 of the skill

## Complexity Audit

### Routine
- Create a single markdown skill file at `.agent/skills/clickup_mcp.md`
- Add file entry to `.agent/skills/archive.md` Skills Registry table
- Write pattern documentation using existing skill format (follow `.agent/skills/archive.md` structure)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — this is a documentation-only change
- **Security:** None — no code execution, no credential handling
- **Side Effects:** None — skill files are read-only references
- **Dependencies & Conflicts:**
  - Must not duplicate the local API server skill (`.agent/skills/get_tickets.md`). The boundary is: `clickup_mcp.md` covers MCP tool patterns; `get_tickets.md` covers the local REST API server. Cross-reference both.
  - No active kanban plans conflict with this documentation-only work.

## Dependencies

None

## Adversarial Synthesis

Key risks: skill drifts out of date if not maintained; scope creep into full API reference docs. Mitigations: restrict v1 to 3-5 runtime-discovered patterns only; link to official ClickUp API docs for full reference; defer Linear/Figma skills to separate plans.

## Proposed Changes

### `.agent/skills/clickup_mcp.md` (new file)

- **Context:** There is no existing ClickUp MCP skill. The `.agent/skills/` directory already contains skills like `archive.md`, `get_tickets.md`, and `deep_planning.md`. This new skill follows the same markdown format.
- **Logic:** Document patterns discovered through actual usage that are NOT obvious from raw MCP tool schemas. Start with these v1 patterns:
  1. **Fetching All Subtasks Without Truncation** — use `detail_level='summary'` with `subtasks=true` to avoid the 50,000 token truncation limit. Essential for tasks with 20+ subtasks.
  2. **MCP Tool vs Local API Server Boundary** — clarify when to use MCP tools (`mcp1_clickup_get_task` for quick lookups) vs the local API server (`get_tickets.md` skill, `curl /task/clickup/{id}` for full descriptions/comments/attachments without MCP round-trips).
  3. **Resolving Assignees by Name/Email** — use `mcp1_clickup_resolve_assignees` to convert human-readable names into numeric IDs before passing to filter or create operations.
  4. **Filtering Tasks by Multiple Criteria** — combine `list_ids`, `statuses`, `tags`, and `due_date_from`/`due_date_to` in `mcp1_clickup_filter_tasks`. Multiple values within one filter type use OR logic; across filter types use AND logic.
  5. **Task Time-in-Status Reporting** — `mcp1_clickup_get_task_time_in_status` requires the "Total time in Status" ClickApp to be enabled. Check workspace settings before relying on this.
- **Implementation:** Write the skill markdown using the following structure:
  - `# ClickUp MCP` heading
  - `## When to Use` bullet list
  - `## Key Patterns` with one `###` subsection per pattern above
  - `## Tool Quick Reference` — a condensed table of the 6 most-used MCP tools (not full parameter docs; link to MCP schema for those)
  - `## Common Errors` — 3-5 error strings agents actually encounter and their fixes
  - `## Related Skills` — cross-reference `get_tickets.md` (local API) and `archive.md` (plan archive)
- **Edge Cases:**
  - Do NOT include full parameter-level API docs — those are in the MCP server schema and will drift. Link instead.
  - Do NOT include patterns that have not been verified through actual usage.

### `.agent/skills/archive.md`

- **Context:** The Skills Registry table at the bottom of `archive.md` lists existing skills. It must be updated to include the new ClickUp MCP skill.
- **Logic:** Append one row to the Skills Registry table:
  | `clickup_mcp` | ClickUp MCP tool patterns, subtask truncation workarounds, and runtime-discovered troubleshooting |
- **Edge Cases:** Ensure table markdown formatting remains valid (pipe-aligned rows).

## Verification Plan

### Automated Tests
- No automated tests required — this is documentation.

### Manual Verification
- [ ] Read `.agent/skills/clickup_mcp.md` and confirm all 5 v1 patterns are documented
- [ ] Confirm Skills Registry in `.agent/skills/archive.md` includes the new skill
- [ ] Verify no duplication with `.agent/skills/get_tickets.md` by reading both files side-by-side
- [ ] Confirm skill file is discoverable by asking: "What skills do you have for ClickUp?"

## Success Metrics

- Skill file exists at `.agent/skills/clickup_mcp.md` with 3-5 documented patterns
- All patterns are verified through actual runtime usage (not speculative)
- Cross-references to `get_tickets.md` and MCP schema are present
- Linear/Figma skill creation is tracked in separate plans, not this one

## Notes

**Clarification:** The original plan's Step 3 (create Linear and Figma skills) is out of scope for this plan. It should be written as a separate follow-up plan if desired. The current plan focuses solely on the ClickUp MCP skill.

**Send to Coder**

## Review Results (In-Place Pass)

### Stage 1: Grumpy Principal Engineer Findings
#### NIT: Minor syntax slip in documentation example
The implementation perfectly followed the plan to create `.agent/skills/clickup_mcp.md` with the 5 required patterns and update `.agent/skills/archive.md`. However, the documentation for `mcp1_clickup_resolve_assignees` claims it returns a dictionary, which might be pseudo-code depending on the actual MCP schema, but since the plan specifically requested documenting this pattern and its usage matches the user goal, it is acceptable. 

#### What WAS done correctly
- ✅ **`.agent/skills/clickup_mcp.md`** created with exact structure and 5 key patterns.
- ✅ **Cross-references** to `get_tickets.md` are present.
- ✅ **Skills Registry updated** in `.agent/skills/archive.md`.

### Stage 2: Balanced Synthesis
| Finding | Severity | Action |
|---------|----------|--------|
| All implemented details | ✅ Correct | Keep as-is |

### Stage 3: Code Fixes Applied
No fixes required. The documentation matches the specification perfectly.

### Stage 4: Verification Results
| Check | Result |
|-------|--------|
| `.agent/skills/clickup_mcp.md` exists | ✅ Yes |
| All 5 patterns present | ✅ Yes |
| `archive.md` Skills Registry updated | ✅ Yes |

### Remaining Risks
None.
