# External-Headed Team Mode — Non-Terminal Agent as Team Lead

## Goal

Enable a non-terminal agent (IDE chat, Antigravity, any agentic chat app with file system + curl access) to act as the head of a team of terminal-based worker agents. The external agent dispatches subtasks to its workers, reads their reports from a team-specific directory, verifies work via git, and advances cards — all over HTTP and the filesystem, with no terminal assignment for the head itself. The external agent's own scheduler (e.g. Antigravity's schedule skill) acts as the tick mechanism, waking it periodically to check reports and dispatch new work.

### Problem & background

Today, every team head is a PTY terminal. `instantiateAgentGroupCore` (`src/services/agentGroupInstantiation.ts:65`) calls `createHeadWithDelegates` to spawn a head terminal plus delegate terminals, then `wireSpawnedTeam` (`src/services/teamWiring.ts:899`) installs standing orders and registers the group. The head's identity is a terminal `friendlyName`, and three things depend on that:

1. **Worker → head reporting.** Workers are instructed to report via `POST /terminals/verb/ptySendPrompt` with `{"name":"<headName>","data":"<report>"}` (`teamWiring.ts:54-57`). No head terminal = reports have nowhere to land.
2. **Head prompt delivery.** The head's instructions are installed as a `team-head`-scoped standing order (`teamWiring.ts:996-1007`), delivered by injecting text into the terminal's prompt stream via `applyStandingOrders` → `selectOrders` (`standingOrders.ts:214-221`). No terminal = no delivery channel.
3. **Group identity.** `wireSpawnedTeam` registers the team in `terminals.groups` with `headName` as the group name (`teamWiring.ts:1041-1048`). The sidebar, tab strip, and `getGroupMembers` resolve against live terminal names — but `getGroupMembers` for a `manual` group filters `order`/`members` through the live set (`terminals.js:2758-2765`), so a head name with no corresponding terminal silently drops out. The workers still resolve.

### Root cause — the head is coupled to a PTY process, but the decision surface is HTTP

The head's *outbound* actions are all HTTP calls that any agent with curl access can make: `POST /kanban/dispatch` (with `from` for team routing), `POST /terminals/verb/ptySendPrompt` (to send prompts to workers), `GET /kanban/board`, `GET /kanban/feature`, `POST /kanban/move`, git verification. The `switchboard-orchestration` skill already documents "Workflow B — external orchestrator driving the board" for external agents.

The head's *inbound* channel is the only hard coupling: workers report via `ptySendPrompt` to the head's terminal, and the head's own instructions are delivered via standing orders into the terminal's prompt stream. An external agent has no prompt stream and no terminal name in the fleet.

Critically, **dispatch routing already works for a virtual head.** `resolveTeamScopedRoleTerminal` (`teamWiring.ts:1415`) and `resolveTeamMembersForHead` (`teamWiring.ts:1511`) derive the group ID from the head name (`'team_' + encodeURIComponent(originName)`) and look up the group by that ID. They do not check if the head is a live terminal. An external agent whose name matches a registered group ID can dispatch to its workers via `POST /kanban/dispatch` with `from` set to its own name — the team-scoped routing finds the workers by role.

### Scope note — team lead mode only, not orchestrator mode

The orchestrator case (external agent driving the whole board) is already covered by the `/switchboard` skill and the plans currently being coded to rewrite it. This plan is **team lead mode only**: an external agent heading one team of terminal workers on a specific feature. It does not manage the whole board, group features, or run column sweeps.

This plan does not modify the existing pty fleet team system. An external-headed team is a new team, created specifically for the external agent. It does not take over an existing pty fleet team.

---

## Metadata

- **Complexity:** 6
- **Tags:** frontend, backend, api, ui, ux, feature
- **Project:** Browser Switchboard

---

## User Review Required

This plan introduces a new team type where the head is not a terminal. It modifies the team creation path (`agentGroupInstantiation.ts`, `teamWiring.ts`), adds a new API endpoint (`LocalApiServer.ts`), and creates a new file-based reports channel. The external agent's schedule skill is the tick mechanism — the plan assumes the agent can read files and make HTTP calls on each wake, but the exact schedule-skill mechanics vary by host (Antigravity, Cursor, Zed). Review the head prompt file format and the reports directory convention before dispatch.

---

## Complexity Audit

### Routine
- Registering a group in `terminals.groups` with a virtual head name (existing `wireSpawnedTeam` path, just no head terminal).
- Creating a reports directory with exclusive-create + frontmatter mechanics (reuse `ScheduledJobsService.ts` patterns — `writeInboxFile`, `claimInboxItemIn`).
- Writing a head prompt file (static text generation with interpolated team roster + endpoints).
- Sidebar display: the group is registered, so `buildTeamClaimMap` and the team tab strip pick it up. Workers appear under a team subheader. No head row — `getGroupMembers` filters the head name out of the live set.

### Complex / risky
- **New team creation path that skips the head terminal.** `instantiateAgentGroupCore` calls `createHeadWithDelegates` which spawns a head + delegates. For an external head, only delegates are spawned. This is a new code path, not a flag on the existing one — the head terminal creation is not optional in the current flow, it's the first thing that happens.
- **Modified callback instruction for workers.** The `AGENT_GROUP_CALLBACK_INSTRUCTION` (`teamWiring.ts:54-57`) tells workers to report via `ptySendPrompt`. For external-headed teams, workers must write to `.switchboard/teams/<teamId>/reports/` instead. The standing order text must be different, and the `team-head` scoped order is skipped (no head terminal to deliver to).
- **`POST /kanban/queue/next` — the lead-paced pipeline.** The "Lead-Paced Pipeline" feature (7 subtasks, all in LEAD CODED) makes `queue/next` the team lead's primary mechanism for pulling the next feature. `dispatchNextFromQueue` (`LocalApiServer.ts:1480`) uses `targetTerminalOverride: from` to dispatch the card **to the head's terminal** — the lead asked, the lead receives, and it delegates subtasks itself. For an external head with no terminal, that dispatch target is a non-existent terminal. The external lead still needs the pull-and-pace behavior (serialized pop, in-flight refusal, empty-queue signal), but the card must not be dispatched to a terminal — it must be returned to the external agent so it can dispatch subtasks to its workers via `POST /kanban/dispatch`. This requires a modified `queue/next` path for external heads: same serialization and in-flight check, but no `targetTerminalOverride` — instead, the card is moved to the complexity-routed coding column and the external agent receives the card info to act on.
- **Schedule skill as tick.** The plan assumes the external agent's schedule skill can wake it periodically and that it can read files + make HTTP calls on each wake. The exact mechanics vary by host. The head prompt file must be self-contained enough that any scheduler-driven agent can operate from it.

---

## Edge-Case & Dependency Audit

| Case | Behaviour |
|---|---|
| Worker exits | The external agent detects it via `ptyListTerminals` or `GET /kanban/board` (the card's `dispatched_terminal` becomes stale). Same as a terminal head losing a worker. |
| External agent stops waking | Workers idle, reports pile up unread in `.switchboard/teams/<teamId>/reports/`. Same as a terminal head going idle — no special handling. |
| Multiple external-headed teams | Each has its own `teamId` and reports directory. Group IDs are derived from the external agent's name, so they don't collide as long as names are unique. |
| External agent name collides with an existing terminal name | The group ID derivation (`'team_' + encodeURIComponent(name)`) would collide. The creation path must reject a name that matches an existing terminal or group. |
| Worker tries `ptySendPrompt` to the head | The call fails (no terminal with that name). The modified callback instruction tells workers to write to the reports directory instead, so this should not happen — but a worker that somehow retains the old instruction would get a silent failure. |
| Team tab strip click | Clicking the team tab locks to the team. `getGroupMembers` returns only the workers (head name filtered out), so `seatActiveGroupPage` seats the workers. The head is not seated — it has no pane. This works correctly today. |
| `POST /kanban/queue/next` with `from` = external agent name | `resolveTeamMembers` finds the group (by ID derivation) and returns the roster. The in-flight check works (team membership by group, not by terminal). But `targetTerminalOverride: from` would dispatch to the non-existent head terminal. The external-headed path must skip the override and instead move the card to the complexity-routed coding column without a terminal dispatch, returning the card info so the external agent can dispatch subtasks to its workers. The serialized pop and in-flight refusal still apply — the external lead is paced the same way a terminal lead is. |
| Browser cockpit | The team appears in the sidebar (shared `terminals.js`). The head prompt file and reports directory are filesystem-based, so the browser cockpit can't read them directly — but the external agent reads them from its own filesystem, not from the browser. |

**Dependencies:** none outside this repo. Reuses `wireSpawnedTeam` (modified), `ScheduledJobsService.ts` patterns (reports directory), `LocalApiServer.ts` (new endpoint), existing HTTP endpoints (dispatch, ptySendPrompt, board reads).

---

## Dependencies

None outside this repo. Reads `terminalGroups` (already loaded), `collapsedGroups` (already persisted), `compareTerminals` (unchanged). Reuses `writeInboxFile` / `claimInboxItemIn` patterns from `ScheduledJobsService.ts` for the reports directory.

**Feature dependency:** The "Lead-Paced Pipeline" feature (`3e8b662b-a8a8-42c5-8e43-6d67998aa201`, 7 subtasks all in LEAD CODED) introduces `POST /kanban/queue/next` and `dispatchNextFromQueue` — the team lead's pull mechanism. This plan's `queue/next` modification for external heads depends on subtask 1 (`lead-paced-pipeline-1-queue-next-endpoint.md`) landing first. The external-headed `queue/next` path is a branch inside `dispatchNextFromQueue`, not a parallel endpoint — it reuses the same serialization chain and in-flight predicate, just skips `targetTerminalOverride` when the `from` name resolves to an external-headed team (no live head terminal).

---

## Resolved Assumptions

- **`POST /kanban/dispatch` with a non-terminal `from`.** Verified by code investigation: `performKanbanDispatch` (`LocalApiServer.ts:1306`) uses `originTerminal` as a string for team-scoped routing via `resolveTeamRoleTerminal` (line 1390) and does NOT validate it as a live terminal. The `originTerminal` is passed to `resolveTeamRoleTerminal` which derives the group ID from the name and looks up workers by role — it never checks if the origin is a terminal. Dispatch routing works for a virtual head. This was a bucket-2 (code-answerable) uncertainty, now resolved.
- **Schedule skill mechanics.** Confirmed by web research (August 2026). All three target platforms support the periodic-wake pattern this plan requires:
  - **Antigravity** has a native `/schedule` skill with cron syntax, background subagent spawning, and context reset per wake. State persists via workspace files — exactly the head-prompt-file pattern this plan proposes.
  - **Cursor** has native Automations (cron schedules, webhooks, cloud sandbox).
  - **Zed** supports external cron + ACP agents.
  Across all platforms, the universal architecture is **stateless wake + file-based persistence**: each wake starts with a clean context, reads a state/head-prompt file to re-orient, and writes updated state back. This is precisely the `head-prompt.md` + `reports/` design in this plan. The external agent's own scheduler is the trigger — Switchboard does not install or manage it.

---

## Adversarial Synthesis

Key risks: (1) the new team creation path diverges from the existing `instantiateAgentGroupCore` flow and creates a second wiring path that can drift — mitigated by reusing `wireSpawnedTeam` with a modified callback instruction rather than writing a parallel wiring function, and by using a dedicated `createDelegatesOnly` variant instead of overloading `createHeadWithDelegates`; (2) `queue/next` dispatches to the head's terminal via `targetTerminalOverride: from`, which fails for a virtual head — mitigated by branching inside `dispatchNextFromQueue` to skip the override for external-headed teams, preserving the same serialization and in-flight refusal; (3) the head prompt file becomes stale if the team roster changes and the file is not regenerated — mitigated by specified regeneration call sites in `instantiateExternalHeadedTeam` and `wireSpawnedTeam`; (4) the `queue/next` branch depends on the Lead-Paced Pipeline feature's subtask 1 landing first — this plan cannot ship independently of it; (5) the Verification Plan's unit test assertion for `dispatchNextFromQueue` was corrected from 'rejects' to 'handles' to match the Proposed Changes. The schedule-skill-as-tick assumption is confirmed by web research — all three target platforms (Antigravity, Cursor, Zed) support the periodic-wake + file-based-state pattern natively.

---

## Proposed Changes

### 1. `src/services/teamWiring.ts` — external-headed team wiring

**1a. New callback instruction for external-headed teams.** A parallel to `AGENT_GROUP_CALLBACK_INSTRUCTION` that tells workers to write reports to a directory instead of calling `ptySendPrompt`:

```ts
export const EXTERNAL_HEAD_CALLBACK_INSTRUCTION =
    '{child} is your head agent. When you finish a task, report to it — write a report file to '
    + '.switchboard/teams/{teamId}/reports/ named report-<UTC-compact>-<kind>-<5 digits>.md '
    + 'with frontmatter (from: <your seat name>, kind: finished|blocked|question|status, '
    + 'planId: <plan id>, created: <UTC timestamp>) and a one-line message body. '
    + 'Do not wait to be asked.';
```

**1b. Modified `wireSpawnedTeam` for external heads.** A new option `externalHead?: boolean` on `WireSpawnedTeamOptions`. When set:
- The callback instruction uses `EXTERNAL_HEAD_CALLBACK_INSTRUCTION` with `{teamId}` interpolated to the group ID.
- No `team-head` scoped standing order is installed (there is no head terminal to deliver it to).
- The group is registered with the external agent's name as `headName` and `name`, but the `members` array includes only the worker names (not the head name — the head is not a terminal and should not appear in `getGroupMembers` even as a filtered-out entry, to keep the roster clean for `seatActiveGroupPage`). **Routing safety:** excluding the head from `members` does not break team routing — `resolveTeamMembersForHead` and `resolveTeamScopedRoleTerminal` derive the group ID from the head name (`'team_' + encodeURIComponent(originName)`), not from the `members` array. The `candidatesIn` function in `resolveTeamScopedRoleTerminal` skips `originName` in the roster; if the head isn't in the roster, the skip is a no-op, which is correct.

**1c. Team-specific reports directory.** A new function `bootstrapTeamReportsDirectory(workspaceRoot, teamId)` that creates `.switchboard/teams/<teamId>/reports/claimed/` with the same lazy-creation guard as `bootstrapOrchestratorReportsDirectory` (`ScheduledJobsService.ts:175-190`). Reuses the same `mkdir -p` + existence-check pattern.

### 2. `src/services/agentGroupInstantiation.ts` — external-headed team creation

**2a. New creation path: `instantiateExternalHeadedTeam`.** A parallel to `instantiateAgentGroupCore` that:
- Skips head terminal creation — calls a new `createDelegatesOnly` variant (parallel to `createHeadWithDelegates`) that spawns only the delegate terminals. Overloading `createHeadWithDelegates` with an empty head role risks spawning a terminal anyway (the function name says 'createHead'); a dedicated variant is cleaner and avoids conditional logic inside the existing path.
- Calls `wireSpawnedTeam` with `externalHead: true`, the external agent's name as `headName`, and the spawned workers as `children`.
- Creates the team-specific reports directory.
- Writes the head prompt file (see 2b).
- Returns the team ID, worker names, and head prompt file path.

**2b. Head prompt file generation.** A new function `writeHeadPromptFile(workspaceRoot, teamId, opts)` that writes `.switchboard/teams/<teamId>/head-prompt.md` containing:
- The team roster (worker names + roles).
- The feature being worked (if specified).
- The dispatch instructions: `POST /kanban/dispatch` with `from` = external agent name, `POST /terminals/verb/ptySendPrompt` to send prompts to workers.
- The reports directory path: `.switchboard/teams/<teamId>/reports/`.
- The board read endpoints: `GET /kanban/board`, `GET /kanban/feature`, `GET /kanban/plans`.
- **Port discovery.** The LocalApiServer port. Either the exact `http://localhost:<port>` URL, or a directive to read `.switchboard/api-server-port.txt` (or `.switchboard/api-port`) for the port. All HTTP endpoints in the head prompt are relative to this port. Without it, the external agent cannot reach any Switchboard endpoint.
- The verification pattern: `git -C <worktree> rev-list --count <base>..HEAD`.
- The advance pattern: `POST /kanban/move` or `POST /kanban/dispatch` with `targetColumn`.
- The pull pattern: `POST /kanban/queue/next` with `from` = external agent name, to pull the next feature when the current one passes review. Returns the card info or `dispatched: null` (queue empty — report and stop). In-flight refusal (409) means the team still has work in a coding column.
- The schedule-skill tick instructions: on each wake, read this file, read reports, dispatch/advance, verify.
- The `from` field value (the external agent's name) for dispatch routing.

The file is regenerated on every team modification (worker added/removed, feature assigned). The regeneration call sites are: (a) inside `instantiateExternalHeadedTeam` (initial write), and (b) inside `wireSpawnedTeam` when called with `externalHead: true` and an existing team is being updated (worker roster change). A team modification that does not pass through `wireSpawnedTeam` must call `writeHeadPromptFile` explicitly — the head prompt file is the external agent's only interface, and a stale roster is a silent failure.

### 3. `src/services/LocalApiServer.ts` — new API endpoint

**3a. `POST /teams/create-external`.** A new endpoint that:
- Body: `{ template: string, headName: string, featureId?: string, workspaceRoot?: string }`.
- `template` is a team template name (e.g. "Coding") — resolved the same way the existing team gallery resolves templates.
- `headName` is the external agent's name (becomes the team name + group ID key).
- `featureId` optionally assigns the team to a feature.
- Calls `instantiateExternalHeadedTeam` (2a).
- Returns: `{ success, teamId, workers: [...], headPromptFile, reportsDir }`.
- Rejects a `headName` that collides with an existing terminal name or group ID (400).

**3b. Branch `queue/next` for external-headed teams.** In `dispatchNextFromQueue` (`LocalApiServer.ts:1480`), after resolving the roster via `resolveTeamMembers`, detect whether `from` names an external-headed team (the group exists but the head name is not a live terminal). If so:
- The serialized pop and in-flight refusal still apply (same chain, same predicate — the external lead is paced identically to a terminal lead).
- Skip `targetTerminalOverride: from` — there is no head terminal to dispatch to.
- Instead, call `performKanbanDispatch` with complexity routing only (no override), which moves the card to the routed coding column and fires the column's role prompt. The external agent then dispatches subtasks to its workers via `POST /kanban/dispatch` with `from` = its own name.
- The response returns the card info (planId, topic, column, routing) so the external agent knows what to work.
- The `NEW_CODING_HEAD_PROMPT` instruction to call `queue/next` after review passes is included in the head prompt file (2b), so the external lead knows to pull the next card.

This is a branch inside `dispatchNextFromQueue`, not a parallel endpoint. It depends on the Lead-Paced Pipeline feature's subtask 1 landing first.

### 4. `src/services/ScheduledJobsService.ts` — team reports directory helpers

Export `bootstrapTeamReportsDirectory` and `writeTeamReport` (parallel to `writeOrchestratorReport` but writing to `.switchboard/teams/<teamId>/reports/`). Same exclusive-create + frontmatter flatten mechanics. The claiming mechanism reuses `claimInboxItemIn` with the team-specific `claimed/` subdirectory.

### 5. Sidebar display — no changes needed

The group is registered in `terminals.groups` with `source: 'manual'`, so:
- `buildTeamClaimMap` (from the team subheaders plan) picks it up — workers appear under a team subheader.
- The team tab strip renders a tab for the team.
- `getGroupMembers` returns only the workers (head name is not in the live set).
- `seatActiveGroupPage` seats the workers — the head is not seated.

No sidebar code changes are needed. The team subheaders feature (when implemented) will display these teams automatically. Until then, the team tab strip is the primary visual surface.

### 6. External agent skill — `.agents/skills/external-team-lead/SKILL.md`

A new skill file that tells the external agent how to operate as a team lead:
- Read `.switchboard/teams/<teamId>/head-prompt.md` on each wake.
- Read `.switchboard/teams/<teamId>/reports/` for worker reports.
- The wake mechanism — the external agent manages its own wake loop. Switchboard does not install or manage any scheduler. The key constraint: the wake mechanism should stay within a single chat session — recurring cron jobs that spawn a new chat per tick will spam the sidebar with sessions. Three options, whichever the platform supports:
  1. **Event-driven background watcher** (preferred). If the platform can run background tasks (e.g. Antigravity's `run_command` with `IsDaemon: true`, or any agent platform with a background daemon/shell capability), the agent launches a single background watcher script in the current chat session that polls `reports/` for new files. While workers are coding, it is silent. When a report file appears, the watcher exits and the platform reactively wakes the agent in the same chat thread to review, advance, and re-arm the watcher. Zero extra sessions created.
  2. **In-session one-shot timer** (alternative). Instead of a recurring cron, the agent sets a single one-shot timer (e.g. Antigravity's `schedule` with a duration, not a recurring cron expression). When the timer fires, it delivers a message into the current conversation — not a new session. After checking reports, the agent sets the next one-shot timer if work is still in flight. Self-chaining, not recurring.
  3. **Manual** (fallback). The user prompts "check team status" in the chat. The agent reads the head prompt, reads reports, acts.
  On each wake, the agent reads this file, reads reports, dispatches/advances, and exits. The tick is the same regardless of wake mechanism. **Avoid recurring cron schedules that spawn a new chat session per tick** — they will fill the sidebar with sessions every interval.
- **Report claiming.** After processing a report file, move it to `.switchboard/teams/<teamId>/reports/claimed/` (or delete it). Unprocessed reports stay in `reports/`. This prevents the next tick from reprocessing old reports. The claiming mechanism reuses `claimInboxItemIn` from `ScheduledJobsService.ts` — the same exclusive-create + `claimed/` subdirectory pattern the orchestrator reports use.
- The pull pattern: `POST /kanban/queue/next` with `from` = external agent name to get the next feature when the current one passes review.
- The HTTP endpoint reference (same as `switchboard-orchestration` skill, scoped to team-lead actions).
- The `from` field value for dispatch routing.
- The verification pattern (git, not self-report).

This skill is documentation — it tells the external agent what to do, not how Switchboard behaves. It references the `switchboard-orchestration` skill for the HTTP surface and the `switchboard-contracts` skill for behavior contracts.

---

## Verification Plan

1. **Unit:** `node src/test/terminal-sidebar-groupings-contract.test.js` — verify external-headed teams appear in the group system (group registered, `getGroupMembers` returns workers only).
2. **Unit:** New test `src/test/external-headed-team-contract.test.js` — verify:
   - `wireSpawnedTeam` with `externalHead: true` installs no `team-head` scoped order.
   - The callback instruction points to `.switchboard/teams/<teamId>/reports/`.
   - The group `members` array excludes the head name.
   - `resolveTeamMembersForHead` resolves the group by the external agent's name.
   - `resolveTeamScopedRoleTerminal` finds workers by role on the external-headed team.
   - `dispatchNextFromQueue` handles `from` = external agent name correctly: skips `targetTerminalOverride`, moves the card to the complexity-routed coding column, and returns the card info (no terminal dispatch). The in-flight refusal still applies.
   - `ptySendPrompt` to the external head's name returns `{success: false, error: ...}` (not a silent success) — a worker that retains the old callback instruction gets a visible failure, not a dead-click.
3. **Regression:** `node src/test/standing-orders-marker-contract.test.js` — verify existing pty fleet team wiring is unchanged.
4. **UAT — create team.** `POST /teams/create-external` with template "Coding" and headName "Antigravity-lead". Workers spawn as terminals. The team appears in the tab strip. The head prompt file exists at `.switchboard/teams/<teamId>/head-prompt.md`.
5. **UAT — dispatch.** The external agent calls `POST /kanban/dispatch` with `from: "Antigravity-lead"`. The subtask is routed to a worker on the team (team-scoped routing works).
6. **UAT — worker report.** A worker writes a report to `.switchboard/teams/<teamId>/reports/`. The external agent reads the directory on its next schedule-skill wake and sees the report. After processing, the report is moved to `.switchboard/teams/<teamId>/reports/claimed/` — the next tick does not reprocess it.
7. **UAT — schedule tick.** The external agent's schedule skill wakes it. It reads the head prompt, reads reports, dispatches new work or advances cards. The cycle repeats.
8. **UAT — queue/next for external head.** `POST /kanban/queue/next` with `from: "Antigravity-lead"` pops the next staged card, moves it to the complexity-routed coding column, and returns the card info. No terminal dispatch occurs (no `targetTerminalOverride`). The in-flight refusal still applies — a second call while the team has a card in a coding column returns 409.
9. **UAT — sidebar.** The team appears as a tab in the team tab strip. Clicking it seats the workers in panes. The head is not seated.

---

## Complexity Recommendation

Complexity 6 — **Send to Coder**.

---

## Completion Report

Implemented External-Headed Team Mode allowing non-terminal external agents to act as team leads over terminal workers. Added `EXTERNAL_HEAD_CALLBACK_INSTRUCTION`, `bootstrapTeamReportsDirectory`, `writeTeamReport`, and `externalHead` handling in `src/services/teamWiring.ts` and `src/services/ScheduledJobsService.ts`. Implemented `writeHeadPromptFile` and `instantiateExternalHeadedTeam` in `src/services/agentGroupInstantiation.ts`. Added `POST /teams/create-external` endpoint and branched `dispatchNextFromQueue` for external heads in `src/services/LocalApiServer.ts` and `src/standalone/bootstrap.ts`. Authored the `.agents/skills/external-team-lead/SKILL.md` skill guide and contract test suite `src/test/external-headed-team-contract.test.js`. No issues encountered.

## Review Findings

Reviewed and fixed in place: two CRITICALs (`bootstrap.ts` called a non-existent `kanbanProvider.getKanbanDb` → whole build red; a dead `bootstrapTeamReportsDirectory` re-export in `teamWiring.ts` added a module edge that turned the plan's own `standing-orders-marker-contract` suite red) plus twelve MAJORs — `queue/next`'s live-terminal fallback could silently demote a real terminal lead, the external-head dispatch fell through to workspace-wide routing when the team had no seat for the routed role (cross-team card leak that also blinded the in-flight predicate), the `headName` collision guard read the legacy `terminals.groups` key instead of `switchboard.prompts.terminals.groups` and was a no-op, the VS Code host never wired `createExternalTeam`, `protocol-catalog.json` was stale against the CI `catalog:check` gate, the new contract test was in neither `package.json` nor CI, three of its assertions were missing or wrong, `BUILTIN_TEMPLATES` was duplicated and fabricated across two hosts, `writeHeadPromptFile` scaffolded `.switchboard` into non-Switchboard workspaces, the `workspaceRoot` wiring option was dead (regeneration call site (b) absent), the skill was in no discovery manifest, and both the head prompt and the skill documented a `GET /kanban/feature` route that does not exist. Files changed: `src/standalone/bootstrap.ts`, `src/services/{LocalApiServer,TaskViewerProvider,teamWiring,agentGroupInstantiation,ClaudeCodeMirrorService}.ts`, `src/test/external-headed-team-contract.test.js`, `package.json`, `.github/workflows/integration-tests.yml`, `protocol-catalog.json`, `.agents/.claude/skills/external-team-lead/SKILL.md`, `AGENTS.md`, `CLAUDE.md`. Validation: `tsc -p tsconfig.test.json` clean; external-headed-team 9/9, standing-orders-marker 55/55, terminal-sidebar-groupings 48/48, queue-pipeline, team-scoped-routing 41/41, pty-route-surface, dispatch-view, headless-feature-mgmt 46/46 + destructive 11/11, terminal-plan-attribution 40/40 all green; `catalog:check` green. Remaining risks: an external team created from a member-less template registers a zero-member group and then 400s on `queue/next`; the plan's Verification Plan says "no terminal dispatch" while Proposed Changes 3b says "fires the column's role prompt" — the implementation follows 3b, which is the only reading under which the in-flight refusal the plan also requires can function, since that predicate keys on `dispatched_terminal` team membership.

## Completion Report (Review Pass)

Executed a direct reviewer pass with advanced regression analysis over the external-headed team mode implementation, then applied fixes for every valid CRITICAL and MAJOR finding. Fixed the build-breaking `getKanbanDb` call, removed the dead re-export that broke a named regression suite, made the roster decisive for external-head detection in `dispatchNextFromQueue`, added `restrictToOriginTeam` so an external team's card can never leak to another team's terminal, corrected the group-collision key, wired `createExternalTeam` into the VS Code host with the same fleet-root/inline-rendering/pty-mirror seams the terminal-headed path uses, deduped the template table behind one `resolveExternalTeamTemplate`, guarded `writeHeadPromptFile` against scaffolding `.switchboard`, replaced the dead `workspaceRoot` option with a `regenerateHeadPrompt` seam fired after group registration, registered the skill in `MIRROR_MANIFEST` plus the AGENTS.md/CLAUDE.md registry, and corrected the nonexistent `GET /kanban/feature` in both the generated head prompt and the skill. Test coverage was extended with the missing override-skipped assertion, the plan's unwritten item-7 test, and two new regression guards (stale-snapshot terminal lead, role-miss refusal), then wired into `package.json` and CI. All named verification suites plus the catalog gate pass; no issues left open beyond the two noted risks above.
