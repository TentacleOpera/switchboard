# Reviewer Remaining-Risks Capture to Memo

## Goal

### Problem
When the reviewer agent runs unattended (orchestration/autoban), it frequently identifies "remaining risks" during its review — issues that are not blocking the current plan but warrant a separate follow-up plan. The reviewer prompt already instructs it to list "remaining risks" in its completion report and structured summary (step at `agentPromptBuilder.ts:1789` and `COMPLETION_STEP_FULL`/`COMPLETION_STEP_COMPACT` at lines 999/1001). However, these risks live only inside the plan file's completion report text and the reviewer's response. There is no mechanism for the reviewer to write the risks to the memo file (`.switchboard/memo.md`) for later triage and planning.

When the reviewer runs unattended, these risks are effectively lost — buried in a completion report on an already-completed card, with no memo entry to trigger future planning. The user must manually read through completed plan files to recover them, defeating the purpose of unattended review.

### Root Cause
The reviewer prompt builder (`agentPromptBuilder.ts`, `if (role === 'reviewer')` block, lines 1776–1851) has no option or directive for capturing remaining risks into an actionable artifact. The `PromptBuilderOptions` interface (lines 153–229) defines toggles like `reviewerConciseModeEnabled`, `reviewerCompactPlanUpdateEnabled`, and `noSeparateReviewArtifactsEnabled`, but none address risk capture. The memo file (`.switchboard/memo.md`) is used by memo capture mode and the scheduled `memo-to-plans` job, but the reviewer prompt has no directive to append to it.

### Solution
Add one new reviewer prompt-builder option (toggle), following the exact same pattern as existing reviewer addons (`reviewerConciseMode`, `reviewerCompactPlanUpdate`, `noSeparateReviewArtifacts`):

**"Risks to Memo"** (`reviewerRisksToMemo`) — when enabled, the reviewer is directed to append remaining risks as entries to `.switchboard/memo.md`, where they can be processed into plans later via the existing `process memo` workflow or the scheduled `memo-to-plans` job.

The toggle defaults to `false` (opt-in), preserving current behavior.

> **Superseded:** The original plan proposed two toggles: `reviewerCreateRiskPlans` (reviewer authors full plan files) and `reviewerRisksToMemo` (reviewer appends to memo).
> **Reason:** Full plan authoring is too heavy for a reviewer agent already doing Grumpy critique + balanced synthesis + code fixes + verification + plan update. Memo entries (1-3 sentences each) are lightweight, and the existing `process memo` / `memo-to-plans` pipeline uses a dedicated planning agent to author full plans from memo entries — producing higher-quality plans than a reviewer doing double duty. Memo processing also naturally batches entries, giving a planning agent visibility into all risks at once for dedup. The direct-plan-creation approach had a dedup problem (repeated unattended runs creating duplicate cards) that was only mitigated with a weak prompt-level "check if it exists" clause.
> **Replaced with:** Memo-only approach — one toggle, one directive, simpler implementation. Trade-off: up to 24h latency (daily `memo-to-plans` job) or manual `process memo` trigger. Acceptable for non-blocking risks.

## Metadata
**Complexity:** 4
**Tags:** backend, feature, ui
**Project:** Browser Switchboard

## User Review Required

This plan adds one opt-in reviewer toggle. The approach (memo-only risk capture) was chosen over direct plan-file creation because memo entries are lightweight for the reviewer and leverage the existing `process memo` / `memo-to-plans` pipeline (dedicated planning agent, natural dedup). Trade-off: up to 24h latency for non-blocking risks — acceptable for the use case.

## Complexity Audit

### Routine
- Adding one new field to `PromptBuilderOptions` interface — mechanical, follows existing pattern
- Adding one new addon entry to `DEFAULT_ROLE_CONFIG.reviewer.addons` in `sharedDefaults.js` — mechanical
- Adding one new toggle definition to the `reviewer` addons array in `sharedDefaults.js` — mechanical
- Reading the new addon value in `_getPromptsConfig` and passing it to `resolvedOptions` — mechanical, follows exact pattern of `reviewerCompactPlanUpdateEnabled`
- Writing one new directive string constant — text authoring
- Adding one new field to `CustomAgentAddons` interface in `agentConfig.ts` — mechanical, follows existing `noSeparateReviewArtifactsEnabled` pattern
- Adding one new line to `parseCustomAgentAddons` in `agentConfig.ts` — mechanical
- Adding one new mapping to `AgentSkillExporter.normalizeBuiltinAddons` — mechanical, follows `noSeparateReviewArtifacts` mapping pattern
- Adding one new rendering block to `AgentSkillExporter.appendAddonSection` — mechanical, follows `noSeparateReviewArtifactsEnabled` rendering pattern

### Complex / Risky
- The memo-append directive must specify the correct path (`.switchboard/memo.md`) and the correct append format. The `parseMemoEntries` parser (`TaskViewerProvider.ts:5836`, `standalone/bootstrap.ts:1924`) splits entries by **blank lines** (paragraph split) as its primary strategy; blank-line separation is the load-bearing format requirement.
- Prompt byte-stability: when the toggle is `false` (default), the reviewer prompt must be byte-identical to today. The new directive block must be an empty string when disabled, following the `noSeparateReviewArtifactsBlock` pattern.
- Cross-type-system coordination: the new toggle must be added to BOTH `PromptBuilderOptions` (built-in path, `buildKanbanBatchPrompt`) AND `CustomAgentAddons` (custom-agent path, `buildCustomAgentPrompt`). The `AgentSkillExporter` bridges the two schemas — missing any of the three custom-agent files (`agentConfig.ts` interface, `parseCustomAgentAddons`, `AgentSkillExporter.normalizeBuiltinAddons` + `appendAddonSection`) breaks the custom-agent/skill-export path silently.

## Edge-Case & Dependency Audit

1. **No remaining risks identified**: The reviewer should skip the directive gracefully — no empty memo entries. The directive text must say "If there are no remaining risks, skip this step."

2. **Memo file does not exist**: The reviewer must create `.switchboard/memo.md` if it doesn't exist before appending. Standard `fs.appendFileSync` / shell `echo >>` behavior handles this.

3. **Worktree context**: When the reviewer runs in a worktree, `.switchboard/` may not exist in the worktree CWD. The directive must specify the workspace root path (the prompt already includes `WORKSPACE_ROOT=` in the dispatch context). The memo path must be relative to the workspace root, not the CWD.

4. **Existing tests**: `agentPromptBuilder.test.ts` and `minimal-prompt.test.js` assert reviewer prompt structure. The new toggle defaults to `false` so existing tests are unaffected. New test cases should verify the directive appears when enabled and is absent when disabled.

5. **Standalone/headless path**: `src/standalone/bootstrap.ts` has its own memo handling (`memoPath` at line 1923, `parseMemoEntries` at line 1924). The directive text is host-agnostic (it references `.switchboard/memo.md` as a path), so it works in both extension and standalone contexts.

6. **Dedup on repeated runs**: When the reviewer runs unattended repeatedly (e.g. nightly code review), it may identify the same "remaining risks" across runs and append duplicate entries to the memo file. Unlike direct plan-file creation (which creates duplicate kanban cards immediately), memo duplicates are visible to the planning agent during `process memo` / `memo-to-plans` processing, where a dedicated planner can identify and skip duplicates naturally. This is an accepted trade-off — the memo pipeline's batch visibility is the dedup mechanism.

7. **Custom-agent / skill-export path**: The `buildCustomAgentPrompt` function (line 2332) uses `CustomAgentAddons` (from `agentConfig.ts`), not `PromptBuilderOptions`. The new field must be added to `CustomAgentAddons`, `parseCustomAgentAddons`, and `AgentSkillExporter` (both `normalizeBuiltinAddons` and `appendAddonSection`) for the toggle to flow into custom-agent prompts and exported skill markdown. Without these changes, a custom agent derived from the reviewer role would silently miss the risk-capture directive.

## Dependencies
- None — this plan is self-contained. No other plan must complete first.

## Adversarial Synthesis

Key risks: (1) Cross-type-system coordination — the toggle must be wired through both `PromptBuilderOptions` and `CustomAgentAddons` (plus `AgentSkillExporter`), or the custom-agent path silently misses it; mitigated by explicit sections 8–11 covering all three custom-agent files. (2) Memo format — the `parseMemoEntries` parser uses blank-line paragraph splitting, not bullet markers; mitigated by directive text specifying blank-line separation. (3) Dedup on repeated unattended runs — memo duplicates are visible to the planning agent during batch processing, providing natural dedup at the processing stage. Mitigations: all issues addressed in the plan; the memo-only approach is simpler and lower-risk than the original two-toggle design.

## Proposed Changes

### 1. `src/services/agentPromptBuilder.ts` — New directive constant

Add one new exported directive constant near the existing `NO_SEPARATE_REVIEW_ARTIFACTS_DIRECTIVE` (line 955):

```typescript
export const REVIEWER_RISKS_TO_MEMO_DIRECTIVE = `REMAINING RISKS TO MEMO: After completing your review, append each remaining risk as a separate entry to .switchboard/memo.md (create the file if it does not exist). Use the WORKSPACE_ROOT from the dispatch context to resolve the path — do not write to a worktree-local .switchboard/. Separate each entry from the preceding content by a blank line so the memo parser can split them into distinct entries. Each entry should be a concise, actionable description of the risk (1-3 sentences) — enough context for a future planning pass to understand the issue without re-reading the review. If there are no remaining risks, skip this step. Do NOT clear or truncate existing memo content — append only.`;
```

### 2. `src/services/agentPromptBuilder.ts` — New `PromptBuilderOptions` field

Add one new field to the `PromptBuilderOptions` interface (after `noSeparateReviewArtifactsEnabled` at line 178):

```typescript
    /** When true, the reviewer appends remaining risks as entries to .switchboard/memo.md for later triage. */
    reviewerRisksToMemoEnabled?: boolean;
```

### 3. `src/services/agentPromptBuilder.ts` — Read option and emit directive block

In `buildKanbanBatchPrompt`, after the existing option reads (line 1517 area), add:

```typescript
    const reviewerRisksToMemoEnabled = options?.reviewerRisksToMemoEnabled ?? false;
```

In the reviewer prompt assembly (after `noSeparateReviewArtifactsBlock` at line 1827), add:

```typescript
        const reviewerRisksToMemoBlock = reviewerRisksToMemoEnabled
            ? REVIEWER_RISKS_TO_MEMO_DIRECTIVE
            : '';
```

Add to the `promptParts` array (after `noSeparateReviewArtifactsBlock`, line 1847):

```typescript
        const promptParts = [
            reviewerExecutionBlock,
            safeguardsBlock,
            advancedReviewerBlock,
            baseInstructions,
            suffixBlock,
            featureDirectiveBlock,
            reviewUnitBlock,
            `PLANS TO PROCESS:\n${planList}`,
            noSeparateReviewArtifactsBlock,
            reviewerRisksToMemoBlock
        ].filter(Boolean).join('\n\n');
```

### 4. `src/webview/sharedDefaults.js` — Default addon value

In `DEFAULT_ROLE_CONFIG.reviewer.addons` (line 26), add the new field:

```javascript
reviewer: { prompt: '', addons: { switchboardSafeguards: true, advancedRegression: true, reviewerConciseMode: false, reviewerCompactPlanUpdate: false, noSeparateReviewArtifacts: true, reviewerRisksToMemo: false, gitProhibition: true, gitCommitStrategy: 'notSpecified', clearAntigravityContext: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '', featureSubagentPolicy: 'default', featureCustomSubagentName: '', featureWorkflowFilePathEnabled: false, featureWorkflowFilePath: '' } },
```

### 5. `src/webview/sharedDefaults.js` — Toggle definition

In the `reviewer` addons array (after `noSeparateReviewArtifacts` at line 176), add one new toggle:

```javascript
        { id: 'reviewerRisksToMemo', label: 'Risks to Memo', tooltip: 'Append remaining risks as entries to .switchboard/memo.md for later triage and planning via the process-memo workflow.', default: false },
```

### 6. `src/services/KanbanProvider.ts` — Read addon value in `_getPromptsConfig`

In `_getPromptsConfig` (after line 5651), add:

```typescript
            reviewerRisksToMemoEnabled: reviewerConfig?.addons?.reviewerRisksToMemo ?? false,
```

### 7. `src/services/KanbanProvider.ts` — Pass to `resolvedOptions`

In `generateUnifiedPrompt` (after line 5424), add:

```typescript
            resolvedOptions.reviewerRisksToMemoEnabled = promptsConfig.reviewerRisksToMemoEnabled;
```

### 8. `src/services/agentPromptBuilder.ts` — `buildCustomAgentPrompt` path (custom agents)

In `buildCustomAgentPrompt` (line 2332), after the existing `advancedReviewerEnabled` application (around line 2437), add:

```typescript
    if (addons?.reviewerRisksToMemoEnabled) prompt += '\n\n' + REVIEWER_RISKS_TO_MEMO_DIRECTIVE;
```

**Context:** `buildCustomAgentPrompt` is the prompt builder for custom agents (user-defined roles derived from built-in roles). It uses `CustomAgentAddons` (from `agentConfig.ts`), which has different field names than the UI toggle keys in `sharedDefaults.js` — the `AgentSkillExporter.normalizeBuiltinAddons` function bridges the two schemas. The new field must be added to `CustomAgentAddons` (section 9), `parseCustomAgentAddons` (section 10), and `AgentSkillExporter` (section 11) for this code to compile and for the toggle to flow from the reviewer config into custom-agent prompts and exported skill markdown.

### 9. `src/services/agentConfig.ts` — `CustomAgentAddons` interface field

Add one new field to the `CustomAgentAddons` interface (after `noSeparateReviewArtifactsEnabled` at line 34):

```typescript
    reviewerRisksToMemoEnabled?: boolean;
```

### 10. `src/services/agentConfig.ts` — `parseCustomAgentAddons` parser

In `parseCustomAgentAddons` (after line 272, where `noSeparateReviewArtifactsEnabled` is parsed), add:

```typescript
    if (s.reviewerRisksToMemoEnabled === true) a.reviewerRisksToMemoEnabled = true;
```

### 11. `src/services/AgentSkillExporter.ts` — `normalizeBuiltinAddons` mapping and `appendAddonSection` rendering

In `normalizeBuiltinAddons` (after line 94, where `noSeparateReviewArtifactsEnabled` is mapped), add:

```typescript
        out.reviewerRisksToMemoEnabled = builtinAddons.reviewerRisksToMemo ?? false;
```

In `appendAddonSection` (after line 261, where `noSeparateReviewArtifactsEnabled` is rendered), add:

```typescript
        if (addons.reviewerRisksToMemoEnabled) {
            lines.push('### Risks to Memo');
            lines.push('```');
            lines.push(REVIEWER_RISKS_TO_MEMO_DIRECTIVE);
            lines.push('```');
            lines.push('');
        }
```

**Context:** `normalizeBuiltinAddons` maps built-in role-config UI keys (from `sharedDefaults.js`) to `CustomAgentAddons` field names. `appendAddonSection` renders addon directives into exported skill markdown. Without both, the risk-capture directive would be present in dispatched prompts but absent from custom-agent prompts and exported skill files — a silent inconsistency.

## Verification Plan

### Automated Tests

1. **Byte-stability test**: Build a reviewer prompt with the new toggle unset (default `false`). Assert the prompt string is byte-identical to a prompt built before the change (no new whitespace, no empty blocks). This is the critical regression guard — run the existing `agentPromptBuilder.test.ts` and `minimal-prompt.test.js` suites.

2. **Toggle-on test**: Build a reviewer prompt with `reviewerRisksToMemoEnabled: true`. Assert the prompt contains the `REMAINING RISKS TO MEMO:` directive text.

3. **Toggle-off test**: Build a reviewer prompt with `reviewerRisksToMemoEnabled: false`. Assert the prompt does NOT contain the `REMAINING RISKS TO MEMO:` directive text.

4. **Custom-agent path test**: Build a custom-agent prompt via `buildCustomAgentPrompt` with `reviewerRisksToMemoEnabled: true` in the `CustomAgentAddons`. Assert the `REMAINING RISKS TO MEMO:` directive appears.

5. **AgentSkillExporter mapping test**: Call `AgentSkillExporter.normalizeBuiltinAddons` with built-in reviewer addons containing `reviewerRisksToMemo: true`. Assert the output `CustomAgentAddons` has `reviewerRisksToMemoEnabled: true`.

6. **UI toggle test**: Open the Prompts tab in the Switchboard sidebar. Verify one new toggle appears under the reviewer section: "Risks to Memo". Toggle it on, save, and verify the config round-trips (close and reopen the tab, confirm the toggle persists).

7. **Prompt preview test**: In the Prompts tab, enable "Risks to Memo" for the reviewer and click the prompt preview. Verify the `REMAINING RISKS TO MEMO:` directive appears in the generated prompt text.

8. **Compile check**: Run `npm run compile` (or `tsc --noEmit`) to verify no type errors from the new `PromptBuilderOptions` and `CustomAgentAddons` fields.

## Outstanding Questions
- **[user]** Should the `memo-to-plans` scheduled job (daily) be sufficient for processing reviewer-appended risks, or should the reviewer also trigger an immediate `process memo` dispatch when it appends entries? The daily job introduces up to 24h latency for non-blocking risks. — proceeding on the assumption that **daily scheduled processing is sufficient** for non-blocking risks; the user can also trigger `process memo` manually for faster turnaround.
