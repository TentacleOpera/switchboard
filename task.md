# Task Tracking

## MCP polling removal execution (feature_plan_20260312_053351_remove_mcp_server_polling)

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, and the source plan file.
- [x] Read impacted implementation surfaces (`src/extension.ts`) and related tests/interfaces.
- [x] Run baseline verification (`npm run compile`, `npm run lint`) and capture status.
- [x] Apply plan changes plus inline challenge corrections in `src/extension.ts`.
- [x] Verify implementation gate (`npm run compile`) and read back modified code.
- [x] Perform red-team self-review with concrete failure modes + line references.
- [x] Run final verification and diff review.

### Verification Record (MCP polling removal)

- Baseline `npm run compile`: PASS.
- Baseline `npm run lint`: FAIL (pre-existing ESLint v9 config migration issue: missing `eslint.config.*`).
- Post-change `npm run compile`: PASS.
- Final `npm run compile`: PASS.
- Final `npm run lint`: FAIL (same pre-existing ESLint config issue, unchanged by this task).
- Scoped diff review: only `src/extension.ts` logic and this `task.md` tracking section.

### Red Team Findings (MCP polling removal)

- `src/extension.ts:2712-2715` — Failure mode: non-standard packaging path could miss `mcp-server.js` and show false negative; mitigation: check both `dist` and `src` extension layouts.
- `src/extension.ts:2728-2732` — Failure mode: MCP config read exceptions were previously silent; mitigation: explicit output-channel logging plus `Unable to read IDE MCP config` diagnostic.
- `src/extension.ts:2740-2742` — Failure mode: prior diagnostic implied runtime tool health; mitigation: wording changed to static signal (`MCP server file detected`) to avoid false observability claims.
- `task.md:3-11` — Failure mode: checklist drift if execution order changes; mitigation: checklist now reflects completed gates in-order for this plan run.
- `task.md:13-19` — Failure mode: verification evidence can become stale after additional edits; mitigation: this run records baseline/post/final command outcomes explicitly.
- `task.md:21-27` — Failure mode: line references can age as file evolves; mitigation: references are snapshot-scoped to this execution block and not reused across tasks.

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

## Kanban controls strip execution (feature_plan_20260316_065159_add_main_controls_strip_at_top_of_kanban_board)

- [x] Read `accuracy.md`, `.agent/rules/WORKFLOW_INTEGRITY.md`, `.agent/rules/switchboard_modes.md`, and the source plan file.
- [x] Read impacted implementation surfaces (`src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, related types/tests).
- [x] Run baseline verification (`npm run compile`, `npm run lint`) and capture status.
- [x] Perform inline adversarial review and apply corrections before coding.
- [x] Implement controls strip UI wiring in `src/webview/kanban.html`.
- [x] Implement backend handlers/prompts/auto-advance logic in `src/services/KanbanProvider.ts`.
- [x] Verify implementation gate (`npm run compile`) and read back modified files.
- [x] Perform red-team self-review with concrete failure modes + line references.
- [x] Run final verification and diff review.

### Verification Record (Kanban controls strip)

- Baseline `npm run compile`: FAIL (pre-existing TypeScript syntax errors in `src/services/KanbanDatabase.ts`, e.g. around lines 175/187/197/202).
- Baseline `npm run lint`: NOT RUN (compile failed first in chained baseline command).
- Post-change `npm run compile` (first pass): FAIL (pre-existing `src/services/KanbanDatabase.ts` parse/syntax errors in workspace state during that run).
- Final `npm run compile`: PASS.
- Final `npm run lint`: FAIL (pre-existing ESLint v9 config migration issue: missing `eslint.config.*`).
- `npm test`: FAIL at pretest lint step (same pre-existing ESLint config issue); compile/tests setup otherwise reaches `compile-tests` and webpack compile.
- Diff/readback review completed for: `src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, `src/extension.ts`.

### Red Team Findings (Kanban controls strip)

- `src/webview/kanban.html:455-465` — Failure mode: controls strip can wrap on narrow width and push action order around; mitigation: keep actions id-based and avoid positional assumptions in listeners.
- `src/webview/kanban.html:657-666` — Failure mode: Jules button visibility can stale if no `visibleAgents` message arrives yet; mitigation: initialize with hidden default + call `updateJulesButtonVisibility()` at startup.
- `src/webview/kanban.html:989-1004` — Failure mode: rapid multi-click on batch buttons can issue duplicate backend actions; mitigation: backend re-validates current column before advancing sessions.

- `src/services/KanbanProvider.ts:374-439` — Failure mode: stale UI snapshots could move cards already changed by other flows; mitigation: `_advanceSessionsInColumn` re-derives current column from runsheet before writing workflow event.
- `src/services/KanbanProvider.ts:781-816` — Failure mode: batch prompt buttons could claim advancement despite partial eligibility; mitigation: status messages now report actual advanced count after guarded checks.
- `src/services/KanbanProvider.ts:819-826` — Failure mode: Jules dispatch could run while Jules is disabled; mitigation: explicit `visibleAgents.jules` guard and warning before dispatch.

- `src/services/TaskViewerProvider.ts:1007-1022` — Failure mode: UI toggle desync if autoban state persisted but engine not restarted/stopped; mitigation: method updates workspace state and applies the same start/stop semantics as sidebar updates.
- `src/services/TaskViewerProvider.ts:1012-1019` — Failure mode: enabling while already enabled could keep stale timer config; mitigation: restarts engine when enabled to rehydrate active timers/rules.
- `src/services/TaskViewerProvider.ts:1021` — Failure mode: kanban indicator lag after toggle; mitigation: `_postAutobanState()` rebroadcasts to both sidebar and kanban views.

- `src/extension.ts:829-832` — Failure mode: missing command registration would make AUTOBAN button no-op; mitigation: explicit command registration routes to `TaskViewerProvider.setAutobanEnabledFromKanban`.
- `src/extension.ts:829-832` — Failure mode: non-boolean payload from webview could produce inconsistent state; mitigation: command coerces with `!!enabled`.
- `src/extension.ts:829-832` — Failure mode: un-awaited state transition could race with subsequent UI refresh; mitigation: registration awaits provider method.

- `task.md:96-136` — Failure mode: checklist drift if another edit happens after verification; mitigation: this block records exact command outcomes and touched files for this run only.
- `task.md:112-117` — Failure mode: lint/test failures could be misattributed to this feature; mitigation: records unchanged pre-existing ESLint config blocker explicitly.
- `task.md:120-136` — Failure mode: line references may age as files move; mitigation: references are scoped to this execution snapshot and should be refreshed on future edits.
