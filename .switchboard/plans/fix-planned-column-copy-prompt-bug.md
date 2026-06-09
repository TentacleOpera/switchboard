# Fix PLANNED Column Copy Prompt Bug

## Goal
Fix the bug where clicking the "Copy prompt and advance" button on the PLANNED (PLAN REVIEWED) column generates a code review prompt instead of the correct coder/lead execution prompt.

## Metadata
- **Tags:** bugfix, frontend, backend
- **Complexity:** 2

## User Review Required

None — this is a targeted single-file bugfix with no user-visible API or configuration changes.

## Complexity Audit

### Routine
- Single file change in `KanbanProvider.ts`
- Adds one guard clause inside an existing `if (!role && roleSourceDef)` block
- Preserves all existing switch-case behavior for every other column transition
- No new state, no new interfaces, no schema changes

### Complex / Risky
- None

## Bug Description
When plans are in the PLANNED column (internal ID: `PLAN REVIEWED`) and the user clicks the column-level "Copy prompt and advance" button, the system incorrectly generates a code review prompt for the reviewer role instead of an execution prompt for the coder/lead role with complexity routing.

This happens because `_generatePromptForColumn` in `KanbanProvider.ts` has a kind-based fallback that assigns `role = 'reviewer'` for columns with `kind: 'coded'`, which **defeats an existing guard** (lines 2737-2741) that already attempts to set `role = null` for this transition.

## Root Cause
**File:** `src/services/KanbanProvider.ts`  
**Lines:** 2737-2754

There are **two interacting blocks** that together cause the bug:

**Block 1 — Existing guard (lines 2737-2741):** This guard correctly sets `role = null` for PLAN REVIEWED → coded transitions, but its fix is immediately defeated by Block 2.
```typescript
// Lines 2737-2741 — correctly sets role = null, but is then overridden
if (column === 'PLAN REVIEWED' && destinationColumn && destinationColumn !== 'PLAN REVIEWED') {
    if (roleSourceDef?.kind === 'coded') {
        role = null;
    }
}
```

**Block 2 — Kind-based fallback (lines 2743-2754):** Because `null` is falsy, `if (!role && roleSourceDef)` is true even after Block 1 intentionally sets `role = null`. The switch then reassigns `role = 'reviewer'` for any `kind: 'coded'` column, defeating the guard.
```typescript
// Lines 2743-2754 — BUG: re-enters switch when role=null, overriding Block 1's intent
if (!role && roleSourceDef) {
    switch (roleSourceDef.kind) {
        case 'created': role = 'planner'; break;
        case 'coded': role = 'reviewer'; break;  // ← overrides the null set above
        case 'reviewed': role = 'tester'; break;
        case 'review': role = null; break;
        case 'custom-user': role = null; break;
        case 'custom-agent': role = null; break;
        case 'gather': role = null; break;
        case 'completed': role = null; break;
    }
}
```

## Edge-Case & Dependency Audit

### Race Conditions
- None. This is pure synchronous role-selection logic within an async method; no shared mutable state is involved.

### Security
- None. Role selection affects prompt content only; no access control or data boundaries are crossed.

### Side Effects
- The fix adds a guard inside the existing switch block. No other callers of `_generatePromptForColumn` are affected because they all ultimately resolve role through this same path.
- **`destinationColumn === undefined` path**: When `nextCol` is null (no next column configured), `destinationColumn` is `undefined`. Block 1's guard (`destinationColumn &&`) won't fire, but `roleSourceColumn` resolves to `column = 'PLAN REVIEWED'`, and PLAN REVIEWED's `kind` is `'review'` — hitting `case 'review': role = null` in the switch. This path is safe and unaffected by the fix.

### Dependencies & Conflicts
- The fix is entirely self-contained within `_generatePromptForColumn`. No other methods or services need updating.
- Custom kanban columns with `kind: 'coded'` that are NOT sourced from PLAN REVIEWED continue to correctly generate reviewer prompts.

## Dependencies
- None — single-file fix with no cross-file dependencies.

## Adversarial Synthesis

Key risk: the existing partial guard at lines 2737-2741 is silently defeated by `null` being falsy in the subsequent `if (!role && roleSourceDef)` check — the root cause is subtle and easy to re-introduce. The proposed fix is correct and safe: adding a `column === 'PLAN REVIEWED'` guard inside the switch block closes the hole without disturbing any other transition. The undefined-destination path is a safe no-op (PLAN REVIEWED has `kind: 'review'`, not `'coded'`). Mitigation: ensure the fix is verified across all four column transitions listed in the verification plan.

## Proposed Changes

### `src/services/KanbanProvider.ts` — `_generatePromptForColumn` (lines 2743-2754)

#### Context
The function resolves which agent role should receive the prompt. It reads the destination column's kind, then falls back to a switch statement. The bug is that the switch is reached even when an earlier block has explicitly set `role = null`.

#### Logic
Add a guard inside `if (!role && roleSourceDef)` to skip the `'coded'` → `'reviewer'` assignment when the **original source column** is `PLAN REVIEWED`. This preserves the intended `role = null` for complexity-based execution routing.

#### Implementation

**Replace lines 2743-2754 with:**
```typescript
if (!role && roleSourceDef) {
    // When source is PLAN REVIEWED and destination is coded, we want execution (role=null)
    // Do not fall back to 'reviewer' for coded kind in this case
    if (column === 'PLAN REVIEWED' && roleSourceDef.kind === 'coded') {
        role = null; // Keep null for complexity-based execution routing
    } else {
        switch (roleSourceDef.kind) {
            case 'created': role = 'planner'; break;
            case 'coded': role = 'reviewer'; break;
            case 'reviewed': role = 'tester'; break;
            case 'review': role = null; break; // execution fallback
            case 'custom-user': role = null; break; // custom-user columns have role set via columnDef.role
            case 'custom-agent': role = null; break; // custom-agent columns have role set via columnDef.role
            case 'gather': role = null; break; // CONTEXT GATHERER has dragDropMode:disabled
            case 'completed': role = null; break; // not a source column
        }
    }
}
```

#### Edge Cases
- **Custom `kind: 'coded'` columns (non-PLAN REVIEWED source):** Unaffected — guard only fires when `column === 'PLAN REVIEWED'`.
- **No destination column configured (`destinationColumn = undefined`):** Block 1 guard doesn't fire; `roleSourceColumn` resolves to `PLAN REVIEWED` whose `kind` is `'review'` → hits `case 'review': role = null` safely.
- **PLAN REVIEWED → non-coded destination:** Guard doesn't fire; switch proceeds normally.

## Verification Plan

### Automated Tests
- No existing automated tests for this function path; rely on manual verification below.

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

## Execution Results

### Status: COMPLETED

### Files Changed
- `src/services/KanbanProvider.ts` (lines 2743-2760)

### Changes Applied
Added guard clause inside `if (!role && roleSourceDef)` block to prevent the `'coded'` → `'reviewer'` fallback when the source column is `PLAN REVIEWED`. This preserves the intended `role = null` for complexity-based execution routing.

### Validation
**Automated Tests:** None exist for this function path (as noted in plan).

**Manual Verification Required:** The plan specifies 5 manual verification steps:
1. PLANNED column → execution prompt (core fix)
2. Regression — CREATED column → planner prompt
3. Regression — LEAD CODED column → reviewer prompt
4. Regression — CODE REVIEWED column → tester prompt
5. Complexity routing (if enabled)

These require manual testing in the VS Code extension UI with an active Switchboard workspace.

### Remaining Risks
None identified. The fix is a single guard clause that:
- Only affects the specific transition path (PLAN REVIEWED → coded)
- Preserves all existing switch-case behavior for other columns
- Does not introduce new state or interfaces
- Has no cross-file dependencies

### Adversarial Review (Stage 1)
- "Grumpy Principal Engineer here. You fixed the `null` falsy bug by wrapping the switch statement. But honestly, lines 2737-2741 doing `role = null` followed by the new `if (!role...)` logic is just duct-taping over duct-tape. You have two separate checks trying to set `role = null` for the exact same column condition. The original guard block is now arguably dead code or at least heavily redundant. You didn't remove the original block, which makes the flow convoluted. The issue was that `null` was treated as 'I need a default' instead of 'I specifically want null'. A better fix would have been changing `if (!role && roleSourceDef)` to `if (role === undefined && roleSourceDef)` and initializing `let role: string | null | undefined = undefined;`. But fine, the guard you added works specifically for PLAN REVIEWED."

### Synthesis (Stage 2)
- "The Grumpy review notes that the new guard creates redundancy with the previous guard at lines 2737-2741. While true that the initial guard now serves little purpose since the fallback switch also guards against it, the current implementation is perfectly safe and successfully isolates the fix without massive refactoring of `_generatePromptForColumn`. Since this is just a quick surgical bugfix, leaving the earlier guard as a documented intent check doesn't hurt. No code changes are necessary beyond what was already implemented."

---

> **Recommendation:** Code changes match plan requirements exactly and compiled successfully. Ready for manual validation.
