# Add Default Reviewer Prompt Add-on Prohibiting Separate Review Artifact Files

## Goal
The goal of this task is to enforce a default-on prompt directive for the Reviewer Agent in Switchboard that explicitly prohibits creating separate review artifact markdown files (e.g., `review.md`, `review_artifact.md`, or standalone notes files in `.switchboard/plans/` or the workspace root).

### Problem Analysis & Root Cause
When the Reviewer Agent executes a code review pass, LLM agents frequently default to creating new markdown artifacts (such as `review_notes.md` or `review_artifact.md`) to record their evaluation findings. 

In Switchboard, the `PlanWatcher` service monitors the `.switchboard/plans/` directory for any new `.md` files. When a reviewer agent creates a standalone `.md` file inside or near `.switchboard/plans/` (or in watched workspace directories), `PlanWatcher` detects the file creation event and automatically imports the file as a brand new Plan card on the Kanban board.

This results in unwanted, duplicate, and confusing cards flooding the Kanban board whenever a review runs.

Root cause analysis reveals:
1. `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` in `agentPromptBuilder.ts` instructs reviewers to update the original plan file, but does NOT explicitly forbid creating separate markdown review files or review artifacts.
2. There is no explicit, default-enabled reviewer prompt addon option in `CustomAgentAddons` and `agentPromptBuilder.ts` that provides a clear directive warning the LLM about the file watcher behavior and forbidding standalone review artifact creation.

## Metadata
- **Complexity:** 3
- **Tags:** backend, bugfix, feature

## Complexity Audit (Routine vs Complex/Risky)
- **Routine Changes:**
  - Adding `noSeparateReviewArtifactsEnabled?: boolean` option to `CustomAgentAddons` in `agentConfig.ts` and defaulting it to `true` for `reviewer` role dispatches.
  - Updating `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` and prompt suffix assembly in `agentPromptBuilder.ts` to include the explicit anti-artifact directive by default.
  - Propagating option resolution in `KanbanProvider.ts` and `AgentSkillExporter.ts`.
  - Adding unit test coverage in `agentPromptBuilder.test.ts` and `autoban-reviewer-prompt-regression.test.js`.
- **Risky/Complex Areas:** Low risk. Must ensure custom prompt overrides (`defaultPromptOverride`) for reviewer agents do not accidentally drop the anti-artifact directive or break existing completion directive handling.

## Edge-Case & Dependency Audit
- **Custom Prompt Overrides:** If a user specifies a `replace` mode prompt override for the reviewer agent, the anti-artifact directive should ideally be preserved in the suffix or core execution intro so file watcher triggering remains guarded.
- **Batch Dispatches:** For batch reviews covering multiple plans, the directive must apply uniformly across all plans in the batch.
- **Plan File In-Place Updates:** Review findings must continue to be updated directly in the target plan file under `## Review Findings` or returned in the LLM response stream, ensuring no data loss occurs while avoiding external file creation.

## Proposed Changes

### [Backend Services]

#### [MODIFY] [agentConfig.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/agentConfig.ts)
Add `noSeparateReviewArtifactsEnabled?: boolean` to `CustomAgentAddons` interface and addon parser/serializer functions.

```typescript
export interface CustomAgentAddons {
    // ...
    advancedReviewerEnabled?: boolean;
    reviewerConciseModeEnabled?: boolean;
    reviewerCompactPlanUpdateEnabled?: boolean;
    noSeparateReviewArtifactsEnabled?: boolean; // NEW: Prohibit creating separate .md review artifacts
    // ...
}
```

#### [MODIFY] [agentPromptBuilder.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/agentPromptBuilder.ts)
1. Add `noSeparateReviewArtifactsEnabled?: boolean` to `PromptBuilderOptions`.
2. Update `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` (or append to reviewer prompt block):
```typescript
export const NO_SEPARATE_REVIEW_ARTIFACTS_DIRECTIVE = `PROHIBITION ON SEPARATE REVIEW ARTIFACT FILES (on by default):
Do NOT create separate review artifact markdown files (such as review.md, review_artifact.md, review_notes.md, or new .md files in .switchboard/plans/ or the workspace).
REASON: The workspace file watcher monitors markdown files and will import separate review markdown files as new Kanban plans, creating duplicate plan cards.
All review findings, severity tags, and validation results MUST be output directly in your response stream and/or appended to the existing target plan file in-place.`;
```
3. Update reviewer prompt construction logic in `buildKanbanBatchPrompt`:
```typescript
const noSeparateReviewArtifactsEnabled = options?.noSeparateReviewArtifactsEnabled ?? true;
if (noSeparateReviewArtifactsEnabled) {
    reviewerBaseInstructions += '\n\n' + NO_SEPARATE_REVIEW_ARTIFACTS_DIRECTIVE;
}
```

#### [MODIFY] [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts)
Resolve `noSeparateReviewArtifactsEnabled` in prompt builder options for reviewer dispatches:
```typescript
resolvedOptions.noSeparateReviewArtifactsEnabled = promptsConfig.noSeparateReviewArtifactsEnabled ?? true;
```

#### [MODIFY] [AgentSkillExporter.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/AgentSkillExporter.ts)
Include `noSeparateReviewArtifactsEnabled` in exporter and importer routines for reviewer addons.

### [Tests]

#### [MODIFY] [agentPromptBuilder.test.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/__tests__/agentPromptBuilder.test.ts)
Add test cases:
1. Verify reviewer prompts include `PROHIBITION ON SEPARATE REVIEW ARTIFACT FILES` by default.
2. Verify setting `noSeparateReviewArtifactsEnabled: false` suppresses the directive when explicitly disabled.

#### [MODIFY] [autoban-reviewer-prompt-regression.test.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/test/autoban-reviewer-prompt-regression.test.js)
Update reviewer prompt snapshot assertions to reflect the anti-artifact directive inclusion.

## Verification Plan

### Automated Tests
Run the test suite to verify prompt generation:
- `npx mocha -r ts-node/register src/services/__tests__/agentPromptBuilder.test.ts`
- `npx mocha src/test/autoban-reviewer-prompt-regression.test.js`

### Manual Verification
1. Open Switchboard and trigger a reviewer pass on a sample plan card.
2. Inspect the generated system prompt for the reviewer agent and verify that `PROHIBITION ON SEPARATE REVIEW ARTIFACT FILES` is present.
3. Confirm that the reviewer agent modifies the target plan file directly or streams output inline without writing any `review.md` or `.md` files to disk.
4. Verify that no new unexpected cards appear in `.switchboard/plans/` or on the Kanban board after review completion.
