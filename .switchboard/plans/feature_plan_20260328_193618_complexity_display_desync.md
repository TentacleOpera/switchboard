# Complexity Display Desync

## Goal
Fix the Kanban board displaying "Unknown" complexity for plans that have valid `**Complexity:** Low` metadata in their plan files. The root cause is an **ID format mismatch** in `getComplexityFromPlan()`: the DB lookup (priority 2) hashes the plan file path with SHA-256 to create a `planId`, but the `session_id` column stores a different identifier (e.g. `sess_1774686978746` or `brain_077...`). The hash-based lookup silently returns `null`, and if the manual override line (`**Manual Complexity Override:**`) is present with value `Unknown`, that line matches first and returns `Unknown` — short-circuiting the text-derived parsing (priority 3+4) that would have returned the correct value.

## Metadata
**Tags:** backend, bugfix
**Complexity:** Low

## User Review Required
> [!NOTE]
> - No breaking changes. The fix is purely internal — it corrects the DB lookup key and the manual override handling so complexity resolves correctly.
> - After deploying, plans that showed "Unknown" in the Kanban board will display their correct "Low" or "High" badge on the next board refresh.
> - Manual Complexity Overrides set to "Low" or "High" via the dropdown are unchanged — they write directly to the DB and their plan-file override line already returns the correct value.
> - The self-heal mechanism already implemented in `_refreshBoardImpl()` (from the earlier "Complexity Analysis Not Working Properly" plan) will continue to function, but will no longer be needed for plans where the fix resolves the issue at the parser level.

## Complexity Audit

**Manual Complexity Override:** Low

### Routine
- **Fix the SHA-256 hash → session ID mismatch** in `getComplexityFromPlan()` — replace the hash-based `planId` derivation with the actual `sessionId` lookup. This can be done by looking up the plan via `getPlanByPlanFile()` instead of hashing the path, or by querying the DB with the normalized plan file path directly.
- **Fix the `**Manual Complexity Override: Unknown**` short-circuit** — when the override value is `Unknown`, the method should fall through to subsequent parsing tiers instead of returning `Unknown` immediately. Currently `Unknown` is treated as a valid override, preventing text-derived parsing.

### Complex / Risky
- None.


## Edge-Case & Dependency Audit
- **Race Conditions:** `getComplexityFromPlan()` is a pure read — it reads the plan file and queries the DB. No state mutation occurs in this method (the self-heal writes happen in the calling code, `_refreshBoardImpl`). The existing `_isRefreshing` guard serializes board refreshes. No new race condition introduced.
- **Security:** Plan file paths are resolved from DB records written during plan creation. `path.isAbsolute()` / `path.join()` and `fs.existsSync()` guards are already present (lines 962–965). No user input is injected into SQL (parameterized queries throughout). No change to attack surface.
- **Side Effects:** The DB lookup path changes from `getPlanBySessionId(hashOfPath)` to `getPlanByPlanFile(normalizedPath, ...)`. If the plan exists in the DB, it now finds the record (previously silently returned `null`). This means the DB complexity value may be used more often, which is correct behavior. The self-heal loop will now sometimes find `'Low'` or `'High'` from the DB instead of falling through to text parsing — this is a performance improvement, not a regression.
- **Dependencies & Conflicts:**
  - `feature_plan_20260326_150714_complexity_analysis_not_working_properly_db_file_mismatch_fix.md` (CODE REVIEWED, High) — **Overlapping domain.** That plan added the self-heal mechanism in `_refreshBoardImpl()` and the `resolveComplexity` callback in `syncPlansMetadata()`. Those changes are already merged and working. **This plan fixes a different layer** — the parser's DB lookup priority 2, which was broken by an ID mismatch. The self-heal works around the broken lookup; this plan fixes the lookup itself. **Complementary, not conflicting.**
  - No other Kanban plans touch `getComplexityFromPlan()` directly.

## Adversarial Synthesis
### Grumpy Critique
Oh *splendid*. So we have a function with a five-tier priority cascade — manual override, DB lookup, `**Complexity:**` regex, agent recommendation regex, and Band B content parsing — and the DB lookup tier has been computing `SHA-256(absolutePath)` and querying `session_id` with it since... forever? The `session_id` column stores human-readable identifiers like `sess_1774686978746` or `brain_077e344d...` and we're searching for a 64-character hex digest of the file path. These two strings will **never match**. This entire tier has been dead code dressed up as a "secondary priority."

And the cherry on top: the `**Manual Complexity Override:** Unknown` line. When the improve-plan workflow or the dropdown writes this with value `Unknown`, the regex at line 970 matches it, the method sees `val === 'unknown'` (not `'low'` or `'high'`), and dutifully returns `'Unknown'` — *bypassing the three remaining tiers that would have correctly returned `'Low'`*. So the manual override is actively *sabotaging* the fallback chain. Brilliant.

The existing self-heal loop in `_refreshBoardImpl()` was a heroic band-aid for the DB lookup failure, but now with `**Manual Complexity Override: Unknown**` being written into plan files, even the self-heal calls `getComplexityFromPlan()` which... hits the override first and returns `Unknown`. So the self-heal self-defeats. *Magnificent circular failure.*

Also, I note there's no test coverage for the DB lookup path in `getComplexityFromPlan()`. The existing `kanban-complexity.test.ts` tests only exercise the text-parsing tiers. If someone "fixes" the DB lookup by changing the hash, there's no test to verify the lookup actually finds a record.

### Balanced Response
Grumpy's diagnosis is accurate on all three points. Here's how the implementation addresses each:

1. **Dead DB lookup tier:** The fix replaces the SHA-256 hash approach with `getPlanByPlanFile(normalizedPath, workspaceId)`, which queries the `plan_file` column — the same column that `syncPlansMetadata()` and `upsertPlans()` write to. This aligns the lookup key with the actual stored data. Alternatively, we could use the workspace ID from the DB config to scope the query; `getPlanByPlanFile` already takes a `workspaceId` parameter.

2. **`Unknown` override short-circuit:** The fix changes the override handler to only return when the value is `'Low'` or `'High'`. When the value is `'Unknown'`, the method falls through to the remaining parsing tiers, allowing the text-derived `**Complexity:** Low` or agent recommendation to resolve correctly. This makes `Unknown` semantically mean "no override set" rather than "force Unknown."

3. **Test coverage:** Adding a test for the DB lookup path is out of scope for this bugfix (it would require mocking `KanbanDatabase.forWorkspace()` which is a static factory). The text-parsing tests already cover the downstream tiers adequately. The fix is small and verifiable via manual testing + compilation.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### Fix 1: Remove SHA-256 hash and use plan file lookup instead
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** `getComplexityFromPlan()` (lines 961–1077) has a DB lookup at lines 978–998 that computes a SHA-256 hash of the plan file path and queries `getPlanBySessionId(hash)`. Since `session_id` stores identifiers like `sess_*` or `brain_*` (not path hashes), this lookup always returns `null`.
- **Logic:**
  1. Replace the hash computation (lines 982–989) with a call to `db.getPlanByPlanFile(normalizedPath, workspaceId)`.
  2. This uses the `plan_file` column which stores the actual file path, matching how `upsertPlans()` and `syncPlansMetadata()` write records.
  3. Obtain the `workspaceId` from `db.getWorkspaceId()` or `db.getDominantWorkspaceId()` (same pattern used elsewhere, e.g. `SessionActionLog._doCreateRunSheet` line 592).
- **Implementation:**

Replace lines 978–998 (the `// Secondary priority: Kanban DB` block) with:

```typescript
            // Secondary priority: Kanban DB (lookup by plan_file column)
            try {
                const db = KanbanDatabase.forWorkspace(workspaceRoot);
                if (await db.ensureReady()) {
                    const normalized = path.normalize(resolvedPlanPath);
                    const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
                    if (workspaceId) {
                        const plan = await db.getPlanByPlanFile(normalized, workspaceId);
                        if (plan && (plan.complexity === 'Low' || plan.complexity === 'High')) {
                            return plan.complexity;
                        }
                    }
                }
            } catch (err) {
                console.error('[KanbanProvider] Failed to read complexity from DB:', err);
            }
```

- **Edge Cases Handled:**
  - **No workspaceId in DB:** The `workspaceId` ternary chain falls back to `getDominantWorkspaceId()` then empty string. If empty, we skip the lookup and fall through to text parsing — safe degradation.
  - **Plan not in DB:** `getPlanByPlanFile` returns `null` → we fall through to text parsing. Same behavior as before (when the hash never matched).
  - **Plan in DB with `Unknown` complexity:** The `plan.complexity === 'Low' || plan.complexity === 'High'` guard ensures we fall through to text parsing, allowing the file content to resolve correctly.
  - **Path normalization:** `path.normalize()` matches the `_normalizePath()` logic used by `KanbanDatabase.upsertPlans()` and `updatePlanFile()`, ensuring consistent path comparison.

### Fix 2: Make `Manual Complexity Override: Unknown` fall through
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** Lines 968–976 in `getComplexityFromPlan()` match `**Manual Complexity Override:** Unknown` and return `'Unknown'` immediately. This prevents the method from reaching the text-derived parsing tiers (Complexity metadata, agent recommendation, Band B content) that would correctly resolve the complexity.
- **Logic:**
  1. When the override regex matches but the value is `'Unknown'`, do NOT return — fall through to the remaining parsing tiers.
  2. Only return when the value is explicitly `'Low'` or `'High'`.
  3. This makes `Unknown` semantically mean "no manual override" — the user hasn't made a decision, so the system should auto-detect.
- **Implementation:**

Replace lines 968–976 with:

```typescript
            // Highest priority: explicit manual complexity override (user-set via dropdown).
            // This supersedes all text-derived heuristics.
            // When the value is 'Unknown', fall through — it means no override is set.
            const overrideMatch = content.match(/\*\*Manual Complexity Override:\*\*\s*(Low|High|Unknown)/i);
            if (overrideMatch) {
                const val = overrideMatch[1].toLowerCase();
                if (val === 'low') return 'Low';
                if (val === 'high') return 'High';
                // 'Unknown' — no override, fall through to auto-detection
            }
```

- **Edge Cases Handled:**
  - **Override set to Low/High:** Returns immediately — no behavior change.
  - **Override set to Unknown:** Falls through to DB lookup → text parsing → agent rec → Band B. This enables auto-detection to work.
  - **No override line present:** Regex doesn't match, falls through. No behavior change.

## Verification Plan
### Automated Tests
- Run `npm run compile` to verify TypeScript compilation succeeds with no type errors after both changes.
- The existing `kanban-complexity.test.ts` tests exercise text-parsing tiers only and should continue to pass unchanged (they don't trigger the DB lookup path because the test creates a `KanbanProvider` without a populated DB).

### Manual Verification
1. **Reproduce the bug (before fix):** Open the Kanban board. Find the "Complexity Display Desync" card (session `sess_1774686978746`). Confirm it shows "Unknown" complexity. Open the plan file — confirm it has `**Manual Complexity Override:** Unknown` and `**Complexity:** Low` (or similar metadata).
2. **Verify the fix (after fix):** Reload the VS Code window. The plan should now show the correct "Low" badge on the Kanban board, because:
   - The override `Unknown` falls through (Fix 2).
   - The DB lookup now uses `getPlanByPlanFile()` which finds the record if complexity is stored (Fix 1).
   - If the DB still has `Unknown`, the text-derived `**Complexity:** Low` regex matches and returns `Low`.
3. **Verify Manual Override still works:** Use the dropdown to set a plan to "High". Refresh. Confirm it stays "High" (the override regex returns `High` immediately, before any fallback).
4. **Verify self-heal still works:** Find a plan with `Unknown` in the DB and no override line. Refresh. Confirm the self-heal loop in `_refreshBoardImpl()` resolves it via `getComplexityFromPlan()` and writes back to the DB. Check console for `[KanbanProvider] Self-healed complexity for N plans`.

## Complexity Audit
**Manual Complexity Override:** Low

### Routine
- Fix the SHA-256 hash → plan file lookup in `getComplexityFromPlan()` (single method, ~10 lines changed)
- Fix the `Unknown` override short-circuit in `getComplexityFromPlan()` (3 lines changed)

### Complex / Risky
- None
