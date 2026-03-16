# fix false high complexity ratings

## Notebook Plan

plans are being classified as high complexity when their band b is listed as * none. see as example: C:\Users\patvu\Documents\GitHub\switchboard\.switchboard\plans\feature_plan_20260316_065436_change_kanban_headers.md

## Goal
- Clarify expected outcome and scope.
- Ensure plans with an explicitly empty Band B section are classified as **Low** complexity, not **High**.
- Keep the fix narrowly scoped to existing complexity parsing behavior for plan markdown.

## Scope Guardrails
- In scope: false-high complexity classification caused by parsing of `## Complexity Audit` / `Band B`.
- Out of scope: Kanban architecture redesign, workflow changes, DB schema changes, or new complexity categories.

## Cross-Plan Conflict Scan (Kanban + plans folder)
- **Potential overlap:** `feature_plan_20260315_115700_add_complexity_identificaiton_to_get_kanban_state_mcp_tool.md` introduces complexity parsing behavior in MCP output.  
  **Conflict risk:** differing "Band B empty" heuristics between MCP and extension-side parsing.
- **Potential overlap:** `feature_plan_20260316_143021_make_sqlite_db_actually_useful.md` and `feature_plan_20260316_092117_investigate_kanban_complexity_and_potential_to_move_to_sqlite_database_system.md` both push DB-first Kanban reads.  
  **Conflict risk:** stale/incorrect complexity if parser semantics diverge from what is persisted.
- **Adjacent but separate:** `feature_plan_20260316_063407_fix_autoban_issues.md` addresses column/state desync, not complexity parsing semantics.  
  **Conflict risk:** low direct overlap, but both touch card routing outcomes.

**Clarification:** This plan should align existing parser semantics only; it should not introduce a second source-of-truth for complexity.

## Proposed Changes

### Low Complexity Steps (Band A — Routine)
1. **Reproduce and capture the current misclassification**
   - Use `feature_plan_20260316_065436_change_kanban_headers.md` as the baseline reproduction sample.
   - Confirm this plan currently surfaces as High even though `Band B` is `- None`.
   - Record the exact markdown snippet shape that triggers the false positive (especially trailing `**Recommendation**` text after Band B).

2. **Harden Band B extraction boundaries in complexity parsing**
   - Update `getComplexityFromPlan()` in `src/services/KanbanProvider.ts` to ensure the parsed Band B payload only reflects Band B task lines.
   - Prevent trailing recommendation prose from being treated as Band B task content when no heading follows.
   - Keep the existing fallback recommendation check only for plans that do **not** contain a `Complexity Audit` section.
   - **Clarification:** This is behavior alignment, not a new rule. Band B emptiness still maps to Low.

3. **Normalize "empty Band B" markers before meaningful-content checks**
   - Ensure markdown variants like `- None`, `* none`, `- **None**`, `N/A`, or dash-only placeholders are treated as empty.
   - Preserve existing behavior where any real task text in Band B remains High.
   - **Clarification:** No new complexity levels; continue using `Unknown | Low | High`.

4. **Keep downstream behavior unchanged**
   - Do not alter card schema, Kanban column logic, workflow triggers, or agent routing rules.
   - Ensure only the false-high classification path changes.

### High Complexity Steps (Band B — Complex / Risky)
- None

## Verification Plan
1. Run `npm run compile` to confirm no type/build regressions.
2. Validate the sample plan `feature_plan_20260316_065436_change_kanban_headers.md` now resolves to **Low** complexity.
3. Spot-check at least one clearly non-empty Band B plan (for example: `feature_plan_20260316_063407_fix_autoban_issues.md`) still resolves to **High**.
4. Spot-check a plan without `## Complexity Audit` still resolves to **Unknown** (or existing fallback behavior if recommendation-only text is present).
5. Verify no unexpected changes in Kanban card rendering/routing beyond corrected complexity labels.

## Open Questions
- None at this time.
- **Clarification:** If later work updates MCP-side complexity parsing (`register-tools.js`), apply the same empty-Band-B semantics to avoid cross-surface drift.

## Complexity Audit

### Band A — Routine
- Reproduce false-high case using known plan fixture.
- Tighten Band B extraction in existing parser logic.
- Normalize empty markers for Band B.
- Regression verification for Low/High/Unknown outcomes.

### Band B — Complex / Risky
- None
