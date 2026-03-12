# Task Tracking

- [x] Read `accuracy.md`, `WORKFLOW_INTEGRITY.md`, the plan file, and the affected implementation/runtime files
- [x] Reconcile the current codebase against the plan and identify the exact remaining delta
- [x] Update the tracked runtime artifacts so the shipped extension matches the TypeScript source
- [x] Verify the implementation group with compile output and readback of changed lines
- [x] Perform red-team self-review and record concrete failure modes with line references
- [x] Run final verification and review the final diff

### Detailed Plan

1. Compare the planned `enhance` routing changes against both the TypeScript source files and the checked-in JavaScript/runtime outputs to determine whether any source edits are still required.
2. If the TypeScript source already matches the plan, rebuild the extension so `dist/*` reflects the same behavior and verify whether any runtime artifacts were already current.
3. Read back the changed lines in the rebuilt runtime files and confirm the planner Kanban path now forwards `instruction: 'enhance'` and the `CREATED` copy prompt explicitly references `.agent/workflows/enhance.md`.
4. Red-team the final state, document concrete failure modes per modified file, and run a final compile before closing the workflow.

### Dependencies

- `src/extension.ts` and the generated runtime entry must agree on the `switchboard.triggerAgentFromKanban` command signature.
- `src/services/KanbanProvider.ts` and its runtime output must both pass `'enhance'` for planner-triggered Kanban transitions, including auto-move.
- `src/services/TaskViewerProvider.ts` and runtime output must preserve sidebar/raw-link copy behavior while adding the `CREATED` prompt workflow instruction.
- `dist/*` is the extension runtime entrypoint and must be rebuilt for the implementation to take effect in the packaged extension.

### Risks

- If runtime JavaScript remains stale, the extension will ignore the new `instruction` parameter even though the TypeScript source looks correct.
- If the rebuild picks up unrelated in-progress changes, verification must isolate whether they belong to this task before finalizing.
- If the copy prompt change leaks into non-Kanban callers, sidebar copy behavior will regress from raw link to wrapped prompt text.

### Verification Plan

- Run `npm run compile`.
- Read back the rebuilt command bridge and provider outputs to confirm the `instruction` argument is present in runtime code.
- Review the diff for only the expected planner-enhance routing and copy-prompt behavior.

### Verification Record

- `npm run compile` passed and rebuilt the extension bundle successfully.
- Readback confirmed the runtime command bridge accepts `instruction` in `dist/extension.js:633-634`.
- Readback confirmed the runtime clipboard path wraps `CREATED` copies with the `.agent/workflows/enhance.md` directive in `dist/extension.js:5153-5158`.
- Readback confirmed Kanban drag/drop and auto-move both inject `instruction = 'enhance'` for planner transitions in `dist/extension.js:36954-36955` and `dist/extension.js:37110-37111`.
- Readback confirmed the Kanban webview still forwards the card column to the copy handler in `dist/webview/kanban.html:650-654`.
- Final diff review showed no new source edits were required for the requested planner-prompt plan; the implementation was already present in `src/*.ts` and `dist/*` before this execution pass.

### Red Team Findings

- `src/extension.ts:674`: Failure mode reviewed: if the command bridge drops the optional third argument, planner Kanban actions silently degrade back to the lighter sidebar-review path. Verified the runtime bridge still forwards `instruction`.
- `src/services/KanbanProvider.ts:458-459`: Failure mode reviewed: if planner transitions stop mapping to `'enhance'`, drag-and-drop into `PLAN REVIEWED` loses the intended complexity audit. Verified the explicit planner-only branch remains in place.
- `src/services/KanbanProvider.ts:626-627`: Failure mode reviewed: if auto-move omits the same planner instruction, manual drag and timed progression diverge in behavior. Verified auto-move uses the same `'enhance'` injection.
- `src/services/TaskViewerProvider.ts:2797-2802`: Failure mode reviewed: if the `CREATED` copy prompt loses the explicit workflow instruction, cross-IDE execution can revert to a shallow review instead of the `enhance` workflow. Verified the copied text still names `.agent/workflows/enhance.md`.
- `src/services/TaskViewerProvider.ts:2796-2802`: Failure mode reviewed: if prompt wrapping applies to unrecognized columns, the raw-link behavior for later stages would regress. Verified only `CREATED`, `PLAN REVIEWED`, and `CODED` receive wrappers.
- `dist/extension.js:633-634`: Failure mode reviewed: if the bundled runtime lags behind TypeScript source, the packaged extension would ignore the plan despite the repo looking correct. Verified the built runtime contains the updated signature and dispatch path.

### Final Verification

- `npm run compile` passed.
- Runtime readback and source readback match the requested plan behavior.
- `git status --short` for the targeted files shows no new source modifications from this execution beyond the task tracker artifact; the pre-existing `src/webview/kanban.html` edit was left untouched.
