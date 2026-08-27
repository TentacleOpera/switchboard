# Batch allocate prompt exists only in VS Code extension host — npx/standalone host diverges

## Goal

The batch-to-a-team-head allocate prompt (batch framing, team-head gate, plan cap) exists only in the VS Code extension host's `generateUnifiedPrompt` (KanbanProvider.ts). The standalone/npx host builds dispatch prompts with its own `buildPromptForCards` (bootstrap.ts:142–169), which is a completely separate prompt builder:

- No batch framing (`batchMode`, `featureMode` flags are never set).
- No team-head gate (`isCodingTeamHead` is never called).
- No plan cap (`selectTeamBatchPlans` is never called).
- No drive prefix (team roster, API port, ptySendPrompt recipe).
- No BATCH MODE directive or conflict-pass instructions.

The standalone host's `buildPromptForCards` simply concatenates `"You are acting as the Switchboard ${role} agent."` + `FOCUS_DIRECTIVE` + plan file contents. A batch of 12 plans to a team head from the npx host sends all 12 with no cap, no team roster, and no allocate framing.

This is a pre-existing whole-stack divergence of the prompt builder, not a seam the batch-to-team-head feature introduced. But it means the feature shipped extension-only — the npx host silently does the wrong thing for the same operation.

**Root cause:** `buildPromptForCards` was written as a minimal standalone prompt builder and was never updated to match `generateUnifiedPrompt`'s feature/batch/drive-mode logic. The two builders have diverged over many feature additions.

## Metadata

**Complexity:** 7
**Tags:** backend, bugfix, refactor
**Project:** Browser Switchboard

## User Review Required

No user decision needed. The design choice (replace `buildPromptForCards` with `generateUnifiedPrompt` + fallback) is resolved in the architecture review. The format parity concern is addressed in the verification plan.

## Complexity Audit

### Routine
- The standalone host already creates a fully wired `KanbanProvider` instance (bootstrap.ts:1040–1085) with `_taskViewerProvider`, `_hostSeams`, and `_broadcaster` set. The `generateUnifiedPrompt` method is available on this instance.
- The `buildDispatchAnalysisPrompt` path (line 2134) already delegates to a standalone function — the non-analysis path can similarly delegate to `generateUnifiedPrompt`.
- The `vscodeShim` (out/standalone/vscodeShim.js) stubs `vscode` imports. The test file `batch-move-team-prompt-contract.test.js` already proves `KanbanProvider` works headlessly with the shim.

### Complex / Risky
- **`generateUnifiedPrompt` returns `''` on DB unavailable:** The method returns an empty string (not a throw) when the DB is unavailable or no plans resolve. The fallback must check for empty/null, not just catch throws.
- **Format parity for non-batch cases:** `generateUnifiedPrompt` produces a richer prompt than `buildPromptForCards` for simple single-plan dispatches (different preamble, suffix blocks, directive injection). This is an improvement — the standalone host was missing directives — but must be verified to ensure the core content (plan text, role instructions) is present.
- **`originTerminal` / `targetTerminalName` mapping:** `generateUnifiedPrompt`'s team-head gate uses `overrides?.originTerminal` to resolve the team roster via `isCodingTeamHead`. In the standalone dispatch handler, `targetTerminalName` is the terminal the prompt is delivered TO. This is the same identifier `isCodingTeamHead` expects — it's resolved from `targetTerminalOverride` or `_resolveAgentTerminalForPlan`, both of which return the agent's terminal name (the key used in team group config: `team_<headName>`).
- **`_taskViewerProvider` dependency:** `generateUnifiedPrompt` references `this._taskViewerProvider` in some branches (e.g., `getLocalApiServerPort`). The standalone host sets this at line 1085 (`kanbanProvider.setTaskViewerProvider(taskViewerProvider)`). No fallback needed — it's wired.
- **`_seams()` dependency:** `generateUnifiedPrompt` calls `this._seams()` for UI/path operations. The standalone host sets `_hostSeams` at line 1046. No fallback needed — it's wired.

## Edge-Case & Dependency Audit

- **`vscodeShim` coverage:** The shim is already used by `batch-move-team-prompt-contract.test.js` which exercises `KanbanProvider.generateUnifiedPrompt` headlessly. Basic coverage is proven. If a code path hits an unstubbed API, the try/catch fallback fires.
- **Empty string return:** `generateUnifiedPrompt` returns `''` when the DB is unavailable. The fallback must check: `if (!prompt || prompt.length === 0) { fallback to buildPromptForCards }`.
- **`buildPromptForCards` callers:** The function is called only from the dispatch handler (line 2136). No other call sites in bootstrap.ts.
- **Prompt format parity:** Even if `generateUnifiedPrompt` produces a different prompt for a simple single-plan coder dispatch, the core content (plan text, role instructions, FOCUS_DIRECTIVE) is present. The difference is in wrapper text (preamble, suffix blocks, directive injection). This is an improvement, not a regression — the standalone host was producing a minimal prompt missing seat-scoped directives that the extension host includes.
- **Backward compatibility:** Existing standalone dispatches that work today will receive a richer prompt. The delivery layer (`deliverPrompt`) sends the prompt text to a terminal — it does not parse the prompt structure. The agent receives whatever text is produced. No downstream consumer depends on the exact `buildPromptForCards` format.
- **Performance:** `generateUnifiedPrompt` does more DB lookups than `buildPromptForCards`. In the standalone host, dispatches are user-initiated, not high-frequency. Acceptable.

## Dependencies

- **Subtask 1 (dispatch means):** This subtask routes the standalone host through `generateUnifiedPrompt`, which contains the gate fix from subtask 1. Subtask 1 MUST land first — without the `_buildBatchDrivePrefix` method and the gate fix at line 6394, `generateUnifiedPrompt` still doesn't prepend the drive prefix for batch-to-team-head. This subtask makes the standalone host call the fixed method; it does not fix the method itself.

## Adversarial Synthesis

Key risks: (1) `generateUnifiedPrompt` returns `''` (not throws) on DB unavailable — the fallback must check for empty/null, not just catch throws, or the agent receives an empty prompt silently. (2) Format parity for non-batch cases — `generateUnifiedPrompt` produces a richer prompt than `buildPromptForCards`; this is an improvement but must be verified to ensure core content is present. (3) `originTerminal` mapping — `targetTerminalName` is the correct identifier for `isCodingTeamHead` (resolved from agent terminal name, same as team group key), but must be documented.

## Proposed Changes

### 1. Replace `buildPromptForCards` with `generateUnifiedPrompt` call (src/standalone/bootstrap.ts:2134–2137)

```typescript
let prompt: string | null;
try {
    prompt = await kanbanProvider.generateUnifiedPrompt(targetRole, records, root, {
        instruction: payload.instruction,
        analysisScope,
        originTerminal: targetTerminalName,  // for team-head gate — same identifier isCodingTeamHead expects
    });
} catch (err) {
    console.warn('[switchboard] generateUnifiedPrompt failed in standalone, falling back to buildPromptForCards:', err);
    prompt = null;
}
// generateUnifiedPrompt returns '' (not throws) when the DB is unavailable.
// The fallback must catch empty strings too, not just throws.
if (!prompt || prompt.length === 0) {
    prompt = await buildPromptForCards(targetRole, records, root);
}
if (!prompt) { return { success: false, error: 'Failed to build dispatch prompt' }; }
```

### 2. Verify `KanbanProvider` is available in the dispatch handler

The `kanbanProvider` instance at line 1040 is a real `KanbanProvider` with:
- `_taskViewerProvider` set (line 1085)
- `_hostSeams` set (line 1046)
- `_broadcaster` set (line 1047)
- `_currentWorkspaceRoot` set (line 1048)

No additional wiring needed. The `generateUnifiedPrompt` method is available on this instance.

### 3. Fallback behavior

The fallback to `buildPromptForCards` fires on:
- Any throw from `generateUnifiedPrompt` (unstubbed VS Code API, unexpected error)
- Empty string return (DB unavailable, no plans resolved)

The fallback preserves the existing behavior for edge cases where `generateUnifiedPrompt` cannot run. A `console.warn` logs the fallback for debugging.

## Verification Plan

### Automated Tests

1. **Unit test:** Build a batch prompt for 5 loose plans with a team-headed lead via the standalone host — assert the prompt contains batch framing, team roster, and cap.
2. **Unit test:** Build a single-plan coder dispatch via the standalone host — assert the prompt contains the plan content, role instructions, and FOCUS_DIRECTIVE (not byte-identical to `buildPromptForCards`, but core content present).
3. **Unit test:** Build a batch prompt for 12 loose plans with a team-headed lead via the standalone host — assert the cap limits to 5.
4. **Unit test:** Build a non-team batch via the standalone host — assert no team-head gate fires.
5. **Unit test:** Simulate DB unavailable in the standalone host — assert the fallback to `buildPromptForCards` fires and the prompt is non-empty.
6. **Regression test:** Existing standalone dispatch tests must still pass.

### Manual Tests

7. **Integration test:** Run `npx switchboard` dispatch and verify the prompt content matches the extension host's output for the same batch-to-team-head plans.
8. **Integration test:** Run `npx switchboard` dispatch for a single-plan coder dispatch — verify the prompt is functional (agent receives plan content and role instructions).

### Goal Invariants

- **Positive:** Standalone host dispatch for `role='lead'` with >1 loose plans and a team-headed lead produces a prompt containing `YOUR TEAM:` and `BATCH MODE`.
- **Positive:** Standalone host dispatch for `role='coder'` with 1 plan produces a prompt containing the plan file content and `FOCUS_DIRECTIVE`.
- **Negative:** Standalone host dispatch does NOT produce an empty prompt when the DB is available (fallback fires only on failure).
- **Positive:** When `generateUnifiedPrompt` returns `''`, `buildPromptForCards` is called and its result is used (fallback chain works).
