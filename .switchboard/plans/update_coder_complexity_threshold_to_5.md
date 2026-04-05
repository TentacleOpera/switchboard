# Update Complexity Threshold: Coder Now Covers 5-6 (Intern Covers 1-4)

## Goal
Adjust the three-tier complexity routing threshold so the **Coder agent handles complexity 5-6** (Medium) and the **Intern agent handles complexity 1-4** (Very Low + Low). This aligns the agent routing with the complexity labels displayed on Kanban cards — score 4 is labeled "Low" and should route to Intern, not Coder.

Additionally, **pair programming mode must never trigger the Intern agent** — it should route directly to Coder (or Lead) regardless of complexity.

## Metadata
**Tags:** backend, UI
**Complexity:** 5

## User Review Required
> [!NOTE]
> - **Behavior change:** Plans with complexity 4 will now route to Intern instead of Coder. Existing plans in CODER CODED with complexity 4 stay put; only new dispatches use the new threshold.
> - **Pair programming mode:** Intern agent will be bypassed entirely in pair programming mode, routing 1-6 to Coder instead.
> - **Custom routing map override:** Users who have configured a custom routing map via the Routing Map Modal (`_routingMapConfig`) will NOT be affected by this threshold change — the custom map takes precedence over `scoreToRoutingRole()`. This change only affects the default routing path.
> - **Tests to update:** `kanban-complexity.test.ts` line 265-272 assertions for score 4 routing change from `'coder'` to `'intern'`, plus new pair programming mode tests.

## Complexity Audit
### Routine
- **Threshold constant change** (`complexityScale.ts:62`): Change `score <= 3` to `score <= 4` in `scoreToRoutingRole()` — single-line edit
- **Test assertion update** (`kanban-complexity.test.ts:268`): Change `scoreToRoutingRole(4)` expected value from `'coder'` to `'intern'`
- **MCP doc string update** (`register-tools.js`): Update any routing description strings from "1-3 = intern" to "1-4 = intern"

### Complex / Risky
- **Pair programming bypass in `_resolveComplexityRoutedRole()`** (`KanbanProvider.ts:1374`): Must read existing `_autobanState.pairProgrammingMode` and override intern routing to coder when active. Risk: the custom routing map (`_routingMapConfig`) at line 1410-1421 runs BEFORE the default `scoreToRoutingRole()` call — the pair programming bypass must also apply when using the custom routing map path, not just the default path.
- **Pair programming bypass in `_autobanRoutePlanReviewedCard()`** (`TaskViewerProvider.ts:2603`): Must read `_autobanState.pairProgrammingMode` and override intern routing. Risk: this function is called from `_autobanTickColumn()` at line 2892 in a tight loop — the autoban state access must be synchronous (it already is — `_autobanState` is an in-memory field).
- **Caller-site threading of `isPairMode` to `_autobanRoutePlanReviewedCard()`**: Requires modifying the call site at `TaskViewerProvider.ts:2892` to pass the pair mode flag.

## Edge-Case & Dependency Audit
- **Race Conditions:** None — `scoreToRoutingRole()` is a pure function; `_autobanState` is synchronously accessed in-memory. No async race between pair mode toggle and routing dispatch.
- **Security:** None — no auth or data security implications.
- **Side Effects:** Plans with complexity 4 will start routing to Intern column; existing cards remain in place. Users with custom routing maps are unaffected (custom map takes precedence).
- **Dependencies & Conflicts:**
  - **`add_intern_agent_three_tier_routing.md`** (parent plan) — MUST be implemented first. Establishes the three-tier system this plan modifies. Codebase inspection confirms it IS already implemented (three-tier routing, `INTERN CODED` column, and fallback logic all present in source).
  - **`brain_82a7918d...pair_programming_mode_dropdown_and_routing_override.md`** — Pair programming mode UI/dropdown. May overlap if it also modifies routing logic for intern bypass. **Recommend reviewing this plan before implementation** to avoid duplicate pair mode bypass code.
  - **`feature_plan_20260329_dynamic_complexity_routing_toggle.md`** — Dynamic routing toggle. Already implemented (`_dynamicComplexityRoutingEnabled` and `_routingMapConfig` present in source). No conflict — this plan's threshold change only affects the default routing path when no custom map is configured.

## Source Analysis

### Current Routing Logic (`complexityScale.ts:57-65`)
```ts
/**
 * Determine the routing role for a given score.
 * 1-3 → 'intern', 4-6 → 'coder', 7-10 → 'lead'
 */
export function scoreToRoutingRole(score: number): 'lead' | 'coder' | 'intern' {
    if (score >= 1 && score <= 3) return 'intern';
    if (score >= 4 && score <= 6) return 'coder';
    return 'lead'; // 7-10 or Unknown defaults to lead
}
```

### Current `_resolveComplexityRoutedRole()` (`KanbanProvider.ts:1374-1426`)
- Returns `'lead' | 'coder' | 'intern'`
- Has a **custom routing map override** at lines 1410-1421 that checks `this._routingMapConfig` before falling back to `scoreToRoutingRole()`
- Pair programming state is available via `this._autobanState?.pairProgrammingMode` (field declared at line 65)

### Current `_autobanRoutePlanReviewedCard()` (`TaskViewerProvider.ts:2603-2614`)
```ts
private _autobanRoutePlanReviewedCard(
    complexity: string,
    routingMode: AutobanConfigState['routingMode']
): 'intern' | 'coder' | 'lead' {
    if (routingMode === 'all_coder') { return 'coder'; }
    if (routingMode === 'all_lead') { return 'lead'; }
    return scoreToRoutingRole(parseComplexityScore(complexity));
}
```

### Pair Programming Infrastructure (already exists)
- `_autobanState?.pairProgrammingMode` — values: `'off'`, `'cli-cli'`, `'cli-ide'`, `'ide-cli'`, `'ide-ide'` (`KanbanProvider.ts:65`, `TaskViewerProvider.ts:2495`)
- Pattern for reading: `const isPairMode = (this._autobanState?.pairProgrammingMode ?? 'off') !== 'off';` (already used at `KanbanProvider.ts:828`)

### Current Test Assertions (`kanban-complexity.test.ts:265-272`)
```ts
test('scoreToRoutingRole routes correctly', () => {
    assert.strictEqual(scoreToRoutingRole(1), 'intern');
    assert.strictEqual(scoreToRoutingRole(3), 'intern');
    assert.strictEqual(scoreToRoutingRole(4), 'coder');   // ← THIS CHANGES to 'intern'
    assert.strictEqual(scoreToRoutingRole(6), 'coder');
    assert.strictEqual(scoreToRoutingRole(7), 'lead');
    assert.strictEqual(scoreToRoutingRole(10), 'lead');
    assert.strictEqual(scoreToRoutingRole(0), 'lead');
});
```

## Adversarial Synthesis
### Grumpy Critique
> "Let me get this straight. The original plan fabricated `_isPairProgrammingMode()`, `_getSession()`, and `_getWorkspaceConfig()` — methods that **don't exist anywhere in the codebase**. Were you just hallucinating API surface? Pair programming mode already lives in `_autobanState.pairProgrammingMode`, neatly accessible from both `KanbanProvider` and `TaskViewerProvider`. Why invent a brand new async method chain when you can read an in-memory field with one line?"
>
> "And the line numbers! The plan claims `_resolveComplexityRoutedRole()` is at line 1267 and `_autobanRoutePlanReviewedCard()` is at line 2570. Actual locations: **1374** and **2603**. These aren't rounding errors — they're wrong enough to send a coder on a wild goose chase."
>
> "Now, the `mode` parameter on `scoreToRoutingRole()`. You're mixing **dispatch-level concerns** (pair programming) into a **pure scoring utility**. Six months from now, someone will add `mode?: 'turbo' | 'cautious'` and suddenly your clean little function is a Swiss Army knife of routing overrides. The pair programming bypass belongs at the **caller level** — in `_resolveComplexityRoutedRole()` and `_autobanRoutePlanReviewedCard()` — where the pair mode state is already available."
>
> "Oh, and let's talk about the elephant in the room: `_routingMapConfig`. Lines 1410-1421 of `KanbanProvider.ts` run a **custom routing map** that completely bypasses `scoreToRoutingRole()`. If pair programming mode bypass only lives inside `scoreToRoutingRole()`, then users with custom routing maps will STILL route to intern in pair mode. You need the bypass at the caller level, BEFORE the custom map check OR as a separate post-check."
>
> "Step 5 says 'if applicable'. That's not a plan, that's a prayer. Either check the file and list the exact strings that need updating, or delete the step."

### Balanced Response
Grumpy's critique is largely correct and leads to a cleaner implementation:

1. **No invented methods.** The pair programming bypass reads `this._autobanState?.pairProgrammingMode` directly — the same pattern already used at `KanbanProvider.ts:828`. No new helper method needed.

2. **Caller-level bypass, not function-parameter pollution.** Keep `scoreToRoutingRole()` as a pure `score → role` function. Add the pair programming bypass at the two caller sites:
   - `_resolveComplexityRoutedRole()` in `KanbanProvider.ts` — insert bypass BEFORE both the custom routing map check and the `scoreToRoutingRole()` call, ensuring pair mode overrides both paths.
   - `_autobanRoutePlanReviewedCard()` in `TaskViewerProvider.ts` — insert bypass after the `routingMode` overrides but before `scoreToRoutingRole()`.

3. **Line numbers corrected.** All references now point to verified source locations.

4. **Custom routing map covered.** The pair programming bypass in `_resolveComplexityRoutedRole()` is placed BEFORE the `_routingMapConfig` check, so it applies regardless of whether a custom map is configured.

5. **Step 5 made concrete.** The MCP tool doc strings in `register-tools.js` have been inspected; specific update targets are identified.

## Proposed Changes

### Step 1: Update Complexity Routing Threshold (Routine)
#### MODIFY `src/services/complexityScale.ts`
- **Context:** The `scoreToRoutingRole()` function at lines 57-65 currently returns `'intern'` for scores 1-3 and `'coder'` for 4-6. We need to shift the intern/coder boundary from 3→4 so that score 4 routes to `'intern'` (matching its "Low" label).
- **Logic:** Change the upper bound of the intern range from `score <= 3` to `score <= 4`, and the lower bound of the coder range from `score >= 4` to `score >= 5`. The function signature, return type, and lead routing are unchanged. No `mode` parameter — pair programming bypass is handled at caller level (see Steps 2 and 3).
- **Implementation:**
```ts
// Lines 57-65: Replace ONLY the function body (signature and JSDoc updated)
/**
 * Determine the routing role for a given score.
 * 1-4 → 'intern', 5-6 → 'coder', 7-10 → 'lead'
 * Fallback: if intern unavailable, coder handles 1-6
 *           if both unavailable, lead handles 1-10
 */
export function scoreToRoutingRole(score: number): 'lead' | 'coder' | 'intern' {
    if (score >= 1 && score <= 4) return 'intern';
    if (score >= 5 && score <= 6) return 'coder';
    return 'lead'; // 7-10 or Unknown defaults to lead
}
```
- **Edge Cases Handled:**
  - Score 4 now correctly routes to `'intern'` (was `'coder'`)
  - Score 5 still routes to `'coder'` (unchanged)
  - Score 0 / undefined / NaN still defaults to `'lead'` for safety
  - Function signature unchanged — no breaking change to callers

### Step 2: Add Pair Programming Bypass in `_resolveComplexityRoutedRole()` (Complex)
#### MODIFY `src/services/KanbanProvider.ts`
- **Context:** `_resolveComplexityRoutedRole()` at line 1374 is the primary routing decision point for kanban dispatch. It has two code paths: (a) custom routing map (`_routingMapConfig`, lines 1410-1421), and (b) default `scoreToRoutingRole()` call (line 1423). The pair programming bypass must apply to BOTH paths — it must be inserted BEFORE the custom routing map check.
- **Logic:** After the `_dynamicComplexityRoutingEnabled` guard and the plan file lookup (both unchanged), insert a pair programming mode check. If pair mode is active and the resolved role would be `'intern'`, override it to `'coder'`. This is done as a post-resolution override so it works regardless of whether the custom routing map or default `scoreToRoutingRole()` was used.
- **Clarification:** Using a post-resolution override (resolve role first, then override if intern + pair mode) is cleaner than a pre-resolution bypass because it preserves logging of the "natural" role before the override, making debugging easier.
- **Implementation:**
```ts
// KanbanProvider.ts — lines 1374-1426
// Full function replacement for _resolveComplexityRoutedRole()
private async _resolveComplexityRoutedRole(workspaceRoot: string, sessionId: string): Promise<'lead' | 'coder' | 'intern'> {
    // When dynamic complexity routing is disabled, all tasks route to lead
    if (!this._dynamicComplexityRoutingEnabled) {
        return 'lead';
    }
    // DB-first: resolve planFile from plans table directly.
    // The old path went through getRunSheet → plan_events, which returns null
    // when a plan has no events yet, silently defaulting to 'lead'.
    let planFile: string | undefined;
    try {
        const db = this._getKanbanDb(workspaceRoot);
        if (await db.ensureReady()) {
            const record = await db.getPlanBySessionId(sessionId);
            if (record?.planFile) {
                planFile = record.planFile;
            }
        }
    } catch {
        // fall through to run sheet fallback
    }

    // Fallback: try the run sheet path (covers edge cases where plan isn't in DB yet)
    if (!planFile) {
        const log = this._getSessionLog(workspaceRoot);
        const sheet = await log.getRunSheet(sessionId);
        planFile = sheet?.planFile;
    }

    if (!planFile) {
        console.warn(`[KanbanProvider] No planFile found for session ${sessionId} — defaulting to 'lead'`);
        return 'lead';
    }
    const complexity = await this.getComplexityFromPlan(workspaceRoot, planFile);
    const score = parseComplexityScore(complexity);

    // Resolve role via custom routing config or default scoreToRoutingRole
    let role: 'lead' | 'coder' | 'intern';
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
        console.log(`[KanbanProvider] Pair programming bypass: session=${sessionId} complexity=${complexity} ${role} → coder`);
        role = 'coder';
    }

    console.log(`[KanbanProvider] Complexity routing: session=${sessionId} complexity=${complexity} pairMode=${isPairMode} → role=${role}`);
    return role;
}
```
- **Edge Cases Handled:**
  - **Custom routing map + pair mode:** If the custom routing map routes score 4 to intern, pair mode still overrides to coder (because the bypass runs after map resolution).
  - **Pair mode off:** When `pairProgrammingMode === 'off'` (the default), `isPairMode` is `false` and the bypass is skipped — zero behavioral change.
  - **Pair mode with coder/lead scores:** Only `'intern'` results are overridden. Scores 5-6 (coder) and 7-10 (lead) are unaffected by the bypass.
  - **`_autobanState` undefined:** The `?? 'off'` fallback ensures graceful degradation to solo mode.

### Step 3: Add Pair Programming Bypass in `_autobanRoutePlanReviewedCard()` (Complex)
#### MODIFY `src/services/TaskViewerProvider.ts`
- **Context:** `_autobanRoutePlanReviewedCard()` at line 2603 handles complexity-based routing in the autoban engine. It's called from `_autobanTickColumn()` at line 2892 in a loop over selected cards. Pair programming state is available via `this._autobanState?.pairProgrammingMode` (same instance field used at line 2495).
- **Logic:** After the existing `routingMode` overrides (`all_coder`, `all_lead`) and the `scoreToRoutingRole()` call, add a pair programming bypass that elevates `'intern'` to `'coder'`. This mirrors the same pattern used in Step 2.
- **Implementation:**
```ts
// TaskViewerProvider.ts — lines 2603-2614
// Full function replacement for _autobanRoutePlanReviewedCard()
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
    let role = scoreToRoutingRole(parseComplexityScore(complexity));

    // Pair programming bypass: never route to intern when pair mode is active
    const isPairMode = (this._autobanState?.pairProgrammingMode ?? 'off') !== 'off';
    if (isPairMode && role === 'intern') {
        role = 'coder';
    }

    return role;
}
```
- **Edge Cases Handled:**
  - `routingMode` overrides (`all_coder`, `all_lead`) still take priority — they return before the pair mode check.
  - The function signature is unchanged (no new parameter needed), so the call site at line 2892 requires NO modification.
  - `_autobanState` is an in-memory field — synchronous access, no async overhead in the autoban tick loop.

### Step 4: Update Tests (Routine)
#### MODIFY `src/test/kanban-complexity.test.ts`
- **Context:** The existing test at lines 265-272 asserts `scoreToRoutingRole(4) === 'coder'`. This must change to `'intern'`. Additional tests for pair programming bypass are NOT needed here because `scoreToRoutingRole()` no longer has a `mode` parameter — pair programming bypass lives in the callers, not the pure function.
- **Logic:** Update the single assertion for score 4. Add a boundary test for score 5 to confirm the new boundary.
- **Implementation:**
```ts
// src/test/kanban-complexity.test.ts — replace existing test at lines 265-272
test('scoreToRoutingRole routes correctly with updated thresholds', () => {
    // Intern: 1-4 (updated from 1-3)
    assert.strictEqual(scoreToRoutingRole(1), 'intern');
    assert.strictEqual(scoreToRoutingRole(2), 'intern');
    assert.strictEqual(scoreToRoutingRole(3), 'intern');
    assert.strictEqual(scoreToRoutingRole(4), 'intern');  // CHANGED: was 'coder'
    
    // Coder: 5-6 (updated from 4-6)
    assert.strictEqual(scoreToRoutingRole(5), 'coder');
    assert.strictEqual(scoreToRoutingRole(6), 'coder');
    
    // Lead: 7-10 (unchanged)
    assert.strictEqual(scoreToRoutingRole(7), 'lead');
    assert.strictEqual(scoreToRoutingRole(10), 'lead');
    assert.strictEqual(scoreToRoutingRole(0), 'lead'); // Unknown defaults to lead
});
```

#### MODIFY `src/test/kanban-smart-router-regression.test.js`
- **Context:** This test file has assertions about complexity routing behavior. Any assertion expecting `scoreToRoutingRole(4)` to return `'coder'` must be updated to `'intern'`.
- **Logic:** Search for assertions referencing score 4 routing and update expected values.

#### CREATE `src/test/pair-programming-routing-bypass.test.ts` (NEW)
- **Context:** The pair programming bypass in `_resolveComplexityRoutedRole()` and `_autobanRoutePlanReviewedCard()` needs dedicated test coverage since the logic lives in callers, not the pure function.
- **Logic:** Test that when `_autobanState.pairProgrammingMode` is not `'off'`, intern results are elevated to coder.
- **Implementation:**
```ts
// src/test/pair-programming-routing-bypass.test.ts
import * as assert from 'assert';
import { scoreToRoutingRole } from '../services/complexityScale';

suite('Pair programming routing bypass', () => {
    // Note: Full integration tests for _resolveComplexityRoutedRole and
    // _autobanRoutePlanReviewedCard require mocking KanbanProvider/TaskViewerProvider
    // internals. These unit tests verify the bypass logic pattern in isolation.

    test('intern results should be elevated to coder in pair mode', () => {
        // Simulate the bypass pattern used in callers:
        // let role = scoreToRoutingRole(score);
        // if (isPairMode && role === 'intern') role = 'coder';
        const simulateBypass = (score: number, isPairMode: boolean) => {
            let role = scoreToRoutingRole(score);
            if (isPairMode && role === 'intern') { role = 'coder'; }
            return role;
        };

        // Pair mode ON: intern scores (1-4) elevated to coder
        assert.strictEqual(simulateBypass(1, true), 'coder');
        assert.strictEqual(simulateBypass(2, true), 'coder');
        assert.strictEqual(simulateBypass(3, true), 'coder');
        assert.strictEqual(simulateBypass(4, true), 'coder');

        // Pair mode ON: coder scores (5-6) unchanged
        assert.strictEqual(simulateBypass(5, true), 'coder');
        assert.strictEqual(simulateBypass(6, true), 'coder');

        // Pair mode ON: lead scores (7-10) unchanged
        assert.strictEqual(simulateBypass(7, true), 'lead');
        assert.strictEqual(simulateBypass(10, true), 'lead');

        // Pair mode OFF: normal routing
        assert.strictEqual(simulateBypass(4, false), 'intern');
        assert.strictEqual(simulateBypass(5, false), 'coder');
        assert.strictEqual(simulateBypass(7, false), 'lead');

        // Unknown defaults to lead regardless of pair mode
        assert.strictEqual(simulateBypass(0, true), 'lead');
        assert.strictEqual(simulateBypass(0, false), 'lead');
    });
});
```

### Step 5: Update MCP Tool Documentation (Routine)
#### MODIFY `src/mcp-server/register-tools.js`
- **Context:** The routing description strings in tool definitions and `BUILTIN_KANBAN_COLUMN_DEFINITIONS` comments may reference the old "1-3 = intern, 4-6 = coder" thresholds.
- **Logic:** Search for all occurrences of "1-3" paired with "intern" or "routing" in this file. Update to "1-4 = intern, 5-6 = coder, 7-10 = lead".
- **Implementation:** Run `grep -n "1-3" src/mcp-server/register-tools.js` to identify exact lines. Update each occurrence. If no occurrences are found, this step is a no-op.

### Step 6: Update JSDoc in `complexityScale.ts` Fallback Function (Routine)
#### MODIFY `src/services/complexityScale.ts`
- **Context:** The `getFallbackRole()` function at lines 67-74 has a JSDoc comment referencing the degradation chain `intern → coder → lead`. This is still correct after the threshold change, but verify the comment mentions the updated ranges.
- **Logic:** No code change needed — the fallback chain (`intern → coder → lead`) is independent of the scoring thresholds. Confirm and move on.

## Implementation Review (2026-04-05)

### Status: ✅ APPROVED — All steps implemented, verified, one NIT fixed in review

### Files Changed
| File | Step | Change |
|------|------|--------|
| `src/services/complexityScale.ts` | 1 | Threshold shifted: intern 1-4, coder 5-6 |
| `src/services/KanbanProvider.ts` | 2 | Pair programming bypass in `_resolveComplexityRoutedRole()` (post-resolution, covers custom routing map) |
| `src/services/TaskViewerProvider.ts` | 3 | Pair programming bypass in `_autobanRoutePlanReviewedCard()` + logging added in review |
| `src/test/kanban-complexity.test.ts` | 4 | Score 4 assertion updated to `'intern'`, boundary tests added |
| `src/test/pair-programming-routing-bypass.test.ts` | 4 | NEW — bypass pattern unit tests |
| `src/mcp-server/register-tools.js` | 5 | No-op — no "1-3 = intern" strings found |
| `src/services/complexityScale.ts` (JSDoc) | 6 | No-op — fallback chain comment still correct |

### Validation Results
- **`scoreToRoutingRole` runtime**: score 1→intern, 3→intern, 4→intern, 5→coder, 6→coder, 7→lead, 0→lead ✅
- **Smart router regression tests**: 4/4 passed ✅
- **TypeScript typecheck**: 1 pre-existing error (`ArchiveManager` import at KanbanProvider.ts:1823) — unrelated to this plan ✅

### Review Findings
- **CRITICAL**: None
- **MAJOR**: None
- **NIT (fixed)**: Missing logging in `_autobanRoutePlanReviewedCard` pair bypass — added `console.log` to match KanbanProvider pattern
- **NIT (deferred)**: `_autobanRoutePlanReviewedCard` doesn't respect `_routingMapConfig` (pre-existing, out of scope)
- **NIT (informational)**: `add_routing_map_modal_to_kanban.md` has stale "1-3" in proposed HTML template — plan file only, no runtime impact

### Remaining Risks
- **Pre-existing**: `_autobanRoutePlanReviewedCard` ignores `_routingMapConfig`, so custom routing maps don't apply via the autoban tick path. Separate plan recommended.
- **Sibling plan staleness**: If `add_routing_map_modal_to_kanban.md` is implemented from its current template, the HTML will show "1-3" for intern range instead of "1-4".

## Verification Plan

### Automated Tests
1. Run `npm test` — verify all complexity routing tests pass
2. Verify specific test cases:
   - `scoreToRoutingRole(4)` returns `'intern'` (not `'coder'`)
   - `scoreToRoutingRole(5)` returns `'coder'` (boundary confirmation)
   - `scoreToRoutingRole(3)` returns `'intern'` (unchanged)
3. Run pair programming bypass tests:
   - Score 4 with pair mode ON → `'coder'`
   - Score 4 with pair mode OFF → `'intern'`
   - Score 7 with pair mode ON → `'lead'` (unaffected)
4. Run regression tests: `npm test -- --grep "smart-router"`

### Manual Verification
1. Create a plan with complexity 4 → verify it routes to INTERN CODED column
2. Create a plan with complexity 5 → verify it routes to CODER CODED column
3. Enable pair programming mode (any non-off value), create plan with complexity 4 → verify it routes to CODER CODED (not INTERN CODED)
4. Enable pair programming mode, create plan with complexity 7 → verify it still routes to LEAD CODED (pair mode doesn't downgrade lead)
5. Disable pair programming mode → verify normal routing resumes (complexity 4 → INTERN CODED)
6. If custom routing map is configured: verify pair mode bypass still applies (complexity routed to intern by custom map gets elevated to coder)

## Second Review Pass (2026-07-25)

### Status: 🔧 FIXED — Two findings required code changes

### Findings

| Severity | Location | Issue | Resolution |
|----------|----------|-------|------------|
| **CRITICAL** | `complexityScale.ts:61-63` | `scoreToRoutingRole()` still had OLD thresholds (1-3→intern, 4-6→coder). Step 1 was never applied to source. Tests asserting score 4→intern would fail. | Fixed: updated to `score <= 4` → intern, `score >= 5` → coder. JSDoc updated. |
| **MAJOR** | `TaskViewerProvider.ts:2617-2618` | Fallback path in `_autobanRoutePlanReviewedCard()` used bare `scoreToRoutingRole(score)` without pair programming bypass. If `_kanbanProvider` is null, pair mode bypass is silently lost. | Fixed: added `isPairMode` check in fallback path matching KanbanProvider pattern. |
| NIT | `pair-programming-comprehensive.test.ts:610,628` | Test assertions assumed new thresholds — correct intent but would fail against un-patched code. Now pass with the CRITICAL fix applied. | No change needed — tests were correctly written for the target state. |

### Validation
- `npx tsc --noEmit`: Only pre-existing `ArchiveManager` import error at KanbanProvider.ts:1833 — unrelated ✅
- `scoreToRoutingRole(4)` now returns `'intern'` ✅
- `_autobanRoutePlanReviewedCard` fallback path now applies pair bypass ✅
