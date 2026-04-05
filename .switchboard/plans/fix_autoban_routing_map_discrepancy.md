# Fix Autoban Custom Routing Map Discrepancy

## Goal
Ensure `_autobanRoutePlanReviewedCard` and `_resolvePlanReviewedDispatchRole` in `TaskViewerProvider.ts` respect the custom routing map (`_routingMapConfig`) stored on `KanbanProvider`, matching the behavior already implemented in `KanbanProvider._resolveComplexityRoutedRole`.

## Metadata
**Tags:** backend, bugfix
**Complexity:** 5

## User Review Required
> [!NOTE]
> - `_autobanRoutePlanReviewedCard` is currently synchronous. This fix changes it to **async** and adds `await` at all call sites.
> - `_resolvePlanReviewedDispatchRole` (line 783) has the **same bug** — it also calls `scoreToRoutingRole()` directly without checking `_routingMapConfig`. This plan fixes both methods.
> - No UI, database, or configuration schema changes. Behavioral change is limited to routing decisions when a custom routing map is active.

## Problem Statement
The automation in `_autobanRoutePlanReviewedCard` (`src/services/TaskViewerProvider.ts:2603`) does not respect custom routing maps (`_routingMapConfig`), while the Kanban drag-drop path in `_resolveComplexityRoutedRole` (`src/services/KanbanProvider.ts:1374`) does. This causes inconsistent routing behavior: custom routing maps work when users manually move cards but are ignored when autoban automatically routes them.

**Additionally discovered:** `_resolvePlanReviewedDispatchRole` (`src/services/TaskViewerProvider.ts:783`) has the identical bug — it calls `scoreToRoutingRole(score)` directly at line 795 without checking custom config.

**Example:** If a user configures score 3 → `coder`, manual Kanban moves will respect this, but autoban automation will use default thresholds and potentially route to `intern`.

## Root Cause
Three methods resolve complexity → role. Only one checks `_routingMapConfig`:

| Method | File | Line | Checks `_routingMapConfig`? | Checks pair bypass? |
|--------|------|------|-----------------------------|---------------------|
| `_resolveComplexityRoutedRole` | `KanbanProvider.ts` | 1374 | **Yes** (line 1411) | **Yes** (line 1425) |
| `_autobanRoutePlanReviewedCard` | `TaskViewerProvider.ts` | 2603 | **No** — calls `scoreToRoutingRole()` directly (line 2613) | Yes (line 2616) |
| `_resolvePlanReviewedDispatchRole` | `TaskViewerProvider.ts` | 783 | **No** — calls `scoreToRoutingRole()` directly (line 795) | **No** |

## Solution Options

### Option A: Expose Public Method on KanbanProvider (Recommended)
TaskViewerProvider already has a reference to KanbanProvider (`_kanbanProvider`). Expose a method on KanbanProvider to resolve roles using the config, then call it from TaskViewerProvider.

**Pros:**
- Single source of truth for routing logic
- Pair programming bypass stays in one place
- Minimal code duplication

**Cons:**
- `_autobanRoutePlanReviewedCard` must become async (currently sync). All callers at line 2901 need `await`.

### Option B: Share Routing Config via State
Store `_routingMapConfig` in extension workspaceState and read it from both providers.

**Pros:**
- No provider coupling needed
- TaskViewerProvider can stay synchronous

**Cons:**
- Config read on every routing decision (workspaceState.get is synchronous but adds overhead)
- Potential for state drift if KanbanProvider updates `_routingMapConfig` in memory but hasn't persisted yet

### Option C: Duplicate Config Access
TaskViewerProvider reads `_routingMapConfig` directly from workspaceState, similar to KanbanProvider.

**Pros:**
- Simple to implement
- No refactoring needed

**Cons:**
- Violates DRY principle
- Two places to update routing logic
- Pair programming bypass still duplicated

**Decision:** Option A. The `_kanbanProvider` reference already exists on TaskViewerProvider. The async change is low-risk because all autoban code paths are already async.

## Complexity Audit

### Routine
- **New public method `resolveRoutedRole()` on KanbanProvider:** Extracts the existing inline logic from `_resolveComplexityRoutedRole` (lines 1410-1429) into a reusable public method. No new logic — just extraction and re-exposure.
- **Simplify `_resolveComplexityRoutedRole`:** Replace inline routing logic (lines 1410-1429) with a call to the new `resolveRoutedRole()`. The planFile resolution logic above it (lines 1376-1406) stays untouched.
- **Fix `_resolvePlanReviewedDispatchRole`:** Replace `scoreToRoutingRole(score)` at line 795 with `this._kanbanProvider.resolveRoutedRole(score)`. Already async, already has `_kanbanProvider` null-guard.

### Complex / Risky
- **Sync-to-async conversion of `_autobanRoutePlanReviewedCard`:** Currently synchronous (line 2603). Must become async because `resolveRoutedRole` itself is synchronous, **but** future-proofing and consistency with the codebase pattern suggests keeping the caller async-ready. **Clarification:** Actually, `resolveRoutedRole()` as proposed is synchronous (no DB or file I/O), so the method can stay synchronous and just call `this._kanbanProvider.resolveRoutedRole(score)` directly. **No async refactoring needed.** The `_kanbanProvider` null-guard must be added though — if `_kanbanProvider` is null, fall back to `scoreToRoutingRole(score)`.
- **Caller chain validation:** `_autobanRoutePlanReviewedCard` is called at line 2901 in a synchronous context inside a `for` loop. If it stays synchronous, no caller changes are needed. If it becomes async, every caller in the loop at line 2900-2903 needs `await`.

## Edge-Case & Dependency Audit
- **Race Conditions:** `_routingMapConfig` is set synchronously via `_updateRoutingConfig()` (line 1435) and read synchronously in `resolveRoutedRole()`. No race window because VS Code extension host is single-threaded.
- **Security:** No security-sensitive changes. Routing decisions don't affect data access or permissions.
- **Side Effects:** If a user has a custom routing map that routes score 3 → `coder`, and autoban previously routed it to `intern`, this fix will change autoban behavior to match the manual drag-drop behavior. This is the **intended fix**, not a side effect.
- **Dependencies & Conflicts:**
  - **`comprehensive_pair_programming_test_coverage.md` (Plan 1):** Plan 1's Test Group 7 tests the pair bypass via standalone `scoreToRoutingRole()`. This remains valid. However, after this plan lands, Plan 1 should add tests that call `resolveRoutedRole()` with custom routing maps + pair mode to verify the unified path.
  - **`update_coder_complexity_threshold_to_5.md`:** Changes default thresholds in `scoreToRoutingRole()`. No conflict — this plan doesn't change the function, just ensures it's called from a single entry point.
  - **`add_routing_map_modal_to_kanban.md`:** Adds UI to configure `_routingMapConfig`. No conflict — this plan doesn't change how the config is stored, just ensures it's read consistently.
  - **`add_intern_agent_three_tier_routing.md`:** Adds/modifies the three-tier routing setup. If it changes the role resolution logic, the new `resolveRoutedRole()` method would be the single place to update.

## Adversarial Synthesis

### Grumpy Critique

*Ah yes, the classic "we have the same logic in three places and only one of them works correctly" pattern. My favorite.*

Let me point out what this plan gets wrong:

1. **The async refactoring is unnecessary and the plan contradicts itself.** Step 2 says "refactor to async." The Complexity Audit says "actually `resolveRoutedRole()` is synchronous so no async needed." PICK ONE. The original plan's "Con" for Option A was "requires async refactoring" — but `resolveRoutedRole()` doesn't do any I/O. It reads `_routingMapConfig` from an in-memory field. It's synchronous. So the entire "Con" that justified evaluating Options B and C was wrong from the start.

2. **You found a THIRD broken call site (`_resolvePlanReviewedDispatchRole` at line 783) and almost buried it in a footnote.** This is the same bug! And it's WORSE because that method doesn't even have the pair programming bypass — so it's double-broken. A score-3 task in pair mode will route to `intern` through this path. The root cause table is the most useful thing in this plan, but it took me scrolling past three "Solution Options" to find it.

3. **The `bypassPairMode` parameter is a code smell.** Why would anyone call `resolveRoutedRole(score, false)` — "please give me the role, but don't apply the pair bypass that's supposed to be applied everywhere"? If there's a legitimate caller that needs raw routing without pair bypass, it should call `scoreToRoutingRole()` directly. Don't add boolean parameters that exist to disable safety features.

4. **Step 5 uses `// ... get planFile and complexity ...` — a TRUNCATION PLACEHOLDER** — in a plan that's supposed to have "no truncation." Show me the exact code or don't show me anything.

5. **The testing plan is entirely manual.** Six manual steps, zero automated tests. In a project that has `src/test/pair-programming-routing-bypass.test.ts` literally sitting there waiting to be extended. Write a unit test for `resolveRoutedRole()` with a custom routing map. It's five lines of code.

### Balanced Response

Grumpy's critique is sharp and mostly correct. Here's how the implementation below addresses each point:

1. **No async refactoring.** `resolveRoutedRole()` is synchronous — it reads `_routingMapConfig` from an in-memory field and calls `scoreToRoutingRole()`. Both callers (`_autobanRoutePlanReviewedCard` and `_resolvePlanReviewedDispatchRole`) can call it synchronously. No signature changes needed on either method. The original plan's Option A "Con" is moot.

2. **`_resolvePlanReviewedDispatchRole` is a first-class fix target.** It's listed in the root cause table and has its own implementation step below. It has two bugs: no custom routing map support AND no pair programming bypass.

3. **`bypassPairMode` parameter removed.** The pair programming bypass should always apply when pair mode is active. If a future caller needs raw routing, it should call `scoreToRoutingRole()` directly. The public `resolveRoutedRole()` method always applies the full routing pipeline (custom map → fallback to defaults → pair bypass).

4. **No truncation.** Every code block below shows the complete function body.

5. **Automated test added.** A new test in `src/test/pair-programming-routing-bypass.test.ts` verifies `resolveRoutedRole()` with a custom routing map, with and without pair mode.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### Change 1: Add Public `resolveRoutedRole()` to KanbanProvider
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The routing logic at lines 1410-1429 of `_resolveComplexityRoutedRole` must be extracted into a reusable public method so TaskViewerProvider can call it.
- **Logic:**
  1. Create a new public synchronous method `resolveRoutedRole(score: number)` on `KanbanProvider`.
  2. Move the routing map check (lines 1411-1421) and pair bypass (lines 1425-1429) into this method.
  3. The method returns `'lead' | 'coder' | 'intern'`.
- **Implementation:** Add this method after `_resolveWorkspaceRoot()` (after line 122), near other public accessors:
```typescript
/**
 * Resolve a complexity score to a routing role, respecting the custom
 * routing map (if configured) and the pair-programming intern→coder bypass.
 * This is the single source of truth for score→role resolution.
 */
public resolveRoutedRole(score: number): 'lead' | 'coder' | 'intern' {
    let role: 'lead' | 'coder' | 'intern';

    // Apply custom routing map if configured
    if (this._routingMapConfig) {
        if (this._routingMapConfig.intern.includes(score)) {
            role = 'intern';
        } else if (this._routingMapConfig.coder.includes(score)) {
            role = 'coder';
        } else {
            role = 'lead';
        }
    } else {
        role = scoreToRoutingRole(score);
    }

    // Pair programming bypass: never route to intern when pair mode is active.
    // Intern tasks get elevated to coder; coder and lead are unaffected.
    const isPairMode = (this._autobanState?.pairProgrammingMode ?? 'off') !== 'off';
    if (isPairMode && role === 'intern') {
        console.log(`[KanbanProvider] Pair programming bypass: score=${score} intern → coder`);
        role = 'coder';
    }

    return role;
}
```
- **Edge Cases Handled:** Score 0 (unknown) falls through to `scoreToRoutingRole(0)` which returns `'lead'` (default). Null `_routingMapConfig` falls through to default `scoreToRoutingRole()`. Null `_autobanState` defaults pair mode to `'off'` via nullish coalescing.

### Change 2: Simplify `_resolveComplexityRoutedRole`
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** `_resolveComplexityRoutedRole` (line 1374) currently has inline routing logic at lines 1410-1429 that duplicates what `resolveRoutedRole()` now provides.
- **Logic:** Replace lines 1407-1432 with a single call to `this.resolveRoutedRole(score)`.
- **Implementation:** Replace the routing section (from `const score = parseComplexityScore(complexity);` onwards) with:
```typescript
        const complexity = await this.getComplexityFromPlan(workspaceRoot, planFile);
        const score = parseComplexityScore(complexity);
        const role = this.resolveRoutedRole(score);

        console.log(`[KanbanProvider] Complexity routing: session=${sessionId} complexity=${complexity} → role=${role}`);
        return role;
    }
```
- **Edge Cases Handled:** All edge cases (unknown score, null config, pair bypass) are now handled by `resolveRoutedRole()`.

### Change 3: Fix `_autobanRoutePlanReviewedCard`
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** `_autobanRoutePlanReviewedCard` (line 2603) calls `scoreToRoutingRole()` directly at line 2613, bypassing the custom routing map. The method is synchronous and can stay synchronous because `resolveRoutedRole()` is synchronous.
- **Logic:**
  1. Replace `scoreToRoutingRole(parseComplexityScore(complexity))` with `this._kanbanProvider.resolveRoutedRole(parseComplexityScore(complexity))`.
  2. Add a null-guard: if `_kanbanProvider` is null, fall back to `scoreToRoutingRole()` directly.
  3. Remove the inline pair programming bypass (lines 2615-2620) — it's now handled inside `resolveRoutedRole()`.
- **Implementation:** Replace the full method body:
```typescript
    private _autobanRoutePlanReviewedCard(
        complexity: string,
        routingMode: AutobanConfigState['routingMode']
    ): 'intern' | 'coder' | 'lead' {
        if (routingMode === 'all_coder') {
            return 'coder';
        }
        if (routingMode === 'all_lead') {
            return 'lead';
        }
        const score = parseComplexityScore(complexity);
        if (this._kanbanProvider) {
            return this._kanbanProvider.resolveRoutedRole(score);
        }
        // Fallback: no KanbanProvider available — use default routing
        return scoreToRoutingRole(score);
    }
```
- **Edge Cases Handled:** `_kanbanProvider` null → falls back to `scoreToRoutingRole()` (same behavior as before this fix). `routingMode` overrides (`all_coder`, `all_lead`) still take priority. The pair bypass is handled by `resolveRoutedRole()`, so no inline bypass is needed. The method stays synchronous — no caller changes required at line 2901.

### Change 4: Fix `_resolvePlanReviewedDispatchRole`
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** `_resolvePlanReviewedDispatchRole` (line 783) has TWO bugs: no custom routing map check AND no pair programming bypass. It calls `scoreToRoutingRole(score)` directly at line 795.
- **Logic:** Replace `scoreToRoutingRole(score)` with `this._kanbanProvider.resolveRoutedRole(score)`. The `_kanbanProvider` null-guard already exists at line 784.
- **Implementation:** Replace line 795:
```typescript
        const complexity = await this._kanbanProvider.getComplexityFromPlan(workspaceRoot, sheet.planFile);
        const score = parseComplexityScore(complexity);
        return this._kanbanProvider.resolveRoutedRole(score);
```
- **Edge Cases Handled:** `_kanbanProvider` null → returns `'lead'` (existing guard at line 784). Sheet null → returns `'lead'` (existing guard at line 789).

### Change 5: Add Automated Test
#### [MODIFY] `src/test/pair-programming-routing-bypass.test.ts`
- **Context:** The existing test file tests the bypass pattern in isolation using `scoreToRoutingRole()`. A new test should verify that `resolveRoutedRole()` respects custom routing maps combined with pair mode.
- **Logic:** Import the `resolveRoutedRole` method (or test it indirectly via a mock KanbanProvider instance if direct import is not feasible due to VS Code dependency). At minimum, add a test that verifies: given a custom routing map where score 3 → coder, `resolveRoutedRole(3)` returns `'coder'` (not `'intern'` as the default threshold would produce).
- **Implementation:** The implementer must determine whether `KanbanProvider` can be instantiated in a test context. If not, the test should verify the routing logic pattern with a standalone function that mirrors `resolveRoutedRole`. Add to the existing suite:
```typescript
test('custom routing map should override default thresholds', () => {
    // Simulate resolveRoutedRole logic with a custom routing map
    const customMap = { lead: [7, 8, 9, 10], coder: [3, 4, 5, 6], intern: [1, 2] };
    const resolveWithMap = (score: number, map: typeof customMap | null, isPairMode: boolean) => {
        let role: 'lead' | 'coder' | 'intern';
        if (map) {
            if (map.intern.includes(score)) { role = 'intern'; }
            else if (map.coder.includes(score)) { role = 'coder'; }
            else { role = 'lead'; }
        } else {
            role = scoreToRoutingRole(score);
        }
        if (isPairMode && role === 'intern') { role = 'coder'; }
        return role;
    };

    // Score 3: default → intern, custom map → coder
    assert.strictEqual(scoreToRoutingRole(3), 'intern', 'default: score 3 → intern');
    assert.strictEqual(resolveWithMap(3, customMap, false), 'coder', 'custom map: score 3 → coder');

    // Score 1: custom map → intern, pair mode → elevated to coder
    assert.strictEqual(resolveWithMap(1, customMap, false), 'intern', 'custom map: score 1 → intern');
    assert.strictEqual(resolveWithMap(1, customMap, true), 'coder', 'custom map + pair mode: score 1 → coder');

    // Score 7: custom map → lead, pair mode doesn't affect lead
    assert.strictEqual(resolveWithMap(7, customMap, true), 'lead', 'custom map + pair mode: score 7 → lead');

    // No custom map: default behavior preserved
    assert.strictEqual(resolveWithMap(3, null, false), 'intern', 'no custom map: score 3 → intern (default)');
    assert.strictEqual(resolveWithMap(5, null, false), 'coder', 'no custom map: score 5 → coder (default)');
});
```
- **Edge Cases Handled:** Tests both with and without custom map. Tests pair mode interaction with custom map. Tests that scores not in any custom map array fall through to `'lead'`.

## Verification Plan

### Automated Tests
- Run modified test: `npm test -- --grep "Pair programming routing bypass"`
- Run full autoban regression: `node src/test/autoban-state-regression.test.js`
- Run full suite: `npm test` — no regressions.

### Manual Verification
1. Configure a custom routing map (e.g., score 3 → coder, score 1-2 → intern, score 4-10 → lead) via the routing map modal.
2. Create plans with complexity 3 and complexity 1.
3. Move cards manually via Kanban drag-drop → verify score 3 routes to Coder, score 1 routes to Intern.
4. Enable autoban and trigger automatic routing → verify **same behavior** as step 3 (this is the bug fix).
5. Enable pair programming mode → verify score 1 elevates to Coder in both manual and autoban paths.
6. Remove custom routing map → verify default thresholds apply (1-4 intern, 5-6 coder, 7-10 lead).

## Dependencies

- **Files modified:** `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, `src/test/pair-programming-routing-bypass.test.ts`
- **Files read (not modified):** `src/services/complexityScale.ts` (provides `scoreToRoutingRole`, `parseComplexityScore`)
- **No new dependencies required.**

## Migration Notes
This change maintains backward compatibility:
- Default routing behavior unchanged when no custom map configured
- Existing pair programming behavior preserved
- Only fixes the inconsistency when custom maps are active
- `_resolvePlanReviewedDispatchRole` now also gains pair programming bypass support (previously missing)

## Recommended Agent

Send to **Coder** — complexity 5. Multi-file coordination across 3 files, but all changes follow existing patterns. No new architectural concepts. The async refactoring concern from the original plan is moot (method stays synchronous).

## Implementation Review

### Reviewer Pass — Grumpy Principal Engineer

**CRITICAL-1: Missed fourth call site `_handleCopyPlanLink` (line 6759).** The plan identifies three broken call sites. There is a *fourth*: `_handleCopyPlanLink()` at `TaskViewerProvider.ts:6759` also calls `scoreToRoutingRole(parseComplexityScore(complexity))` directly, bypassing the custom routing map AND pair programming bypass. This is the exact same bug class the plan set out to fix. The implementation shipped Changes 1–5 without touching this call site. **FIXED during this review.**

**MAJOR-1: Test coverage is pattern-simulation, not integration.** The test in `pair-programming-routing-bypass.test.ts` re-implements the `resolveRoutedRole` logic in a standalone lambda and tests *that*. If someone refactors `resolveRoutedRole` (e.g., changes the priority order of `intern`/`coder` checks), the test stays green while the production code breaks. This is a test that tests itself. Acceptable given VS Code extension host mocking constraints, but the plan should be explicit that this is a logic-mirror test, not an integration test.

**NIT-1: `_autobanRoutePlanReviewedCard` fallback at line 2618 doesn't apply pair bypass.** When `_kanbanProvider` is null, the method falls back to raw `scoreToRoutingRole(score)`, which has no pair programming bypass. In practice `_kanbanProvider` is always available during autoban dispatch (autoban can't run without it), so this is a dead-code path, but the asymmetry is worth a comment.

**NIT-2: `resolveRoutedRole` placement.** The public method was placed at line 129, between `_resolveWorkspaceRoot()` and `_getWorkspaceItems()`. Conventional grouping puts public API methods together — this is fine but could benefit from a `// --- Public Routing API ---` section marker for a file this large (~1800 lines).

### Balanced Synthesis

The core fix is sound. Changes 1–4 correctly consolidate routing into a single `resolveRoutedRole()` method on `KanbanProvider` and wire both `_autobanRoutePlanReviewedCard` and `_resolvePlanReviewedDispatchRole` through it. The method is synchronous, avoiding the async refactoring risk the plan originally worried about. The pair programming bypass is correctly applied in all routed paths.

CRITICAL-1 (the missed `_handleCopyPlanLink` call site) was a real bug — same class as the original, just in the clipboard-copy path. Fixed during this review by replacing `scoreToRoutingRole(parseComplexityScore(complexity))` with `this._kanbanProvider.resolveRoutedRole(parseComplexityScore(complexity))` at line 6759.

MAJOR-1 is an accepted limitation. The VS Code extension host cannot be instantiated in Mocha tests, so the pattern-simulation approach is the pragmatic choice. No action required.

NITs are informational only — no code changes needed.

### Files Changed During Review
| File | Change |
|------|--------|
| `src/services/TaskViewerProvider.ts` | Line 6759: replaced `scoreToRoutingRole(...)` with `this._kanbanProvider.resolveRoutedRole(...)` in `_handleCopyPlanLink` |

### Validation Results
- `npx tsc --noEmit`: **PASS** (only pre-existing ArchiveManager import error TS2835 — unrelated)
- All five plan changes verified present in source
- Fourth call site (CRITICAL-1) fixed and verified

### Remaining Risks
- The `_kanbanProvider` null-guard fallback in `_autobanRoutePlanReviewedCard` (line 2618) doesn't apply pair bypass — acceptable since autoban cannot run without `_kanbanProvider`
- Pattern-simulation tests may drift from production logic if `resolveRoutedRole` is significantly refactored
- No automated test covers the `_handleCopyPlanLink` path specifically
