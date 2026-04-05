# Fix Planner Dependency Checks to Use Kanban State and Filter by Active Status

## Goal
The planner's dependency check in the `/improve-plan` workflow currently instructs agents to "Scan the Kanban board/plans folder for potential cross-plan conflicts." This is problematic because:
1. It leads to trawling the entire `.switchboard/plans/` folder instead of querying structured data
2. It includes plans that are already implemented (Done/Archived), creating noise
3. It doesn't leverage the Kanban database which already tracks plan status

Update the workflow instructions and any related code to use the Kanban database (via MCP tools) or the kanban state skill to efficiently retrieve only active plans (New, Backlog, Planned) for dependency analysis.

## Metadata
**Tags:** backend, bugfix
**Complexity:** 5

## User Review Required
> [!NOTE]
> - No breaking changes to user-facing behavior.
> - The `/improve-plan` workflow documentation will be updated with clearer instructions.
> - Planner agents will now query the Kanban database instead of file scanning when checking dependencies.
> - Implemented plans will be excluded from dependency checks, reducing false-positive conflict detection.

## Complexity Audit

### Routine
- **Workflow documentation update (`improve-plan.md`):** Update the dependency check step to reference MCP tools and status filtering.
- **Rule documentation update (`how_to_plan.md`):** Clarify the dependency check instructions to specify active plan status filters.

### Complex / Risky
- **MCP tool usage verification (RESOLVED — no enhancement needed):** The `get_kanban_state` MCP tool in `src/mcp-server/register-tools.js` (line 2532) already filters to `status = 'active'` plans by default (line 555 of `readKanbanStateFromDb`). It supports optional single-column filtering via the `column` parameter, plus `complexity` and `tag` filters. For dependency checks, agents should call `get_kanban_state` without a column filter to get all active plans grouped by kanban column, then manually inspect only the relevant columns (CREATED, BACKLOG, PLANNED). No code changes to the MCP tool are required.
- **Clarification: Done-column plans with `status = 'active'`:** Plans in the DONE kanban column that have not yet been archived will still have `status = 'active'` in the database and WILL appear in `get_kanban_state` results. The workflow instructions must explicitly tell agents to ignore DONE/REVIEWED/LEAD CODED column results for dependency analysis. This is handled by the proposed instruction text ("DO NOT include plans in Done, Archived, or Cancelled columns").
- **Integration testing:** Since this is a documentation-only change to workflow/rule files, integration testing is primarily manual: run `/improve-plan` on a test plan and verify the dependency section references Kanban database results rather than file system scan results.

## Edge-Case & Dependency Audit
- **Race Conditions:** None. Dependency checks are read-only operations against the Kanban database.
- **Security:** None. No new authentication or permission logic required.
- **Side Effects:** Plans that were recently moved to "Done" but not yet archived might still appear in memory. The MCP tool should query the database for ground truth.
- **Dependencies & Conflicts:**
  - Depends on the Kanban database being properly synchronized with plan files.
  - Should coordinate with any ongoing work on Kanban MCP tools or the kanban state skill.
  - **`feature_plan_20260314_203543_consolidate_enhance_and_challenge_workflows.md`** — This plan created `improve-plan.md`. Since `improve-plan.md` already exists in the codebase, this plan is likely already implemented. Low conflict risk, but verify the current content of `improve-plan.md` line 21 matches the search string in Change #1 below before applying.
  - **`feature_plan_20260311_224739_improve_how_to_plan_guide.md`** and **`feature_plan_20260311_134115_add_apendix_to_how_to_plan_guide.md`** — Both may modify `.agent/rules/how_to_plan.md`. If either is applied before this plan, the search string in Change #2 below (line 15 of `how_to_plan.md`) may no longer match. Verify before applying.
  - **`add-complexity-scoring-to-agents.md`** — Modifies `AGENTS.md` only. No overlap with files modified by this plan. No conflict.

## Adversarial Synthesis

### Grumpy Critique
> *Slams coffee mug*
>
> Oh brilliant, so we've been telling planners to "scan the folder" like it's 1995 and we don't have a database. Let me list the ways this plan needs to not be naive:
>
> 1. **Which MCP tool exactly?** The plan vaguely says "use MCP tools" but doesn't specify which tool. `get_kanban_state`? A new tool? Do we need to add status filtering to an existing tool?
>
> 2. **What about the skill?** The user mentioned "kanban state skill" but skills are invoked differently than MCP tools. The instructions need to be crystal clear about when to use `skill: "kanban"` vs calling an MCP tool directly.
>
> 3. **Status enumeration hardcoding:** "New, Backlog, Planned" — what if someone renames these columns? What if they add "In Review"? Hardcoding status names in workflow docs is fragile.
>
> 4. **Fallback behavior:** If the MCP tool fails or the database is out of sync, does the planner fall back to file scanning? If so, the filtering instruction becomes critical.
>
> 5. **Database schema knowledge:** The planner needs to know which column in the database corresponds to "active" plans. Is it a `status` column? `kanban_column`? The instructions must specify.

### Balanced Response
Valid concerns addressed:

1. **Specific MCP tool (VALID — SPECIFIED AND VERIFIED):** The `get_kanban_state` MCP tool exists in `src/mcp-server/register-tools.js` (line 2532) and already filters to `status = 'active'` plans by default via `readKanbanStateFromDb` (line 555). It supports optional `column`, `complexity`, and `tag` filters. For dependency checks, calling it without a column filter returns all active plans grouped by kanban column — no tool enhancement needed. The workflow explicitly names the tool/skill to invoke.

2. **Skill vs MCP tool clarity (VALID — CLARIFIED):** Instructions will differentiate: use the kanban state skill when running as a Switchboard agent, use the MCP tool when running as an external planner.

3. **Status enumeration (VALID — MITIGATED):** While we reference specific Kanban columns, the instructions will be written as "active Kanban columns (e.g., New, Backlog, Planned)" allowing for configuration. A code-level config for "active status columns" is out of scope for this fix but noted as future enhancement.

4. **Fallback behavior (VALID — ADDRESSED):** The workflow will specify: if database query fails, do NOT fall back to unfiltered file scanning. Instead, document the uncertainty in the plan's dependency section.

5. **Database schema (VALID — SPECIFIED):** The Kanban schema uses a `kanban_column` field that maps to column names. The MCP tool/skill abstracts this detail.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Complete code blocks with exact search/replace targets.

### 1. Update `improve-plan.md` Workflow - Dependency Check Step

#### [MODIFY] `.agent/workflows/improve-plan.md`
- **Context:** Step 1 of the workflow currently tells planners to "Scan the Kanban board/plans folder" which is ambiguous and leads to file system trawling including implemented plans.
- **Logic:** Replace the vague scanning instruction with specific guidance to use the Kanban database via MCP tools or skills, and filter to only active statuses.
- **Implementation:**

Search (lines 18-22):
```markdown
1. **Load the plan and verify dependencies**
   - Read the target plan file and treat it as the single source of truth.
   - Read the actual code for any services, utilities, or modules referenced by the plan.
   - Scan the Kanban board/plans folder for potential cross-plan conflicts and document them.
```

Replace:
```markdown
1. **Load the plan and verify dependencies**
   - Read the target plan file and treat it as the single source of truth.
   - Read the actual code for any services, utilities, or modules referenced by the plan.
   - **Query active Kanban plans for dependencies (DO NOT scan the plans folder directly):**
     - **If running as a Switchboard agent:** Use `skill: "kanban"` to get the current Kanban state, filtering to plans in active columns (New, Backlog, Planned).
     - **If running via MCP:** Call the `get_kanban_state` MCP tool, filtering to plans with `kanban_column` in active statuses (New, Backlog, Planned).
     - **DO NOT include plans in Done, Archived, or Cancelled columns** — these are already implemented and irrelevant for dependency/conflict analysis.
     - Document any cross-plan conflicts with the active plan set only.
     - **If the database query fails:** Do not fall back to unfiltered file scanning. Instead, note the uncertainty in the `## Edge-Case & Dependency Audit` section under `Dependencies & Conflicts`.
```

- **Edge Cases Handled:** 
  - Distinguishes between skill usage (Switchboard context) and MCP tool usage (external context)
  - Explicitly excludes Done/Archived/Cancelled plans
  - Prevents unfiltered fallback to file scanning
  - Documents uncertainty if database is unavailable

### 2. Update `how_to_plan.md` - Dependency Audit Section

#### [MODIFY] `.agent/rules/how_to_plan.md`
- **Context:** The Step 2 "Dependencies & Conflicts" bullet point currently mentions "pending plans" but doesn't specify how to identify them or exclude implemented plans.
- **Logic:** Clarify that dependency checks should use the Kanban database and only consider plans in active columns.
- **Implementation:**

Search (line 15):
```markdown
*   **Dependencies & Conflicts:** Identify if this plan relies on other pending plans in the Kanban board, or if it will conflict with concurrent work.
```

Replace:
```markdown
*   **Dependencies & Conflicts:** 
    - Query the Kanban database (via `get_kanban_state` MCP tool or kanban state skill) to identify active plans.
    - Only consider plans in active columns (New, Backlog, Planned) — exclude Done, Archived, and Cancelled plans.
    - Identify if this plan relies on other active plans or conflicts with concurrent work.
    - If database query fails, document the uncertainty rather than scanning unfiltered.
```

- **Edge Cases Handled:**
  - Explicitly names the tool/skill to use
  - Specifies which statuses to include/exclude
  - Prevents unfiltered file scanning on failure

## Verification Plan

### Automated Tests
- **New test in `src/test/planner-dependency.test.ts` (create if not exists):**
  - Test: `dependency check queries kanban database not filesystem`
  - Mock `get_kanban_state` to return plans in various columns
  - Verify that Done/Archived plans are excluded from conflict analysis
  - Verify that New/Backlog/Planned plans are included

- **New test:** `dependency check handles database failure gracefully`
  - Simulate MCP tool failure
  - Verify that planner documents uncertainty rather than falling back to file scanning

### Manual Verification
1. Run `/improve-plan` on a test plan in the Kanban
2. Verify in the output that the dependency section only references plans in New/Backlog/Planned columns
3. Verify that Done/Archived plans are not mentioned in dependency analysis
4. Check that the plan includes a note about using Kanban database query rather than folder scanning

### Documentation Review
- [ ] `improve-plan.md` updated with specific tool/skill instructions
- [ ] `how_to_plan.md` updated with status filtering guidance
- [ ] Example plan output reviewed to confirm no implemented plans appear in dependency checks

## Implementation Review

**Reviewer:** Copilot (direct reviewer pass)
**Date:** 2025-07-18

### Stage 1 — Grumpy Principal Engineer

> *Adjusts reading glasses, opens the actual source code*
>
> Oh wonderful. Someone wrote a plan referencing column names that **don't exist in the codebase**. Let me enumerate the carnage:
>
> 1. **CRITICAL — Skill name `"kanban"` does not exist.** The `improve-plan.md` told agents to invoke `skill: "kanban"`. The actual skill directory is `.agent/skills/get_kanban_state/`. Every agent following this instruction would fail to load the skill. This is not a minor naming preference — it's a broken reference.
>
> 2. **CRITICAL — "Backlog" column is a fabrication.** Both docs referenced "New, Backlog, Planned" as active columns. The actual built-in Kanban columns defined in `register-tools.js:321-329` are: CREATED (New), PLAN REVIEWED (Planned), INTERN CODED (Intern), LEAD CODED (Lead Coder), CODER CODED (Coder), CODE REVIEWED (Reviewed), COMPLETED (Completed). There is **no Backlog column**. An agent filtering to "Backlog" would find zero plans and silently miss real dependencies.
>
> 3. **MAJOR — Exclusion list "Done, Archived, Cancelled" references phantom columns.** There is no "Done" column (it's "COMPLETED"/"Completed"). There is no "Archived" column. There is no "Cancelled" column. The exclusion list was invented from thin air. An agent trying to exclude "Done" would match nothing and include everything.
>
> 4. **MAJOR — Coding-stage plans completely ignored.** Plans in INTERN CODED, LEAD CODED, CODER CODED, and CODE REVIEWED columns represent active concurrent work — the exact thing dependency checks should catch. By listing only "New, Backlog, Planned" as active columns, the docs would tell agents to ignore plans currently being implemented. That defeats the entire purpose.
>
> 5. **MAJOR — Unnecessary skill/MCP distinction adds confusion.** The `improve-plan.md` split instructions into "If running as a Switchboard agent: use skill" vs "If running via MCP: use tool." The `get_kanban_state` skill's own SKILL.md says "Call the `get_kanban_state` MCP tool." The skill IS a wrapper around the MCP tool. Two divergent instruction paths for the same operation is a recipe for agents picking the wrong one.
>
> 6. **NIT — `how_to_plan.md` used vague "kanban state skill" phrasing** without specifying the exact skill name `get_kanban_state`, which creates ambiguity when multiple kanban-related tools exist.

### Stage 2 — Balanced Synthesis

Findings #1-#5 are validated by direct source inspection and required immediate correction:

1. **Skill name (CRITICAL — FIXED):** Removed the broken `skill: "kanban"` reference entirely. The `get_kanban_state` MCP tool is the canonical interface (the skill's own docs say to call the MCP tool). Eliminated the unnecessary skill-vs-MCP fork to provide a single, unambiguous instruction.

2. **Column names (CRITICAL — FIXED):** Replaced fabricated "Backlog" with actual column labels from `BUILTIN_KANBAN_COLUMN_DEFINITIONS`: New, Planned, Intern, Lead Coder, Coder, Reviewed, Completed.

3. **Exclusion list (MAJOR — FIXED):** Changed "Done, Archived, Cancelled" to "Completed" — the only built-in terminal column. The `get_kanban_state` tool already filters to `status = 'active'`, so truly archived plans won't appear; only COMPLETED-column plans that haven't been archived yet need explicit exclusion.

4. **Coding-stage inclusion (MAJOR — FIXED):** Updated both docs to explicitly list in-progress columns (Intern, Lead Coder, Coder, Reviewed) as relevant for conflict analysis alongside pre-implementation columns (New, Planned).

5. **Skill/MCP distinction (MAJOR — FIXED):** Collapsed into a single instruction: "Call the `get_kanban_state` MCP tool." Removed the dual-path confusion.

6. **Vague skill reference (NIT — FIXED):** `how_to_plan.md` now explicitly names the `get_kanban_state` MCP tool.

### Files Modified
- `.agent/workflows/improve-plan.md` — Lines 19-24: Replaced dual skill/MCP instruction with single `get_kanban_state` MCP tool call; corrected column names; fixed exclusion list.
- `.agent/rules/how_to_plan.md` — Lines 15-19: Corrected column names; specified exact tool name; fixed exclusion list.

### Verdict
The original implementation contained **2 CRITICAL** and **3 MAJOR** defects — all caused by referencing column/skill names that don't exist in the codebase. All findings have been corrected. The documentation is now factually accurate against the source of truth (`register-tools.js:321-329`).
