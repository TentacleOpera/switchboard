# Trim the Verbose Coder Prompt Intro (Drop Complexity & Source-Column Preamble)

## Goal

The coder dispatch prompt currently opens with noise the agent does not need:

> "Please execute the following 3 low-complexity plans from the planned column."

Neither the **complexity descriptor** ("low-complexity") nor the **provenance** ("from the … column") affects how the coder should execute the plan — the plan file already contains everything actionable. Strip both so the intro reads simply:

> "Please execute the following 3 plans."

### Problem analysis & root cause

In `src/services/agentPromptBuilder.ts`, `buildKanbanBatchPrompt` builds two pieces of preamble:

- A **source-column suffix** (`sourceSuffix`), derived from `options.sourceColumnLabel`:
  ```ts
  // line 742 (lead), line 791 (coder)
  const sourceSuffix = sourceColumnLabel ? ` from the ${sourceColumnLabel} column` : '';
  ```
- A **complexity-qualified intro** for the coder when the dispatch instruction is `'low-complexity'`:
  ```ts
  // line 792
  const intro = baseInstruction === 'low-complexity'
      ? `Please execute the following ${plans.length} low-complexity plans${sourceSuffix}.`
      : `Please execute the following ${plans.length} plans${sourceSuffix}.`;
  ```

The `'low-complexity'` instruction is supplied by `handleBatchDispatchLow` (`TaskViewerProvider.ts` line 8015, the `handleKanbanBatchTrigger('coder', sessionIds, 'low-complexity', …)` call), which dispatches LOW-complexity PLAN REVIEWED cards to the coder. The complexity label leaks an internal routing detail into the agent prompt; the column suffix leaks Kanban-board provenance. Both are inert to execution.

**Root cause:** the intro string was built to echo dispatch metadata that has no bearing on the coder's task. The fix is to drop that metadata from the intro. This is a self-contained string/templating change plus test updates.

## Metadata

- **Tags:** refactor, test
- **Complexity:** 2/10
- **Primary files:** `src/services/agentPromptBuilder.ts`, `src/services/__tests__/agentPromptBuilder.test.ts`
- **User-facing review items:** None.

## User Review Required

- **Lead intro trim (scope decision):** The user's original complaint named only the *coder* prompt. This plan also trims the **lead** intro's `from the … column` suffix for consistency, since the same provenance noise applies to both roles. This is a minor product-scope expansion. **Confirm that trimming the lead intro is desired** before implementing; if not, implement only the coder changes (steps 1, 3, and the coder-only test updates) and leave the lead path untouched.

## Complexity Audit

### Routine
- Simplify the coder intro in `agentPromptBuilder.ts` (line 792–794): collapse the `low-complexity` ternary into a single default intro string.
- Remove the now-dead `sourceSuffix` local declarations (lines 742, 791).
- Remove the now-dead `sourceColumnLabel` local (line 445) and `baseInstruction` local (line 435) — both become unused after the intro simplification. (Clarification: these locals are consumed *only* by the code being removed; deleting them avoids lint unused-var warnings.)
- Trim the lead intro suffix (line 778) for consistency.
- Add a `@deprecated` JSDoc note to the `sourceColumnLabel` option on `PromptBuilderOptions` (line 136) so future maintainers know it is no longer consumed by the prompt builder. Do **not** remove the field or update callers — that widens blast radius for a cosmetic change.
- Rename and flip three tests in `agentPromptBuilder.test.ts` so their names and assertions reflect the new contract (no `from the … column`, no `low-complexity`).

### Complex / Risky
- None. No state, no migration, no persisted data; prompt text only.

## Edge-Case & Dependency Audit

- **`sourceColumnLabel` becomes unused in the prompt builder.** It is referenced *only* at lines 742 and 791 (the `sourceSuffix` declarations) via the local at line 445. After removal, the local at line 445 is dead — remove it. Keep the `sourceColumnLabel?: string` field on `PromptBuilderOptions` (line 136) and mark it `@deprecated`; the callers in `KanbanProvider.ts` (lines 2606, 2609, 3413, 3415, 3463, 3498, 6392, 6394) still pass it harmlessly. Removing the option type or caller plumbing is a wider blast radius with no benefit for a cosmetic prompt change.
- **`baseInstruction` local becomes unused.** The local at line 435 (`const baseInstruction = options?.instruction;`) is consumed *only* at line 792 (the ternary being deleted). After the ternary is collapsed, line 435 is dead — remove it to avoid lint noise. The `instruction?: string` option on `PromptBuilderOptions` (line 94) is still passed by `handleBatchDispatchLow` and other callers; leaving it flowing in is harmless. No need to touch `handleBatchDispatchLow`.
- **`baseInstruction === 'low-complexity'` branch collapses.** Once the complexity word is gone, both branches of the coder `intro` ternary produce the same string, so the ternary is replaced with the single default intro. The `'low-complexity'` instruction value is still passed by `handleBatchDispatchLow` and is used elsewhere only for this branch — leaving it flowing in is harmless.
- **Lead role consistency.** The `lead` intro (line 778) also appends the column suffix (`Please execute the following N plans from the … column.`). The user's complaint named the coder, but the same provenance noise applies to the lead. This plan trims the lead suffix too for consistency (see **User Review Required** above). No complexity word exists on the lead path, so only the suffix is removed.
- **Other roles unaffected.** `intern`/`analyst` already use `Please process the following N plans.` with no suffix; `planner`, `reviewer`, `tester`, etc. have their own intros and do not use `sourceColumnLabel`. No change there.
- **Tests will fail loudly if not updated.** `agentPromptBuilder.test.ts` has three assertions tied to the current strings (see Verification). They must be **renamed and flipped**, not deleted, so the new contract is locked in and test names remain truthful.
- **`kanban-prompt-generation-unit.test.js` is safe.** That file (lines 42, 82) only mocks the `sourceColumnLabel` plumbing through `_generatePromptForDestinationRole`; it does not assert on prompt text containing `from the … column`. No update needed there.
- **No migration.** Prompt text is generated fresh each dispatch; nothing persisted. Safe clean change for all ~4,000 installs.

## Dependencies

- None. This plan is self-contained and has no prerequisite sessions.

## Adversarial Synthesis

Key risks: (1) two dead local variables (`baseInstruction` at line 435, `sourceColumnLabel` at line 445) left behind if cleanup is incomplete — causes lint warnings; (2) test names becoming misleading if tests are flipped but not renamed; (3) the lead-intro trim is a quiet product-scope expansion the user did not explicitly request. Mitigations: explicitly remove both dead locals, rename all flipped tests to reflect the new contract, and surface the lead-trim as a User Review Required item.

## Proposed Changes

### 1. `src/services/agentPromptBuilder.ts` — coder intro (lines 790–794)

Remove the `sourceSuffix` local (line 791) and collapse the `low-complexity` ternary (lines 792–794) into a single intro:

```ts
if (role === 'coder') {
    const intro = `Please execute the following ${plans.length} plans.`;
    // ...rest unchanged...
```

### 2. `src/services/agentPromptBuilder.ts` — lead intro (lines 742, 778)

Remove the `sourceSuffix` local (line 742) and change line 778 to drop the suffix:

```ts
// delete line 742: const sourceSuffix = sourceColumnLabel ? ` from the ${sourceColumnLabel} column` : '';
// change line 778:
`Please execute the following ${plans.length} plans.`,
```

### 3. `src/services/agentPromptBuilder.ts` — remove dead locals (lines 435, 445)

After steps 1–2, these two locals are no longer consumed anywhere in `buildKanbanBatchPrompt`:

```ts
// delete line 435: const baseInstruction = options?.instruction;
// delete line 445: const sourceColumnLabel = options?.sourceColumnLabel;
```

**Clarification:** Both locals are consumed *only* by the code removed in steps 1–2. Deleting them prevents lint unused-var warnings. The corresponding `instruction` and `sourceColumnLabel` options remain on `PromptBuilderOptions` and are still passed by callers — that is intentional and harmless.

### 4. `src/services/agentPromptBuilder.ts` — deprecate `sourceColumnLabel` option (line 136)

Add a `@deprecated` JSDoc tag so future maintainers know the field is no longer consumed:

```ts
/**
 * @deprecated No longer consumed by the prompt builder. Callers still pass it
 * harmlessly; retained to avoid widening the blast radius of the intro cleanup.
 */
sourceColumnLabel?: string;
```

### 5. `src/services/__tests__/agentPromptBuilder.test.ts` — rename and flip assertions

Three tests encode the old behaviour and must be **renamed and flipped** (renaming is required so test names remain truthful):

- **Line 27 — rename to `"omits source column label even when provided"` (coder):**
  ```ts
  test('omits source column label even when provided', () => {
      const prompt = buildKanbanBatchPrompt('coder', makePlans(2), {
          sourceColumnLabel: 'Planned'
      });
      assert.ok(!prompt.includes('from the Planned column'), 'Should NOT include source column label');
      assert.ok(!prompt.includes('from the'), 'Should NOT contain "from the" at all');
      assert.ok(prompt.includes('Please execute the following 2 plans.'), 'Should have clean intro');
  });
  ```

- **Line 41 — rename to `"omits complexity and source column for low-complexity coder prompt"`:**
  ```ts
  test('omits complexity and source column for low-complexity coder prompt', () => {
      const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
          instruction: 'low-complexity',
          sourceColumnLabel: 'TEST'
      });
      assert.ok(!prompt.includes('from the TEST column'), 'Should NOT include source column label');
      assert.ok(!prompt.includes('low-complexity'), 'Should NOT include low-complexity text');
      assert.ok(prompt.includes('Please execute the following 1 plans.'), 'Should have clean intro');
  });
  ```

- **Line 52 — rename to `"omits source column label even when provided"` (lead):**
  ```ts
  test('omits source column label even when provided', () => {
      const prompt = buildKanbanBatchPrompt('lead', makePlans(2), {
          sourceColumnLabel: 'Planned'
      });
      assert.ok(!prompt.includes('from the Planned column'), 'Should NOT include source column label');
      assert.ok(prompt.includes('Please execute the following 2 plans.'), 'Should have clean intro');
  });
  ```

The "omits source column label when not provided" tests (lines 35, 59) already assert `Please execute the following 2 plans.` and `!includes('from the')` — those now pass unconditionally and can stay as-is (they become the canonical assertion).

## Verification Plan

### Automated Tests
- **Skipped per session directive.** The prompt-builder suite (`agentPromptBuilder.test.ts`) will be run separately by the user. After the assertion flips and renames, all cases should pass; specifically confirm no coder/lead prompt contains `low-complexity` or `from the … column`.

### Manual Verification
1. **Manual (primary):** dispatch a LOW-complexity PLAN REVIEWED card to the coder via the batch-dispatch-low path and inspect the generated prompt in the terminal — it should open `Please execute the following 1 plans.` with no complexity or column preamble.
2. **Manual (regression):** dispatch a normal (non-low) coder batch and a lead batch; confirm both intros are clean and the `PLANS TO PROCESS:` block, safeguards, and base instructions are otherwise unchanged.
3. **grep check:** confirm no remaining production reference builds the phrase ` from the ${...} column` for coder/lead intros, that `sourceColumnLabel` is no longer consumed in those intros, and that `baseInstruction` / `sourceColumnLabel` locals (lines 435, 445) are removed.
4. **Lint check:** confirm no unused-variable warnings are emitted for `agentPromptBuilder.ts` after the dead-local removal.
5. **Compilation skipped per session directive** (`npm run compile` is only required for producing a VSIX).

---

**Recommendation:** Complexity is 2/10 → **Send to Intern**.

---

## Reviewer Pass (in-place, 2026-06-24)

### Stage 1 — Grumpy Principal Engineer

*cracks knuckles, glares at the diff*

Alright, let's see what the intern actually shipped for this "drop two words from a string" task. Complexity 2/10. Should be impossible to screw up. Let's find out if they managed anyway.

**NIT — `instruction` JSDoc still name-drops `'low-complexity'`** (`agentPromptBuilder.ts:94`): The `instruction?: string` option's doc comment still reads `/** Base instruction hint (e.g. 'enhance', 'low-complexity', 'implement-all'). */`. The `'low-complexity'` value is now a dead input as far as the prompt builder is concerned — it flows in from `handleBatchDispatchLow` and is silently ignored. The plan explicitly chose NOT to deprecate `instruction` (only `sourceColumnLabel` got the `@deprecated` tag), and the example list is technically still accurate as "values callers may pass", so this is cosmetic. But a future maintainer reading line 94 will reasonably assume `low-complexity` still does something. Not a defect against the plan; flagging for awareness. **Severity: NIT.**

**NIT — Test name collision** (`agentPromptBuilder.test.ts:27` and `:54`): Both the coder suite and the lead suite now have a test literally named `'omits source column label even when provided'`. The plan spec literally prescribed this exact duplication (it gave the same rename for both line 27 and line 52), so the intern followed orders. But two tests with identical names in different `suite()` blocks is a mild smell — if one fails, the test runner output is ambiguous about which role broke. Mocha namespaces by suite so it's resolvable, but `omits source column label even when provided (coder)` / `… (lead)` would have been kinder. **Severity: NIT.** Not fixing — the plan dictated the names verbatim and deviating would violate "treat the plan as source of truth."

**Observation — `instruction` option is now fully inert in the builder.** With the `baseInstruction === 'low-complexity'` ternary gone, `options.instruction` is no longer read anywhere in `buildKanbanBatchPrompt`. The plan acknowledged this ("leaving it flowing in is harmless") and deliberately did NOT deprecate the field. Correct call for blast-radius containment. No action. Just noting that the builder now has two deprecated-by-behavior options (`instruction`, `sourceColumnLabel`) where only the latter is marked. Acceptable per plan scope.

**Observation — `kanban-prompt-generation-unit.test.js` confirmed untouched.** Grep confirms no `from the … column` or `low-complexity plans` assertions exist in that file; it only mocks the plumbing. Plan said "no update needed" — verified correct.

**Observation — no other role intros regressed.** `intern`/`analyst` use `Please process the following N plans.` (unchanged); `reviewer`/`tester` use their own execution intros (unchanged). Only `lead` (line 778) and `coder` (line 791) were touched, exactly as scoped.

*leans back* Honestly? This is clean. The intern did the boring thing correctly. No CRITICAL, no MAJOR. Two NITs, both inherited from the plan's own spec rather than introduced by the implementer. Ship it.

### Stage 2 — Balanced Synthesis

| Finding | Severity | Disposition |
|---|---|---|
| `instruction` JSDoc still cites `'low-complexity'` as a live value | NIT | **Defer.** Plan explicitly scoped `instruction` as out-of-bounds for deprecation. Touching it now expands scope. Log for a future "option hygiene" pass. |
| Duplicate test name across coder/lead suites | NIT | **Keep as-is.** Plan dictated the exact names verbatim. Renaming would deviate from the source-of-truth spec. Mocha suite namespacing makes failures resolvable. |
| Dead locals `baseInstruction` / `sourceColumnLabel` / `sourceSuffix` | (none — already fixed) | **Verified removed.** Grep confirms zero remaining declarations. |
| `sourceColumnLabel` field deprecated in place | (none — already done) | **Verified.** `@deprecated` JSDoc present at line 136–138; field retained at line 139. |
| Coder/lead intros cleaned | (none — already done) | **Verified.** Lines 778 and 791 both emit `Please execute the following ${plans.length} plans.` with no suffix or complexity word. |
| Other roles untouched | (none) | **Verified.** Only lead + coder intros changed. |

**Verdict:** No CRITICAL or MAJOR findings. No code fixes required — the implementation matches the plan exactly. Both NITs are plan-inherited, not implementer-introduced, and fixing either would violate the plan's explicit scope boundaries.

### Code Fixes Applied

None. The implementation was already correct against the plan spec.

### Verification Results

Per session directives: compilation (`npm run compile`) and automated tests were **skipped**. The following read-only checks were run:

1. **grep — dead locals removed:** `const baseInstruction = | const sourceColumnLabel = | const sourceSuffix =` → **0 matches** in `agentPromptBuilder.ts`. ✅
2. **grep — no residual intro provenance:** `from the ${...} column` / `low-complexity plans` in production intro code → **0 matches** (only the `instruction` JSDoc example at line 94 mentions `low-complexity`, which is documentation, not intro text). ✅
3. **grep — clean intros:** `Please execute the following` → exactly 2 matches (lines 778 lead, 791 coder), both clean. ✅
4. **grep — `sourceColumnLabel` consumption:** appears only at line 139 (the deprecated field declaration). No reads inside `buildKanbanBatchPrompt`. ✅
5. **Test file review:** three tests renamed and flipped per spec (lines 27, 42, 54); negative assertions lock in the new contract; the two "when not provided" tests (lines 36, 62) remain canonical. ✅
6. **`kanban-prompt-generation-unit.test.js`:** confirmed no assertions on removed phrases; no update needed (matches plan). ✅
7. **Lint (unused-var):** dead locals are gone, so no unused-variable warnings will fire for the removed declarations. The retained `sourceColumnLabel` field is a class/interface member, not a local, so it does not trigger unused-local lint. ✅ (static reasoning; linter not executed per skip directives)

### Files Changed (by implementer, pre-review)

- `src/services/agentPromptBuilder.ts` — coder intro collapsed (line 791), lead intro suffix dropped (line 778), dead locals removed (formerly lines 435, 445, 742, 791), `@deprecated` JSDoc added to `sourceColumnLabel` (lines 136–138).
- `src/services/__tests__/agentPromptBuilder.test.ts` — three tests renamed and flipped (lines 27, 42, 54); two canonical "when not provided" tests retained (lines 36, 62).

### Remaining Risks

- **`instruction` option is now behaviorally dead in the builder** but not marked deprecated. A future maintainer could waste time tracing why passing `instruction: 'low-complexity'` does nothing. Low impact; deferred to a future option-hygiene pass.
- **Duplicate test names** across coder/lead suites (`'omits source column label even when provided'`). Resolvable via Mocha suite namespacing but slightly ambiguous in flat test output. Inherited from plan spec.
- **No automated test run this session** (skipped per directive). The user should run the `agentPromptBuilder.test.ts` suite to confirm the flipped assertions pass against the compiled builder.
