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

The toggle defaults to **`true` (on)**. Unattended reviewer automation is the whole point of the feature — an opt-in toggle nobody enables captures nothing, so the risks would stay lost exactly as they are today. The directive is self-limiting ("If there are no remaining risks, skip this step"), so a default-ON toggle costs an idle reviewer nothing. Turning it off is a one-click opt-out in the Prompts tab.

> **Superseded:** The original plan proposed two toggles: `reviewerCreateRiskPlans` (reviewer authors full plan files) and `reviewerRisksToMemo` (reviewer appends to memo).
> **Reason:** Full plan authoring is too heavy for a reviewer agent already doing Grumpy critique + balanced synthesis + code fixes + verification + plan update. Memo entries (1-3 sentences each) are lightweight, and the existing `process memo` / `memo-to-plans` pipeline uses a dedicated planning agent to author full plans from memo entries — producing higher-quality plans than a reviewer doing double duty. Memo processing also naturally batches entries, giving a planning agent visibility into all risks at once for dedup. The direct-plan-creation approach had a dedup problem (repeated unattended runs creating duplicate cards) that was only mitigated with a weak prompt-level "check if it exists" clause.
> **Replaced with:** Memo-only approach — one toggle, one directive, simpler implementation. Trade-off: up to 24h latency (daily `memo-to-plans` job) or manual `process memo` trigger. Acceptable for non-blocking risks.

## Metadata
**Complexity:** 4
**Tags:** backend, feature, ui
**Project:** Browser Switchboard

## User Review Required

None. Decisions made and settled: memo-only capture (not direct plan-file creation), toggle defaults to ON, and the default is scoped to the built-in reviewer only — custom agents keep explicit opt-in.

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
- Default scoping: the toggle defaults to ON, so every site that resolves the default must be checked for over-reach. `AgentSkillExporter.normalizeBuiltinAddons` runs for EVERY built-in role, so a bare `?? true` there renders a "Risks to Memo" section into coder/tester/planner skill exports — it must be gated on `role === 'reviewer'`. The custom-agent path (`agentConfig.ts` parser + `buildCustomAgentPrompt`) stays explicit opt-in for the same reason: a custom agent is not a reviewer.
- Prompt spacing: when the toggle is explicitly `false`, the directive block must be an empty string dropped by `filter(Boolean)` — no stray blank lines or triple newlines — following the `noSeparateReviewArtifactsBlock` pattern.
- Cross-type-system coordination: the new toggle must be added to BOTH `PromptBuilderOptions` (built-in path, `buildKanbanBatchPrompt`) AND `CustomAgentAddons` (custom-agent path, `buildCustomAgentPrompt`). The `AgentSkillExporter` bridges the two schemas — missing any of the three custom-agent files (`agentConfig.ts` interface, `parseCustomAgentAddons`, `AgentSkillExporter.normalizeBuiltinAddons` + `appendAddonSection`) breaks the custom-agent/skill-export path silently.

## Edge-Case & Dependency Audit

1. **No remaining risks identified**: The reviewer should skip the directive gracefully — no empty memo entries. The directive text must say "If there are no remaining risks, skip this step."

2. **Memo file does not exist**: The reviewer must create `.switchboard/memo.md` if it doesn't exist before appending. Standard `fs.appendFileSync` / shell `echo >>` behavior handles this.

3. **Worktree context**: When the reviewer runs in a worktree, `.switchboard/` may not exist in the worktree CWD. The directive must specify the workspace root path (the prompt already includes `WORKSPACE_ROOT=` in the dispatch context). The memo path must be relative to the workspace root, not the CWD.

4. **Existing tests**: `agentPromptBuilder.test.ts` and `minimal-prompt.test.js` assert reviewer prompt structure. Because the toggle defaults to `true`, the default reviewer prompt gains the directive — any test asserting the *exact* default reviewer prompt body must be re-baselined. Both suites pass as-is (they assert on substrings and spacing invariants, not a full-body snapshot). New test cases verify the directive appears by default, is absent when explicitly disabled, and does not leak into non-reviewer roles.

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
    const reviewerRisksToMemoEnabled = options?.reviewerRisksToMemoEnabled ?? true;
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
reviewer: { prompt: '', addons: { switchboardSafeguards: true, advancedRegression: true, reviewerConciseMode: false, reviewerCompactPlanUpdate: false, noSeparateReviewArtifacts: true, reviewerRisksToMemo: true, gitProhibition: true, gitCommitStrategy: 'notSpecified', clearAntigravityContext: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '', featureSubagentPolicy: 'default', featureCustomSubagentName: '', featureWorkflowFilePathEnabled: false, featureWorkflowFilePath: '' } },
```

### 5. `src/webview/sharedDefaults.js` — Toggle definition

In the `reviewer` addons array (after `noSeparateReviewArtifacts` at line 176), add one new toggle:

```javascript
        { id: 'reviewerRisksToMemo', label: 'Risks to Memo', tooltip: 'Append remaining risks as entries to .switchboard/memo.md for later triage and planning via the process-memo workflow.', default: true },
```

### 6. `src/services/KanbanProvider.ts` — Read addon value in `_getPromptsConfig`

In `_getPromptsConfig` (after line 5651), add:

```typescript
            reviewerRisksToMemoEnabled: reviewerConfig?.addons?.reviewerRisksToMemo ?? true,
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
        // Default ON for the reviewer, but role-gated: normalizeBuiltinAddons is
        // called for every built-in role, and a bare `?? true` would render the
        // Risks-to-Memo section into coder/tester/planner skill exports too.
        out.reviewerRisksToMemoEnabled = role === 'reviewer' ? (builtinAddons.reviewerRisksToMemo ?? true) : false;
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

1. **Spacing / no-empty-block test**: The toggle now defaults to ON, so the default reviewer prompt is intentionally NOT byte-identical to before — it gains the directive. The guard that still applies is structural: with the toggle explicitly `false` the block must be an empty string that `filter(Boolean)` drops (no stray blank lines, no triple newlines). Covered by `minimal-prompt.test.js`'s "no triple newlines in any role across option combinations" case.

2. **Toggle-on test**: Build a reviewer prompt with `reviewerRisksToMemoEnabled: true`. Assert the prompt contains the `REMAINING RISKS TO MEMO:` directive text.

3. **Toggle-off test**: Build a reviewer prompt with `reviewerRisksToMemoEnabled: false`. Assert the prompt does NOT contain the `REMAINING RISKS TO MEMO:` directive text.

3b. **Default-ON test**: Build a reviewer prompt with no options. Assert it DOES contain the directive. Build prompts for `coder`/`lead`/`intern`/`tester`/`planner` with no options and assert none contain it — the default must not leak into non-reviewer roles.

4. **Custom-agent path test**: Build a custom-agent prompt via `buildCustomAgentPrompt` with `reviewerRisksToMemoEnabled: true` in the `CustomAgentAddons`. Assert the `REMAINING RISKS TO MEMO:` directive appears.

5. **AgentSkillExporter mapping test**: Call `AgentSkillExporter.normalizeBuiltinAddons` with reviewer addons that OMIT the key. Assert the output has `reviewerRisksToMemoEnabled: true` (default ON). Call it with `reviewerRisksToMemo: false` and assert `false`. Call it with role `'coder'` and the key omitted, and assert `false` — the role gate must hold, or the Risks-to-Memo section renders into every non-reviewer skill export.

6. **UI toggle test**: Open the Prompts tab in the Switchboard sidebar. Verify one new toggle appears under the reviewer section: "Risks to Memo". Toggle it on, save, and verify the config round-trips (close and reopen the tab, confirm the toggle persists).

7. **Prompt preview test**: In the Prompts tab, enable "Risks to Memo" for the reviewer and click the prompt preview. Verify the `REMAINING RISKS TO MEMO:` directive appears in the generated prompt text.

8. **Compile check**: Run `npm run compile` (or `tsc --noEmit`) to verify no type errors from the new `PromptBuilderOptions` and `CustomAgentAddons` fields.

## Outstanding Questions
- **[resolved]** Daily `memo-to-plans` processing is sufficient for non-blocking risks; `process memo` can be triggered manually for faster turnaround.

## Implementation Summary

Implemented the `reviewerRisksToMemo` opt-in toggle across all five files per the plan. Added the `REVIEWER_RISKS_TO_MEMO_DIRECTIVE` constant in `agentPromptBuilder.ts` (specifying WORKSPACE_ROOT path resolution, blank-line entry separation for the memo parser, and graceful skip when no risks remain). Wired the `reviewerRisksToMemoEnabled` field through `PromptBuilderOptions`, the reviewer prompt assembly (byte-identical when disabled via empty-string block + `filter(Boolean)`), and `buildCustomAgentPrompt`. Added the UI toggle and default (`false`) in `sharedDefaults.js`, plumbed the config read-through in `KanbanProvider.ts` (`_getPromptsConfig` + `resolvedOptions`), and bridged the custom-agent/skill-export path via `agentConfig.ts` (interface + parser) and `AgentSkillExporter.ts` (import, `normalizeBuiltinAddons` mapping, `appendAddonSection` rendering). **Default flipped to ON (2026-08-25).** Opt-in meant nobody would enable it, defeating the point for unattended reviewer automation. Four sites carry the default — `DEFAULT_ROLE_CONFIG.reviewer.addons` and the toggle definition in `sharedDefaults.js`, the `?? true` read in `buildKanbanBatchPrompt`, and the `?? true` read in `_getPromptsConfig`. The fifth, `AgentSkillExporter.normalizeBuiltinAddons`, is role-gated rather than a bare `?? true`: it runs for every built-in role, so an ungated default would render a "Risks to Memo" section into coder/tester/planner skill exports. The custom-agent schema (`agentConfig.ts` parser + `buildCustomAgentPrompt`) deliberately stays explicit opt-in (`=== true`) — a custom agent is not a reviewer and must not inherit the reviewer's default. Three regression tests added to `agentPromptBuilder.test.ts`: default-ON for reviewer, off when explicitly disabled, and no leak into the five non-reviewer roles.

## Review Findings

**CRITICAL (fixed)** — `REVIEWER_RISKS_TO_MEMO_DIRECTIVE` told the reviewer to "use the WORKSPACE_ROOT from the dispatch context", but `buildKanbanBatchPrompt` emits no `WORKSPACE_ROOT=` line (only the dispatch-analysis and Mission Control prompts do), so a reviewer in a worktree would resolve `.switchboard/memo.md` against the worktree CWD and lose the risks on cleanup — the exact failure this feature exists to prevent; the plan's Edge-Case audit §3 asserted the line was already present and it was not. Fixed by rewording the directive to be self-sufficient and rendering an absolute `MEMO FILE:` line at build time from `options.workspaceRoot` (same build-time-plumbing rationale as `apiPort`). **MAJOR (fixed)** — verification items 4 and 5 were never implemented, leaving the custom-agent path and the `AgentSkillExporter.normalizeBuiltinAddons` role gate (the riskiest line in the change) untested; four tests added to `agentPromptBuilder.test.ts`, which CI already invokes via `test:contract:reviewer-prompt-behaviour`. Files changed: `src/services/agentPromptBuilder.ts`, `src/services/__tests__/agentPromptBuilder.test.ts`. Validation: `tsc -p tsconfig.test.json --noEmit` clean; `test:contract:reviewer-prompt-behaviour` 87 passing with all 7 memo tests green; `test:contract:minimal-prompt`, `test:contract:reviewer-prompt` and `mirror:check` pass; gate-wiring audit found every named check invoked by CI (workflow lines 32/268/442/456).

**Remaining risks (pre-existing, not introduced here):** `npm run compile` and `npm run compile-tests` are red at HEAD with TS5096 in `tsconfig.json` (introduced by commit `c4984af9`), so CI fails at workflow steps 29/32 before reaching any prompt gate; `agentPromptBuilder.test.ts:749` is red at HEAD because COMPLETION REPORT step 8 hardcodes `.switchboard/api-server-port.txt` while the test forbids that string prompt-wide; `_parseMemoEntries` falls back to a capitalised-line heuristic when the memo holds a single paragraph, so a multi-line first entry can fragment; standalone/headless honours no reviewer addon opt-out (true for the whole addon family, not just this toggle); and `memoSave`/`memoGeneratePrompt` full-file writes can clobber a concurrent agent append.
