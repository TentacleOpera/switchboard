# Fix PLANNED Column Guards Use Source Column Instead of Destination

## Goal
Fix the bug where clicking "Copy prompt and advance" from the PLANNED column generates a review prompt instead of a coding prompt. The PLAN REVIEWED special-case guards are checking the wrong column variable.

## Metadata
- **Tags:** bugfix, backend, workflow
- **Complexity:** 2

## User Review Required
None — this is a targeted single-file bugfix with no user-visible API or configuration changes.

## Complexity Audit

### Routine
- Single file change in `src/services/KanbanProvider.ts`
- Updates one existing guard condition to use the correct variable (`column` instead of `roleSourceColumn`)
- Preserves all existing role resolution logic
- No new state, no new interfaces, no schema changes
- The three-layer guard chain (lines 2764, 2774, 2783) remains intact; only the condition expression in the first guard changes

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- None — this is a pure synchronous condition check inside `_generatePromptForColumn`. No shared mutable state is affected.

### Security
- None — no user-input parsing or privilege boundaries.

### Side Effects
- **After the fix, line 2764's null-assignment fires earlier** (for all non-PLAN-REVIEWED destinations when source is PLAN REVIEWED). However this is immediately corrected by the kind-based switch at line 2786 for non-`coded` destinations. The downstream `_generatePromptForDestinationRole` call is unaffected for the reviewer/tester/planner paths.
- Lines 2774 and 2783 remain redundant but benign; they continue to serve as defensive guards for the `coded`-kind destination path.

### Dependencies & Conflicts
- The predecessor fix `fix_prompt_generation_uses_source_column_instead_of_destination.md` introduced `roleSourceColumn = destinationColumn || column` at line 2752, which is the root cause of this bug. This fix is a direct follow-on to that change.
- No other callers of `_generatePromptForColumn` are affected — the function signature and return type are unchanged.

## Bug Description
When plans are in the PLANNED column (internal ID: `PLAN REVIEWED`) and the user clicks the column-level "Copy prompt and advance" button, the system incorrectly generates a code review prompt for the reviewer role instead of an execution prompt for the coder/lead role with complexity routing.

## Root Cause
**File:** `src/services/KanbanProvider.ts`  
**Lines:** 2738-2806

The previous fix (`fix_prompt_generation_uses_source_column_instead_of_destination.md`) changed line 2752 to use the destination column for role resolution:
```typescript
const roleSourceColumn = destinationColumn || column;
```

However, the PLAN REVIEWED special-case guard at line 2764 was not updated to account for this change. It checks:
```typescript
if (roleSourceColumn === 'PLAN REVIEWED')  // ← BUG: This is now the destination column
```

When advancing from PLANNED to LEAD CODED:
- `column` = "PLAN REVIEWED" (source)
- `destinationColumn` = "LEAD CODED" (destination)
- `roleSourceColumn` = "LEAD CODED" (due to line 2752)
- The guard fails because `roleSourceColumn !== 'PLAN REVIEWED'`
- Falls through to `case 'coded': role = 'reviewer';` at line 2788
- Result: review prompt instead of coding prompt

The guard should check the original `column` parameter (the source column), not `roleSourceColumn` (the destination column).

## Dependencies
- None — single-file fix with no cross-file dependencies.
- *Clarification:* The companion fix `fix_prompt_generation_uses_source_column_instead_of_destination.md` is a prerequisite context item (already merged) not a runtime dependency.

## Adversarial Synthesis
Key risk: the fix at line 2764 sets `role = null` for ALL non-PLAN-REVIEWED destinations when source is PLAN REVIEWED, which is slightly broader than the existing line 2774 guard (which only fires for `coded`-kind destinations). This over-nulling is safe because the kind-based switch at line 2786 immediately reassigns the correct role for non-coded destinations. The three redundant guard layers create maintenance debt but pose no correctness risk for this change. A follow-up cleanup to consolidate lines 2764/2774/2783 into a single authoritative guard would reduce confusion but is explicitly out of scope.

## Proposed Changes

### `src/services/KanbanProvider.ts` — `_generatePromptForColumn` (line 2764)

**Context:** The function resolves which agent role should receive the generated prompt when the user clicks "Copy prompt and advance." Lines 2761–2797 form a multi-layer guard chain that special-cases the PLAN REVIEWED column.

**Logic:** Line 2764 is the first guard. It should fire when the *source* column is PLAN REVIEWED and the destination is not PLAN REVIEWED (i.e., we are dispatching to an implementation agent). After the predecessor fix, `roleSourceColumn` holds the *destination*, so the guard never fires from PLAN REVIEWED.

**Implementation:**

Change the condition at line 2764 from `roleSourceColumn` to `column`:

```typescript
// Before (line 2764):
if (roleSourceColumn === 'PLAN REVIEWED' && destinationColumn !== 'PLAN REVIEWED') {

// After (line 2764):
if (column === 'PLAN REVIEWED' && destinationColumn !== 'PLAN REVIEWED') {
```

No other lines require changes.

**Edge Cases:**
- If `destinationColumn` is undefined (column-level button with no explicit destination), `roleSourceColumn` equals `column`, so the guard would also fire correctly for the `column === 'PLAN REVIEWED'` case — no regression.
- Lines 2774 and 2783 continue to reinforce the same invariant for `coded`-kind destinations. No changes needed there.

## Verification Plan

### Automated Tests
- No existing automated tests for this function path.
- *Follow-up recommendation:* Add a unit test for `_generatePromptForColumn` covering: source=PLAN REVIEWED + destination=LEAD CODED (must produce execution/complexity-routed prompt), source=PLAN REVIEWED + destination=CODER CODED (same), source=CODER CODED + destination=undefined (must produce review prompt). This would prevent regressions from future guard chain modifications.

### Manual Verification
1. **PLANNED column → execution prompt (core fix):**
   - Move a plan to the PLANNED column.
   - Click "Copy prompt and advance" at the top of the PLANNED column.
   - Paste clipboard content.
   - **Expected:** Prompt contains execution instructions ("Implement the changes"), NOT review instructions ("Review the code").

2. **Regression — CREATED column → planner prompt:**
   - Click copy prompt on CREATED column → prompt must be a planner prompt.

3. **Regression — LEAD CODED column → reviewer prompt:**
   - Click copy prompt on LEAD CODED column → prompt must be a code review prompt.

4. **Regression — CODE REVIEWED column → tester prompt:**
   - Click copy prompt on CODE REVIEWED column → prompt must be a tester/QA prompt.

5. **Complexity routing (if enabled):**
   - Enable dynamic complexity routing in settings.
   - Place a high-complexity plan (score 7+) in PLANNED → click copy; **Expected:** routes to LEAD CODED.
   - Place a low-complexity plan (score 1-6) in PLANNED → click copy; **Expected:** routes to CODER CODED.

---

**Recommendation: Send to Intern** (Complexity 2 — single-line targeted fix, well-understood invariant, no new patterns)

---

## Reviewer Pass (2026-05-23)

### Files Changed
- `src/services/KanbanProvider.ts` — two guards corrected (line 2764 per original plan, line 2802 via reviewer catch)

### Stage 1 — Grumpy Findings

| Severity | Finding |
|---|---|
| **MAJOR** | **Final fallback at line 2802 used `roleSourceColumn` (destination) instead of `column` (source).** `columnToPromptRole('LEAD CODED')` returns `'reviewer'` — silently overriding the `role = null` maintained by lines 2764/2774/2783, reintroducing the exact review-prompt-instead-of-coding-prompt symptom the plan was meant to fix. The original plan's claim "no other lines require changes" was incorrect. |
| **NIT** | Plan doc's Adversarial Synthesis and Side Effects sections did not enumerate the final fallback as a risk vector, despite it being directly in the critical path. |
| **NIT** | Lines 2774 and 2783 remain redundant guards — correctly noted as deferred maintenance debt. |

### Stage 2 — Balanced Synthesis

- **Keep:** Line 2764 fix (`column === 'PLAN REVIEWED'`) is correct and complete.
- **Fixed:** Line 2802 guard changed from `roleSourceColumn !== 'PLAN REVIEWED'` to `column !== 'PLAN REVIEWED'`, so the legacy mapper is blocked when PLAN REVIEWED is the *source*, regardless of what the destination is.
- **Defer:** Consolidation of lines 2764/2774/2783 into a single authoritative guard — maintenance cleanup, no correctness impact.

### Additional Fix Applied

**`src/services/KanbanProvider.ts`, line 2802** (final fallback guard):

```typescript
// Before:
if (!role && roleSourceColumn !== 'PLAN REVIEWED') {
    role = columnToPromptRole(roleSourceColumn);
}

// After:
if (!role && column !== 'PLAN REVIEWED') {
    role = columnToPromptRole(roleSourceColumn);
}
```

**Why this matters:** With `roleSourceColumn = destinationColumn || column`, when source=PLAN REVIEWED and dest=LEAD CODED, `roleSourceColumn` is `'LEAD CODED'`. The original guard `roleSourceColumn !== 'PLAN REVIEWED'` evaluates TRUE, enters the fallback, and `columnToPromptRole('LEAD CODED')` returns `'reviewer'` — overriding `role = null`. Using `column !== 'PLAN REVIEWED'` correctly gates on the source column identity.

### Validation Results

```
webpack 5.105.4 compiled successfully in 11180 ms
```
- No TypeScript type errors.
- No runtime test suite exists for this function path (pre-existing gap, noted in plan).

### Remaining Risks

- No automated test coverage for `_generatePromptForColumn`. The three guard layers and fallback chain are complex enough that a regression could go undetected. Follow-up unit tests remain strongly recommended (see Verification Plan above).
- Lines 2774 and 2783 are redundant — future maintainers may remove them without understanding they were safety nets. Consolidation follow-up would reduce this risk.
