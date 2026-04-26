# How to Plan: The Switchboard Standard

**🚨 STRICT DIRECTIVE FOR AI AGENTS 🚨**
Do NOT skip straight to writing code or outputting a generic implementation plan. You must perform internal cognitive reasoning first. To guarantee this, you must output your plan EXACTLY matching the "Plan Template" at the bottom of this document. The template requires you to simulate an internal adversarial review before you write the proposed changes.

Follow these steps sequentially to formulate your plan:

## Step 1: Understand the Goal
Identify the core problem or feature. Clarify what success looks like. If the user's request is ambiguous, stop and ask clarifying questions before generating a plan.

## Step 2: Complexity, Edge-Case & Dependency Audit
Before writing any implementation steps, audit the system:
*   **Complexity:** Rate the routine vs. complex/risky parts of the request.
*   **Edge Cases:** Identify race conditions, security flaws, backward compatibility issues, and side effects.
*   **Dependencies & Conflicts:** 
    - Query the Kanban database via the `get_kanban_state` MCP tool (no column filter) to retrieve all active plans.
    - Consider plans in **New** and **Planned** columns for dependencies and conflicts. Exclude plans in Completed, Intern, Lead Coder, Coder, and Reviewed columns — these are already implemented.
    - Identify if this plan relies on other active plans or conflicts with concurrent work.
    - If database query fails, document the uncertainty rather than scanning unfiltered.

## Step 3: Improve Plan (`/improve-plan`)
Audit the strategy and stress-test the assumptions:
- Identify missing pieces, implicit dependencies, or assumptions that need hardening
- Decompose large changes into Routine and Complex/Risky tasks
- **Grumpy Persona**: Aggressively critique every assumption. Find edge cases, race conditions, missing error handling, and scope creep.
- **Balanced Persona**: Synthesize the critique and finalize the plan.

## Step 4: The Implementation Spec (Plan Template)
Output your final plan using the exact Markdown structure below. **You must include every section.**

## 5. Exhaustive Implementation Spec
Produce a complete, copy-paste-ready implementation spec. You must maximize your context window to provide the highest level of detail possible. Include:
- Exact search/replace blocks or unified diffs for EVERY file change.
- **NO TRUNCATION:** You are strictly forbidden from using placeholders like `// ... existing code ...`, `// ... implement later`, `TODO`, or omitted middle sections for modified code. Write the exact, final state of the functions or blocks being changed.
- Deep logical breakdowns explaining the *Why* behind each architectural choice before code.
- Inline comments explaining non-obvious logic.

---

# [Plan Title]

## Goal
[1-2 sentences summarizing the objective]

## Metadata
**Tags:** [comma-separated list chosen ONLY from: frontend, backend, authentication, database, UI, UX, devops, infrastructure, bugfix, documentation, reliability, workflow, testing, security, performance, analytics]
**Complexity:** [integer 1-10]
**Repo:** [bare sub-repo folder name matching a workspace root, e.g. 'be'. Omit if not applicable.]

*(Scoring guide: 1-2: Very Low — trivial config/copy changes. 3-4: Low — routine single-file changes. 5-6: Medium — multi-file changes, moderate logic. 7-8: High — new patterns, complex state, security-sensitive. 9-10: Very High — architectural changes, new framework integrations)*

## User Review Required
> [!NOTE]
> [Any user-facing warnings, breaking changes, or manual steps required]

## Complexity Audit
### Routine
- [List routine, safe changes]
### Complex / Risky
- [List complex logic, state mutations, or risky changes]

## Edge-Case & Dependency Audit
- **Race Conditions:** [Analysis]
- **Security:** [Analysis]
- **Side Effects:** [Analysis]
- **Dependencies & Conflicts:** [Human-readable prose: explain WHY each dependency or conflict matters. Reference plans by their session IDs (sess_XXXXXXXXXXXXX) so the machine parser can link them. Use the `get_kanban_state` MCP tool to retrieve active session IDs.]

## Dependencies
> [!IMPORTANT]
> **Machine-readable.** One dependency per line. Format: `sess_XXXXXXXXXXXXX — <topic>`. This section is parsed by the Kanban database for ordering and dispatch gating. If this plan has no cross-plan dependencies, write a single line: `None`.

Example:
```
sess_1776554943477 — Refactor Research Modal Sync State and Implicit Imports
sess_1776555843399 — Notion Page Hierarchy Filtering for Research Modal
```

## Adversarial Synthesis
### Grumpy Critique
[Simulate the Grumpy Engineer: Attack the plan's weaknesses, missing error handling, and naive assumptions.]

### Balanced Response
[Simulate the Lead Developer: Address Grumpy's concerns and explain how the implementation steps below have been adjusted to prevent them.]

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### [Target File or Component 1]
#### [MODIFY / CREATE / DELETE] `path/to/file.ext`
- **Context:** [Explain exactly why this file needs to be changed]
- **Logic:** [Provide a granular, step-by-step breakdown of the logical changes required]
- **Implementation:** [Provide the complete code block, unified diff, or full function rewrite without truncation. Choose ONE primary format per change.]
- **Edge Cases Handled:** [Explain how the code above mitigates the risks identified in the Edge-Case Audit]

### [Target File or Component 2]
...

---

### Formatting Multiple Plans (Clipboard Import / NotebookLM)
When generating multiple plans in a single response, you MUST use plan markers to delimit each plan so they can be automatically split and imported into the Kanban board.

- Before each plan, add an exact marker line: `### PLAN N START` (H3, where N is the plan number). The importer matches the regex `^###\s*PLAN\s*\d+\s*START\s*$`, so the three hashes, the word `PLAN`, the integer, and `START` must all be present on their own line.
- The plan's H1 title (`# Title`) must immediately follow the marker. The importer extracts the title with `^#\s+(.+)$` (first H1 match, multiline).
- Do not indent the marker or title, and do not wrap them in a code fence inside the actual response — fences here are used only so this documentation renders the literal syntax.

**Example (literal syntax — do not copy the surrounding fence):**

~~~markdown
### PLAN 1 START
# First Plan Title
[Full plan content following the template above]

### PLAN 2 START
# Second Plan Title
[Full plan content following the template above]
~~~

When Switchboard imports this content, it slugifies each H1 title (lowercase, non-alphanumeric runs collapsed to `_`) and writes one file per plan into `.switchboard/plans/` using the pattern `feature_plan_<YYYYMMDD_HHMMSS>_<slug>.md`. For the example above the outputs look like:
- `feature_plan_20260417_101500_first_plan_title.md`
- `feature_plan_20260417_101501_second_plan_title.md`

(Timestamps reflect the moment of import, so exact values will differ.)

## Verification Plan
### Automated Tests
- [What existing or new tests need to be run/written?]
