# Task: Extract How to Plan Guide and Update TaskViewerProvider.ts

## Workflow: Accuracy Mode

### Phase 1: Deep Context Gathering
- [x] Read `src/services/TaskViewerProvider.ts` around line 9015 to extract the "How to Plan" guide.
- [x] Search for all occurrences of the "How to Plan" guide in the codebase to ensure complete extraction.
- [x] Read `.agent/rules/switchboard_modes.md` for the "Lead Engineer" persona.
- [x] Identify dependencies and side-effects of moving the guide to a file.
- [x] Read existing tests for `TaskViewerProvider.ts` or related services.
- [x] Check if `TaskViewerProvider.ts` has any types or interfaces that need updating.
- [x] Call `complete_workflow_phase(phase: 1, ...)`

### Phase 2: Thorough Plan
- [ ] Create a detailed implementation plan.
- [ ] Map dependencies between changes.
- [ ] Identify risks and edge cases.
- [ ] Run `grep_search` to confirm nothing depends on deleted hardcoded strings.

### Phase 3: Implementation in Verified Groups
- [ ] **Group 1: Create `.agent/rules/how_to_plan.md`**
  - [ ] Extract content from `TaskViewerProvider.ts`.
  - [ ] Write to `.agent/rules/how_to_plan.md`.
  - [ ] Verify file content.
- [ ] **Group 2: Update `src/services/TaskViewerProvider.ts` - Airlock Export**
  - [ ] Modify `_exportAirlockZip` (actually `_handleAirlockExport`) to read from the new file.
  - [ ] Verify the change (compile/lint).
- [ ] **Group 3: Update `src/services/TaskViewerProvider.ts` - Planner Prompt**
  - [ ] Update `messagePayload` for `role === 'planner'` in `_handleTriggerAgentActionInternal`.
  - [ ] Inject the mandatory directive.
  - [ ] Verify the change (compile/lint).

### Phase 4: Self-Review (Red Team)
- [ ] Review all changes as a hostile reviewer.
- [ ] Check edge cases (file missing, read errors).
- [ ] Check consistency with code style.
- [ ] List ≥3 potential failure modes per modified file.
- [ ] Document findings in `### Red Team Findings`.
- [ ] Fix all issues found.

### Phase 5: Final Verification & Complete
- [ ] Run final compile/test.
- [ ] Review complete diff.
- [ ] Call `complete_workflow_phase(phase: 5, ...)`
