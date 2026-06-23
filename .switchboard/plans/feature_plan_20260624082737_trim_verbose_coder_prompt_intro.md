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
  // line ~791 (coder), ~742 (lead)
  const sourceSuffix = sourceColumnLabel ? ` from the ${sourceColumnLabel} column` : '';
  ```
- A **complexity-qualified intro** for the coder when the dispatch instruction is `'low-complexity'`:
  ```ts
  // line ~792
  const intro = baseInstruction === 'low-complexity'
      ? `Please execute the following ${plans.length} low-complexity plans${sourceSuffix}.`
      : `Please execute the following ${plans.length} plans${sourceSuffix}.`;
  ```

The `'low-complexity'` instruction is supplied by `handleBatchDispatchLow` (`TaskViewerProvider.ts` ~8015), which dispatches LOW-complexity PLAN REVIEWED cards to the coder. The complexity label leaks an internal routing detail into the agent prompt; the column suffix leaks Kanban-board provenance. Both are inert to execution.

**Root cause:** the intro string was built to echo dispatch metadata that has no bearing on the coder's task. The fix is to drop that metadata from the intro. This is a self-contained string/templating change plus test updates.

## Metadata

- **Tags:** prompts, coder, agentPromptBuilder, dispatch, cleanup
- **Complexity:** 2/10
- **Primary files:** `src/services/agentPromptBuilder.ts`, `src/services/__tests__/agentPromptBuilder.test.ts`
- **User-facing review items:** None.

## Complexity Audit

**Routine (entire change):**
- Simplify two intro strings in `agentPromptBuilder.ts` (coder, and lead for consistency).
- Update the three prompt-builder tests that currently assert the old behaviour.

**Complex / Risky:** None. No state, no migration, no persisted data; prompt text only.

## Edge-Case & Dependency Audit

- **`sourceColumnLabel` becomes unused in the intro.** It is referenced *only* at lines ~742 and ~791 (the `sourceSuffix`). After removal it is dead in those two spots. Keep the `sourceColumnLabel?: string` field on `PromptBuilderOptions` (line ~136) — removing the option type is a wider blast radius and the callers still pass it harmlessly. Just stop consuming it in the intro. (Optionally drop the now-unused local `sourceSuffix` declarations to avoid lint "unused var" noise.)
- **`baseInstruction === 'low-complexity'` branch collapses.** Once the complexity word is gone, both branches of the coder `intro` ternary produce the same string, so the ternary can be replaced with the single default intro. The `'low-complexity'` instruction value is still passed by `handleBatchDispatchLow` and is used elsewhere only for this branch — leaving it flowing in is harmless; no need to touch `handleBatchDispatchLow`.
- **Lead role consistency.** The `lead` intro (line ~778) also appends the column suffix (`Please execute the following N plans from the … column.`). The user's complaint named the coder, but the same provenance noise applies to the lead. Recommend trimming the lead suffix too for consistency. (No complexity word exists on the lead path, so only the suffix is removed.)
- **Other roles unaffected.** `intern`/`analyst` already use `Please process the following N plans.` with no suffix; `planner`, `reviewer`, `tester`, etc. have their own intros and do not use `sourceColumnLabel`. No change there.
- **Tests will fail loudly if not updated.** `agentPromptBuilder.test.ts` has three assertions tied to the current strings (see Verification). They must be flipped, not deleted, so the new contract is locked in.
- **No migration.** Prompt text is generated fresh each dispatch; nothing persisted. Safe clean change for all ~4,000 installs.

## Proposed Changes

### 1. `src/services/agentPromptBuilder.ts` — coder intro (~790–794)

```ts
if (role === 'coder') {
    const intro = `Please execute the following ${plans.length} plans.`;
    // ...rest unchanged; delete the now-unused `sourceSuffix` line...
```

Remove the `const sourceSuffix = sourceColumnLabel ? … : '';` line and the `baseInstruction === 'low-complexity'` ternary, replacing with the single `intro` above.

### 2. `src/services/agentPromptBuilder.ts` — lead intro (~742, ~778) [recommended, for consistency]

```ts
// delete: const sourceSuffix = sourceColumnLabel ? ` from the ${sourceColumnLabel} column` : '';
// change line ~778:
`Please execute the following ${plans.length} plans.`,
```

### 3. `src/services/__tests__/agentPromptBuilder.test.ts` — update assertions

Three tests encode the old behaviour and must be updated:

- **"includes source column label when provided" (lead, ~27):** flip to assert the intro is `Please execute the following 2 plans.` and that the prompt does **not** include `from the Planned column`.
- **"includes source column label for low-complexity coder prompt" (~41):** flip to assert the prompt does **not** include `low-complexity` and does **not** include `from the TEST column`; assert it includes `Please execute the following N plans.`
- **"includes source column label when provided" (coder, ~52):** flip the same way as the lead test (no `from the … column`).

The "omits source column label when not provided" tests (~35, ~59) already assert `Please execute the following 2 plans.` and `!includes('from the')` — those now pass unconditionally and can stay as-is (they become the canonical assertion).

## Verification Plan

1. **Unit:** run the prompt-builder suite (`agentPromptBuilder.test.ts`). After the assertion flips, all cases pass; specifically confirm no coder/lead prompt contains `low-complexity` or `from the … column`.
2. **Manual:** dispatch a LOW-complexity PLAN REVIEWED card to the coder via the batch-dispatch-low path and inspect the generated prompt in the terminal — it should open `Please execute the following 1 plans.` with no complexity or column preamble.
3. **Manual (regression):** dispatch a normal (non-low) coder batch and a lead batch; confirm both intros are clean and the `PLANS TO PROCESS:` block, safeguards, and base instructions are otherwise unchanged.
4. **grep check:** confirm no remaining production reference builds the phrase ` from the ${...} column` for coder/lead intros and that `sourceColumnLabel` is no longer consumed in those intros.
5. `npm run compile` succeeds (only required for producing a VSIX).
