# Task Tracking

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, and the source plan file.
- [x] Read all impacted sources and dependencies (`src/extension.ts`, `src/webview/implementation.html`, `src/services/TaskViewerProvider.ts`, related Jules tests).
- [x] Run baseline verification (`npm run compile`, `npm run lint`) and capture current status.
- [x] Implement UI/default behavior updates required by the plan (validated existing Jules setup toggle wiring in `implementation.html`).
- [x] Implement terminal creation gating in `createAgentGrid` based on visible agent settings.
- [x] Verify implementation group with compile/lint and readback.
- [x] Perform red-team self-review with concrete failure modes and line numbers.
- [x] Run final verification and diff review.

### Detailed Plan

1. Confirm current setup visibility controls in `implementation.html` and ensure Jules toggle behavior is explicit and synchronized with `lastVisibleAgents`.
2. Update `createAgentGrid` in `extension.ts` to read `await taskViewerProvider.getVisibleAgents()` and only include `Jules Monitor` when `visibleAgents.jules !== false`.
3. Run verification gate commands after implementation (`npm run compile` then `npm run lint`) and capture output.
4. Read back modified sections in both files to verify exact logic.
5. Perform red-team review on modified files and document failure modes.
6. Run final compile/lint and review git diff consistency.

### Dependency Map

- Step 2 depends on Step 1 confirming current visibility wiring in webview and provider.
- Step 3 depends on Step 2 completing both coordinated changes.
- Step 4 depends on Step 3 results.
- Step 5 depends on Step 4 readback.

### Dependencies

- `TaskViewerProvider.getVisibleAgents()` is the source of persisted visibility state from `.switchboard/state.json`.
- `renderAgentList()` already honors `lastVisibleAgents.jules` for sidebar card visibility.
- `createAgentGrid()` currently hardcodes terminal list and must align with visibility state to prevent unwanted Jules Monitor startup.

### Risks

- If `getVisibleAgents()` fails or returns defaults unexpectedly, Jules Monitor may still appear due to default `true`.
- Filtering the agents list changes cleanup behavior in `clearGridBlockers`; stale Jules terminals may persist unless explicitly handled.
- UI toggles can desynchronize if startup visibility and onboarding visibility controls are updated inconsistently.

### Verification Plan

- `npm run compile`
- `npm run lint` (expected existing config failure unless repo-level lint config changes)
- Read back modified ranges in `src/extension.ts` and `src/webview/implementation.html`
- Review git diff for only intended files and logic

### Verification Record

- Baseline `npm run compile`: PASS.
- Baseline `npm run lint`: FAIL (ESLint v9 config missing: `eslint.config.*` not present).
- Post-change `npm run compile`: PASS.
- Post-change `npm run lint`: FAIL (same pre-existing ESLint v9 config issue).
- Final `npm run compile`: PASS.
- Final `npm run lint`: FAIL (same pre-existing ESLint v9 config issue).
- Final diff review: scoped logic change confirmed in `src/extension.ts`; no `implementation.html` functional changes required because Jules setup toggle wiring already exists.
- Readback confirmed `createAgentGrid` now gates Jules terminal inclusion via `visibleAgents.jules` and disposes hidden Jules Monitor terminals (`src/extension.ts:1453-1501`).
- Readback confirmed setup still exposes Jules visibility toggle and defaults are sourced from `lastVisibleAgents` (`src/webview/implementation.html:1354`, `src/webview/implementation.html:1754`).

### Red Team Findings

- `src/extension.ts:1453-1454`: If `.switchboard/state.json` cannot be read, `getVisibleAgents()` falls back to defaults and may re-enable Jules unexpectedly.
- `src/extension.ts:1493-1499`: Name-based matching for `Jules Monitor` could dispose a user terminal with a colliding name prefix.
- `src/extension.ts:1493-1500`: Disposing the terminal does not explicitly verify child process shutdown beyond terminal lifecycle; external detached subprocesses could survive.
- `task.md:8-10`: Checklist state is manually maintained and can become inaccurate if commands are re-run but status lines are not updated in lockstep.
- `task.md:47-55`: Verification records can become stale if new command runs occur after edits and the log is not appended.
- `task.md:57-64`: Red-team findings are point-in-time; future refactors can invalidate line references without obvious signal.
