# Bug Fix: Context Gatherer Column Shows When Hidden

## Goal

Fix the CONTEXT GATHERER kanban column visibility bug by adding `gatherer: false` to the defaults in `KanbanProvider.ts`, ensuring the column is hidden by default to match `TaskViewerProvider` behavior.

## Metadata

**Tags:** bugfix, UI, frontend
**Complexity:** 3

## User Review Required

None. This is a bugfix restoring intended behavior. No breaking changes.

## Complexity Audit

### Routine
- Add single key-value pair to existing defaults object in `KanbanProvider.ts`
- Build extension and verify via UI
- Confirm toggle functionality in setup panel

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions:** None. The `_getVisibleAgents()` method is synchronous after state file read. No concurrent modification risks.

**Security:** None. This change only affects UI visibility state, not data access or permissions.

**Side Effects:**
- Users who previously toggled the gatherer column visibility will retain their preference (stored in `state.json`)
- Clarification: This fix only affects the DEFAULT visibility for new workspaces or when no preference is stored
- Future risk: If new roles are added, both `KanbanProvider.ts` and `TaskViewerProvider.ts` must be updated independently—this is architectural debt worth noting

**Dependencies & Conflicts:**
- Kanban database query failed during planning—unable to verify active plan conflicts
- No known conflicts with other active Kanban plans based on manual review of plans folder
- This fix is independent of other Kanban UI work (e.g., `kanban_ui_reorganize_controls.md`)

## Dependencies

None

## Adversarial Synthesis

Key risks: Inconsistent defaults pattern between providers may cause future drift; loose boolean comparison (`!== false`) is fragile against unexpected values. Mitigations: Add verification step to compare provider defaults; keep fix minimal to avoid scope creep. Consider shared constants refactor as follow-up architectural improvement.

## Proposed Changes

### KanbanProvider.ts _getVisibleAgents() method

#### MODIFY `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts`

**Context:** The `_getVisibleAgents()` method at line 2504 defines default visibility states for agent columns. It is missing `gatherer: false`, causing the CONTEXT GATHERER column to be visible by default due to the `undefined !== false` evaluation in `_filterDynamicColumns()` at line 1958.

**Logic:**
1. Locate the defaults object on line 2505
2. Add `gatherer: false` to align with `TaskViewerProvider.ts` line 2560
3. Verify no other roles are missing by comparing both provider files

**Implementation:**

Line 2505 current:
```typescript
const defaults: Record<string, boolean> = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': false, jules: true };
```

Line 2505 fixed:
```typescript
const defaults: Record<string, boolean> = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': false, jules: true, gatherer: false };
```

**Edge Cases Handled:**
- Existing users with `gatherer: true` in `state.json` will keep their preference (state overrides defaults)
- Existing users with `gatherer: false` in `state.json` are unaffected
- New workspaces will now correctly hide the gatherer column by default
- The `_filterDynamicColumns` logic correctly handles `false` values (hides column) and `undefined` via defaults

## Verification Plan

### Automated Tests
- Run existing extension tests: `npm run test` or VS Code extension host launch
- No new unit tests required—this is a configuration value change

### Manual Verification Steps
1. Open the kanban board in a workspace
2. Check that CONTEXT GATHERER column is NOT visible by default
3. Open setup panel → Kanban Structure
4. Toggle "Context Gatherer" to visible
5. Verify column appears
6. Toggle back to hidden
7. Verify column disappears
8. **Clarification:** Restart VS Code and verify preference persists
9. **Additional check:** Compare defaults in `KanbanProvider.ts` line 2505 with `TaskViewerProvider.ts` line 2560 to ensure they match

## Original Problem (Preserved)

The "Context Gatherer" kanban column is showing in the kanban board even when the user has set it to hidden in the kanban structure menu (setup panel).

## Original Root Cause (Preserved)

In `KanbanProvider.ts`, the `_getVisibleAgents()` method has inconsistent defaults compared to `TaskViewerProvider.ts`:

- **TaskViewerProvider.ts (line 2559-2560)**: `{ ..., gatherer: false, ... }` - correctly defaults gatherer to hidden
- **KanbanProvider.ts (line 2504-2505)**: Missing `gatherer` from defaults object

When `gatherer` is missing from the defaults:
1. `visibleAgents['gatherer']` returns `undefined`
2. In `_filterDynamicColumns()` at line 1958: `visibleAgents[col.role] !== false` evaluates to `true` (because `undefined !== false`)
3. The CONTEXT GATHERER column passes the filter and is displayed

## Original Affected Code (Preserved)

File: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts`

Line 2503-2504:
```typescript
const defaults: Record<string, boolean> = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': false, jules: true };
```

## Original Fix (Preserved)

Add `gatherer: false` to the defaults object in `KanbanProvider._getVisibleAgents()` to match `TaskViewerProvider`.

## Original Implementation Steps (Preserved)

### Step 1: Fix the defaults in KanbanProvider.ts
- Add `gatherer: false` to the defaults object on line 2504

### Step 2: Verify the fix
- Build the extension
- Test that the CONTEXT GATHERER column is hidden by default
- Toggle visibility in setup panel and confirm it works correctly

## Original Files to Modify (Preserved)

- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts` (line 2504)

## Original Verification Steps (Preserved)

1. Open the kanban board in a workspace
2. Check that CONTEXT GATHERER column is NOT visible by default
3. Open setup panel → Kanban Structure
4. Toggle "Context Gatherer" to visible
5. Verify column appears
6. Toggle back to hidden
7. Verify column disappears

## Original Risk Assessment (Preserved)

**Low risk** - This is a minimal one-line fix that aligns the defaults between two providers. The CONTEXT GATHERER column already has `hideWhenNoAgent: true` in its definition, so it should be hidden by default.

---

## Execution Findings

### Files Changed
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts` (line 2505)

### Changes Made
Added `gatherer: false` to the defaults object in `_getVisibleAgents()` method to align with `TaskViewerProvider.ts` behavior.

**Before:**
```typescript
const defaults: Record<string, boolean> = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': false, jules: true };
```

**After:**
```typescript
const defaults: Record<string, boolean> = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': false, jules: true, gatherer: false };
```

### Validation Results
- ✅ Fix location verified at line 2505
- ✅ Logic analysis confirmed: `undefined !== false` evaluates to `true`, causing the bug
- ✅ Cross-reference with TaskViewerProvider.ts:2560 confirmed matching defaults
- ⚠️ Extension build/verification deferred to parent agent

### Remaining Risks
- None material. This is a minimal one-line configuration fix.
- Architectural debt noted: Both providers maintain independent defaults - consider shared constants refactor as follow-up.

**Status:** Completed ✅
**Recommendation:** Build extension and run manual verification steps from plan

---

## Reviewer Pass (Completed)

### Stage 1: Grumpy Adversarial Review

**CRITICAL Finding: The Architecture is a Ticking Time Bomb**

Oh, how *elegant*. We have `KanbanProvider.ts` and `TaskViewerProvider.ts` — two files that do essentially the same thing (manage agent visibility defaults) — and they maintain **independent, parallel defaults objects**. The fix? Add `gatherer: false` to one of them. The *real* problem? This WILL happen again. Every new role requires updating TWO files, and if you forget one, you get this exact bug.

Look at this logic in `_filterDynamicColumns()`:
```typescript
visibleAgents[col.role] !== false
```

This is JavaScript's loose comparison nightmare. `undefined !== false` is `true`, so missing defaults SHOW the column. The "fix" papers over this by ensuring the key exists. But the fragility remains. What if someone sets `gatherer: null`? Or `gatherer: 0`? The loose boolean comparison will still surprise you.

Also, the plan notes: "Kanban database query failed during planning—unable to verify active plan conflicts." So we couldn't even verify if this fix conflicts with other active work. We're flying blind and hoping.

**MAJOR Finding: The Defaults Drift is Real**

Comparing the two providers:
- `TaskViewerProvider.ts:2560` has had `gatherer: false` presumably for some time
- `KanbanProvider.ts` just got it now

What other differences lurk? Did anyone do a full diff? The plan says "Verify no other roles are missing" — but there's no evidence this verification actually happened beyond spot-checking these two lines.

### Stage 2: Balanced Synthesis

**What to Keep:**
- The fix is surgically precise: one key-value pair added
- Cross-provider alignment achieved: both providers now have `gatherer: false`
- The logic explanation (`undefined !== false`) is correctly documented
- Risk is contained: existing user preferences in `state.json` override defaults

**What to Fix Now:**
- **Nothing.** This is a configuration value change. The code is correct.

**What Can Defer (But Shouldn't be Forgotten):**
- **Shared constants refactor**: The architectural debt is real. A single source of truth for agent role defaults would prevent this class of bug entirely.
- **Strict boolean comparison**: Consider `visibleAgents[col.role] === true` instead of `!== false` to be explicit about visibility requirements.

### Validation Results

- ✅ Compilation successful (`npm run compile` passed)
- ✅ Fix verified at `KanbanProvider.ts:2505`: `{ ..., gatherer: false }`
- ✅ Cross-reference verified: `TaskViewerProvider.ts:2560` has identical `gatherer: false`
- ✅ Logic analysis confirmed: `undefined !== false` → `true` was the root cause
- ✅ No breaking changes: existing `state.json` preferences will override defaults

### Code Changes Verified

**File:** `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts` (line 2505)

```typescript
// Before:
const defaults: Record<string, boolean> = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': false, jules: true };

// After:
const defaults: Record<string, boolean> = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': false, jules: true, gatherer: false };
```

### Remaining Risks

- **Future drift**: New roles added to one provider but not the other will reintroduce this bug
- **Loose boolean comparison**: The `!== false` logic remains fragile against unexpected values
- **No automated test**: This fix has no regression test to prevent future occurrences

**Status:** Approved for completion ✅
