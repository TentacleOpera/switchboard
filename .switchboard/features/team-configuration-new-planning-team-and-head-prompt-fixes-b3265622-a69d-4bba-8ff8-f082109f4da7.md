# Team configuration: new planning team and head prompt fixes

**Complexity:** 6

## Goal

Add a general planning team with an analyst subagent to save the lead's tokens for synthesis, fix five defects in the Coding team head prompt (wrong API endpoint, missing workspaceRoot, context-wall rotation rule, redundant hardcoded orchestrator report instruction), gate the `ORCHESTRATOR_REPORT_DIRECTIVE` on the orchestrator being active, and strengthen the team-lead dispatch skill with roster-filtering and verify-before-undoing rules. These plans are grouped together because they all improve the team configuration and dispatch instructions that team leads and members receive.

## How the Subtasks Achieve This

- **General planning team with analyst subagent to save lead tokens**: Adds a new "Planning with analyst" entry to `SHIPPED_TEAM_TYPES` in `kanban.html` — a planner head with one analyst member that handles code search and context-gathering, saving the lead's context window for synthesis and plan authoring. No backend changes needed; the `analyst` role is already a first-class built-in role.
- **Fix coding team head standing order: API errors and rotation rule**: Rewrites `NEW_CODING_HEAD_PROMPT` in three files (`teamWiring.ts`, `kanban.html`, `terminals.js`) to fix five defects: wrong API endpoint (`GET /kanban/feature` → `GET /kanban/plan?planId=`), missing `workspaceRoot` in dispatch body, context-wall-causing rotation rule ("give that coder the next subtask" → spread across idle seats), redundant hardcoded orchestrator report instruction (now gated by `orchestratorActive` flag), and preservation of the queue/next pipeline-pacing paragraph. Also gates `ensureDispatchProtocolDirectives` on an `orchestratorActive` flag threaded from `isOversightAgentRunning()`, and adds a migration recogniser for already-migrated installs. *(Absorbed former subtask "Gate orchestrator report directive on orchestrator being active" — both plans rewrote the same headPrompt text and are now merged.)*
- **A Team Lead Must Dispatch Only to Its Own Seats, Trust the Roster, and Verify Before Undoing**: Rewrites §10 of `terminal-coder-dispatch/SKILL.md` to teach the lead how to identify its own team's seats (filter `ptyListTerminals` by `parentInstanceId === SWITCHBOARD_AGENT_INSTANCE_ID`), trust the `recommendedRole` field without second-guessing, and verify with `git diff` before sending any revert or stand-down instruction. The headPrompt cross-reference is deferred until the headPrompt rewrite lands.

## Dependencies & sequencing

- **Subtasks 1 and 4 are independent** and can land in any order relative to each other and to subtask 2. Subtask 1 adds a new `SHIPPED_TEAM_TYPES` entry (static data); subtask 4 rewrites the `terminal-coder-dispatch` skill file (no migration, immediate effect).
- **Subtask 2 should land before subtask 4's deferred headPrompt addition.** Subtask 4 explicitly defers its headPrompt cross-reference sentence until the headPrompt text is stable — subtask 2's rewrite is the change that stabilises it. The skill-file changes in subtask 4 (§10 rewrite) do NOT depend on subtask 2 and can land independently.
- **Subtask 2 is self-contained** — it owns the headPrompt rewrite, the `ensureDispatchProtocolDirectives` gating, the migration recogniser, and the three-file sync. No other subtask touches these files.
- **Shared test file**: Subtasks 1 and 2 both modify `standing-orders-marker-contract.test.js` — subtask 1 bumps the prompt count from 3 to 4, subtask 2 adds negative assertions. Both changes are additive and can be applied in either order, but if implemented by different coders on the same branch, the second merge must not revert the first's changes.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [General planning team with analyst subagent to save lead tokens](../plans/feature_plan_20260818000512_general-planning-team-with-analyst-subagent.md) — **CODE REVIEWED**
- [ ] [Fix coding team head standing order: API errors and rotation rule](../plans/feature_plan_20260818000513_fix-coding-team-head-standing-order-api-errors-and-rotation-rule.md) — **CODE REVIEWED**
- [ ] [A Team Lead Must Dispatch Only to Its Own Seats, Trust the Roster, and Verify Before Undoing](../plans/feature_plan_20260818063846_team-lead-must-dispatch-only-to-own-seats-trust-roster-verify-before-undoing.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->


## Review Findings

All three subtasks reviewed in place as one delivery unit. One CRITICAL and two MAJOR findings, all fixed: (1) the second headPrompt migration only reached the group template — `wireSpawnedTeam` never overwrites an existing `team-head` standing order, so already-migrated installs kept the buggy text; a `BUGGY_HEADPROMPT_FRAGMENT` recogniser was added to `migrateCodingTeamOrders` and its `terminals.js` mirror; (2) `GET /kanban/plan?planId=` does not return subtask statuses and omitted `workspaceRoot`, replaced with `GET /kanban/plans?featureId=…&workspaceRoot=…`; (3) the two-arg `ensureDispatchProtocolDirectives` broke four static source-text assertions across two contract suites. Subtask 3's deferred headPrompt cross-reference was also applied — the skill reaches a lead only via the Drive toggle, so a gallery-started Coding team would never have read it. Files changed: `src/services/teamWiring.ts`, `src/webview/terminals.js`, `src/webview/kanban.html`, `src/services/agentPromptBuilder.ts`, and four test suites; validation: `tsc` clean, eslint 0 errors, `standing-orders-marker` 55/55, `stage-marker-commit` 47/47, `seat-safeguards` 95/95, `orchestrator-tick` pass, `team-scoped-role-routing` 41/41, `terminal-groups-key` 18/18, `link-presets-mirror` 7/7, `mirror:check` green. Remaining risk: `buildCustomAgentPrompt` (`agentPromptBuilder.ts:2467`) is still ungated on `orchestratorActive`.
