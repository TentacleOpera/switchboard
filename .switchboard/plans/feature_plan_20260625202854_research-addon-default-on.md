# Research Add-on ("Advise Research If Unsure") Should Be Active by Default

## Goal

The "Advise Research If Unsure" add-on for the planner agent should be ON by default. The user reports it is not consistently active when a fresh install or new workspace is used. Investigation reveals a **three-layer default inconsistency**: the webview UI defaults to ON, the KanbanProvider prompt-resolution defaults to ON, but the `DEFAULT_ROLE_CONFIG` in `sharedDefaults.js` does **not** include `adviseResearch` at all (it is `undefined`), and the `agentPromptBuilder.ts` fallback defaults to **OFF** (`?? false`).

### Problem
The "Advise Research If Unsure" add-on for the planner agent should be ON by default. The user reports it is not consistently active when a fresh install or new workspace is used.

### Root Cause
The default value of `adviseResearch` is handled differently across three code layers:

1. **Webview UI** (`kanban.html` line 3215): `config.addons?.adviseResearch !== false` → defaults to `true` when `undefined`. ✅ Correct.
2. **KanbanProvider** (`KanbanProvider.ts` line 3113): `plannerConfig?.addons?.adviseResearch ?? true` → defaults to `true` when `undefined`. ✅ Correct.
3. **agentPromptBuilder** (`agentPromptBuilder.ts` line 440): `options?.adviseResearchIfUnsure ?? false` → defaults to **`false`** when `undefined`. ❌ Incorrect.
4. **DEFAULT_ROLE_CONFIG** (`sharedDefaults.js` line 25): `adviseResearch` is **not listed** in the planner addons object. ❌ Missing.

The critical gap is **layer 3**: if any code path calls `agentPromptBuilder` without passing `adviseResearchIfUnsure` in the options (i.e., without going through KanbanProvider's resolution that sets it to `true`), the directive is silently omitted from the prompt. Layer 4 means the config object never explicitly carries the value — it relies on `undefined`-coalescing at every read site, which is fragile.

**Call-site analysis:** The KanbanProvider resolution path (line 2885 → line 3113) always sets `adviseResearchIfUnsure` to an explicit boolean (`true` or `false`), so the `?? false` fallback in `agentPromptBuilder.ts` is only hit by calls that bypass KanbanProvider — primarily direct test calls with `{}` and the 'chat' role calls (which don't use the planner prompt path, so the directive isn't injected regardless). However, any future code path or extension API that calls `buildKanbanBatchPrompt('planner', ...)` without explicit options would silently omit the directive. The fix makes the default safe.

### Desired Behavior
- `adviseResearch: true` is explicitly listed in `DEFAULT_ROLE_CONFIG.planner.addons` in `sharedDefaults.js`.
- `agentPromptBuilder.ts` defaults `adviseResearchIfUnsure` to `true` (not `false`) when the option is not provided.
- The webview checkbox is checked by default for fresh installs (already works, but now backed by an explicit default).
- The existing unit test that asserts `undefined` omits the directive is updated to assert `undefined` now INCLUDES the directive (reflecting the corrected default).

## Metadata

- **Tags**: `backend`, `bugfix`
- **Complexity**: 2/10
- **Files touched**: 3 (`src/webview/sharedDefaults.js`, `src/services/agentPromptBuilder.ts`, `src/services/__tests__/agentPromptBuilder.test.ts`)
- **Risk**: Low — changing a default value from implicit-true to explicit-true, fixing a fallback from false to true, and updating one test to match the corrected behavior.

## User Review Required

No user review required. This is a straightforward default-value fix with no architectural impact, no data migration, and no breaking changes to persisted user configs (explicit `false` values are still respected by all three layers).

## Complexity Audit

### Routine
- Adding a single key (`adviseResearch: true`) to an existing addons object in `sharedDefaults.js`.
- Changing `?? false` to `?? true` on one line in `agentPromptBuilder.ts`.
- Updating one test assertion from "omits" to "includes" in `agentPromptBuilder.test.ts`.
- No structural changes, no new code paths, no new dependencies.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions:** None. All changes are to static default values and synchronous option resolution. No concurrent state access involved.

**Security:** None. No secrets, credentials, or security-sensitive code paths touched.

**Side Effects:**
- Existing users who explicitly turned the add-on OFF have `adviseResearch: false` persisted in their config. The `!== false` check (webview) and `?? true` check (KanbanProvider) both respect explicit `false`. No behavior change for these users.
- Existing users who never touched the add-on: their saved config may or may not have `adviseResearch`. If missing, the new explicit default `true` in `DEFAULT_ROLE_CONFIG` will be merged in on load. If present as `undefined`, the `?? true` / `!== false` checks already handle it. No behavior change — it was already defaulting to ON.
- Fresh installs: `DEFAULT_ROLE_CONFIG` now explicitly includes `adviseResearch: true`. The checkbox will be checked. The prompt builder will include the directive even if the option is not passed. ✅ Fixed.
- `agentPromptBuilder` called without options (bypassing KanbanProvider): Previously defaulted to `false` (directive omitted). Now defaults to `true` (directive included). This is the intended behavior — the research directive should be present unless explicitly disabled.
- Non-planner roles: `adviseResearch` is only read for the planner role (the `ADVISE_RESEARCH_DIRECTIVE` injection at `agentPromptBuilder.ts` line 538-539 is inside the planner base-building section). The `DEFAULT_ROLE_CONFIG` change is scoped to `planner.addons` only. The `agentPromptBuilder` default change affects the fallback for all roles, but only the planner path injects the directive, so non-planner roles are unaffected.

**Dependencies & Conflicts:**
- The unit test at `agentPromptBuilder.test.ts` line 171-173 (`adviseResearchIfUnsure: undefined omits research directive`) explicitly asserts the current buggy behavior. This test MUST be updated to assert the new correct behavior (undefined → includes directive). Failure to update this test will cause a test failure.
- Migration concern: This feature has only existed in unreleased dev work (the `adviseResearch` key was never in a shipped `DEFAULT_ROLE_CONFIG`). Per CLAUDE.md rules, unreleased features can take clean breaks — no migration needed. Even if this assumption is wrong and it did ship, the desired behavior (default ON) is what we're implementing, and explicit `false` values are still respected, so the risk is negligible.

## Dependencies

None — this is a self-contained default-value fix with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) the existing unit test at `agentPromptBuilder.test.ts:171-173` asserts the current `?? false` behavior and will break if not updated — it must be changed to assert that `undefined` now includes the directive; (2) the plan originally cited incorrect line numbers for `kanban.html` (3266 → actual 3215) and `KanbanProvider.ts` (3112 → actual 3113), which would mislead an implementer; (3) the "unreleased feature" migration claim is unverified but low-risk since the desired default-ON behavior is correct regardless. Mitigations: add the test file as a third touched file, correct all line numbers, and note that even if the feature shipped, the fix is safe.

## Proposed Changes

### File: `src/webview/sharedDefaults.js`

#### Change 1: Add `adviseResearch: true` to planner addons

**Line 25** — add `adviseResearch: true` to the planner addons object:

```javascript
// BEFORE:
addons: { switchboardSafeguards: true, designDoc: false, constitution: false, aggressivePairProgramming: false, gitProhibition: false, clearAntigravityContext: false, cavemanOutput: true, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: true }

// AFTER:
addons: { switchboardSafeguards: true, designDoc: false, constitution: false, aggressivePairProgramming: false, gitProhibition: false, clearAntigravityContext: false, cavemanOutput: true, adviseResearch: true, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: true }
```

**Context:** The `DEFAULT_ROLE_CONFIG` object (line 22-40) defines the default addon configuration for every role. The `planner` role (line 23-26) currently omits `adviseResearch`, relying on `undefined`-coalescing at every read site. Adding it explicitly makes the default self-documenting and ensures the value is present when the config is merged/cloned.

### File: `src/services/agentPromptBuilder.ts`

#### Change 2: Fix the fallback default from `false` to `true`

**Line 440**:

```typescript
// BEFORE:
const adviseResearchIfUnsure = options?.adviseResearchIfUnsure ?? false;

// AFTER:
const adviseResearchIfUnsure = options?.adviseResearchIfUnsure ?? true;
```

**Context:** This fallback is hit when `buildKanbanBatchPrompt` is called without `adviseResearchIfUnsure` in the options object. The KanbanProvider resolution path (line 2885 → line 3113) always sets this to an explicit boolean, so the fallback only affects direct calls that bypass KanbanProvider. Changing it to `true` ensures the research directive is included by default, matching the intent of the other two layers. The directive is only injected for the planner role (line 538-539), so non-planner roles are unaffected.

### File: `src/services/__tests__/agentPromptBuilder.test.ts`

#### Change 3: Update the `undefined` test to assert the new default-ON behavior

**Lines 171-174** — the test currently asserts that `undefined` OMITS the directive. It must be updated to assert that `undefined` now INCLUDES the directive:

```typescript
// BEFORE:
test('adviseResearchIfUnsure: undefined omits research directive', () => {
    const prompt = buildKanbanBatchPrompt('planner', makePlans(1), {});
    assert.ok(!prompt.includes('RESEARCH WHEN UNSURE:'), 'Should NOT include research directive');
});

// AFTER:
test('adviseResearchIfUnsure: undefined includes research directive (default ON)', () => {
    const prompt = buildKanbanBatchPrompt('planner', makePlans(1), {});
    assert.ok(prompt.includes('RESEARCH WHEN UNSURE:'), 'Should include research directive by default');
    assert.ok(prompt.includes('.agents/skills/advise_research/SKILL.md'), 'Should include path to skill file');
});
```

**Context:** The test suite at lines 159-174 has three tests: `true` includes, `false` omits, `undefined` omits. After the fix, `undefined` should include (default ON). The `true` and `false` tests remain valid and unchanged. This test update is mandatory — without it, the test suite will fail.

## Verification Plan

### Automated Tests
*(Test suite will be run separately by the user — not executed in this session.)*

The following tests in `src/services/__tests__/agentPromptBuilder.test.ts` should pass after implementation:
- `adviseResearchIfUnsure: true includes research directive` — unchanged, should still pass.
- `adviseResearchIfUnsure: false omits research directive` — unchanged, should still pass.
- `adviseResearchIfUnsure: undefined includes research directive (default ON)` — updated test, should pass.

### Manual Verification
1. **Manual test — fresh config**:
   - Clear the persisted planner role config (or use a fresh workspace).
   - Open the Prompts tab in kanban.html.
   - Verify the "Advise Research If Unsure" checkbox is **checked**.
2. **Manual test — prompt generation**:
   - With the checkbox checked (default), trigger a planner dispatch from the kanban board.
   - Inspect the generated prompt (via logs or the terminal) — verify the `ADVISE_RESEARCH_DIRECTIVE` text is present.
3. **Manual test — explicitly disabled**:
   - Uncheck the "Advise Research If Unsure" checkbox.
   - Trigger a planner dispatch.
   - Verify the `ADVISE_RESEARCH_DIRECTIVE` text is **not** present in the prompt.
4. **Manual test — agentPromptBuilder fallback**:
   - Trace any code path that calls the prompt builder without passing `adviseResearchIfUnsure` in options.
   - Verify the directive is now included (previously it would have been omitted).

*(Compilation and automated test execution are skipped per session directives.)*

## Recommendation

Complexity is 2/10 → **Send to Intern**.

---

## Reviewer Pass (2026-06-25)

### Stage 1 — Grumpy Findings

| Severity | Finding | Location |
| :--- | :--- | :--- |
| NIT | Plan cited `kanban.html:3215` and `KanbanProvider.ts:3113`; actual lines are `kanban.html:3263` and `KanbanProvider.ts:3215`. Adversarial Synthesis caught the kanban.html drift but missed the KanbanProvider drift. Implementer navigated correctly regardless. | Plan "Root Cause" section |
| NIT | Plan's call-site analysis claimed the `?? false` fallback was "only hit by calls that bypass KanbanProvider." This is **incomplete**: `KanbanProvider.ts:2949` (`resolvedOptions.adviseResearchIfUnsure = promptsConfig.adviseResearchIfUnsure;`) is an in-KanbanProvider path that passes the value through without a `?? true` guard, so it also relied on the agentPromptBuilder fallback. The fix still plugs this hole correctly. | `KanbanProvider.ts:2949` |
| NIT | Asymmetry: line 2949 has no `?? true` coalescing while line 3215 does. Functionally safe today (agentPromptBuilder fallback covers it), but a fragility if the fallback is ever reverted. Optional hardening: add `?? true` at line 2949. | `KanbanProvider.ts:2949` |

No CRITICAL or MAJOR findings. All three code changes landed correctly.

### Stage 2 — Balanced Synthesis

**Keep as-is:** All three code changes are correct and match the plan's intent. Four-layer consistency (webview `!== false`, KanbanProvider:3215 `?? true`, KanbanProvider:2949 pass-through, agentPromptBuilder:482 `?? true`) is fully aligned to default-ON.

**Fix now:** None required.

**Defer (optional):** Add defensive `?? true` at `KanbanProvider.ts:2949` for symmetry with line 3215. Hardening only — not a correctness issue.

### Code Fixes Applied

None — the implementation was already correct.

### Verification Results

- **Cross-layer consistency**: ✅ All four read sites default to ON when value is absent/undefined.
- **Test assertions**: ✅ Three tests in `adviseResearchIfUnsure option` suite (true includes, false omits, undefined includes) are consistent with implemented defaults.
- **Directive text match**: ✅ `ADVISE_RESEARCH_DIRECTIVE` (`agentPromptBuilder.ts:352`) contains both `RESEARCH WHEN UNSURE:` and `.agents/skills/advise_research/SKILL.md`, matching test assertions.
- **Compilation**: Skipped per session directive.
- **Automated tests**: Skipped per session directive (user runs separately).

### Files Changed (by implementer, verified by reviewer)

1. `src/webview/sharedDefaults.js` line 25 — added `adviseResearch: true` to planner addons.
2. `src/services/agentPromptBuilder.ts` line 482 — changed `?? false` to `?? true`.
3. `src/services/__tests__/agentPromptBuilder.test.ts` lines 171-175 — updated `undefined` test to assert directive is included.

### Remaining Risks

- **Low**: The `KanbanProvider.ts:2949` path relies on the downstream agentPromptBuilder fallback rather than its own `?? true` guard. If the agentPromptBuilder default is ever reverted to `false`, this path would silently omit the directive. Optional mitigation: add `?? true` at line 2949.
- **Low**: Line-number drift in the plan's citations (cosmetic only; code is correct).
