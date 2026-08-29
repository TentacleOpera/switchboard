# Context-Aware Completion Reporting for Teams

> **DISPATCH is retired — no migration, no compat arm.** The `DISPATCH` display mode was
> replaced by a real `STAGING` column in commit `52404992`. At HEAD there are **zero**
> `'DISPATCH'` references in `src/` (`kanban.html` included), `DISPATCH` is not in
> `VALID_KANBAN_COLUMNS`, and no card is in it. The feature never shipped to users, so
> there is nothing to migrate and no legacy arm to carry: say `STAGING` throughout. The queue endpoints and the routing logic are unchanged —
> only the column name was wrong.

## Goal
Replace the unconditional "report to head" standing order with a single context-aware order that routes the completion report based on where the work came from. Today every task a team coder finishes triggers a `ptySendPrompt` to the head, regardless of whether the work was dispatched from the kanban STAGING column, the file-based team queue, or the head itself. This conflicts with both queue systems: the kanban `queue/done` and the file-based `queue/done` endpoints need the coder to POST to them, not to the head. The fix is one standing order that checks the dispatch source and routes accordingly.

## The problem, and the root cause
Three completion paths exist in the system, and they conflict:

1. **Default team callback** (`AGENT_GROUP_CALLBACK_INSTRUCTION`, teamWiring.ts:54): "When you finish a task, report to {child} via ptySendPrompt." Unconditional. Fires for every completion.

2. **Kanban STAGING column** (`SEAT_QUEUE_DONE_ORDER_BODY`, teamWiring.ts:154): "When you finish the card, POST /kanban/queue/done." Installed per team when seat pacing is on. Replaces the default callback.

3. **File-based team queue** (`TEAM_QUEUE_DONE_ORDER_BODY`, teamWiring.ts:258): "When you finish the task, POST /terminals/teams/<groupId>/queue/done." Installed per team when the file-based queue's auto mode is on. Replaces the default callback.

The conflict: orders 2 and 3 are installed per team, not per dispatch source. A team with seat pacing on gets order 2 for ALL completions, even work that came from the file-based queue. A team with the file-based queue's auto mode on gets order 3 for ALL completions, even work that came from the kanban STAGING column. A team with neither gets order 1 for everything, including kanban-dispatched work that should POST to `queue/done`.

The coder already has the information to disambiguate: its dispatch prompt carries `PLAN_ID=<planId>`, and `GET /kanban/plan?planId=<planId>` returns the card's `kanbanColumn`. If the plan is in a coding column (`LEAD CODED`, `CODER CODED`, `INTERN CODED`) and was dispatched from the STAGING column, the coder should POST to `/kanban/queue/done`. If the work came from the file-based team queue (no planId, or a planId not in the kanban), the coder should POST to `/terminals/teams/<groupId>/queue/done`. Otherwise, report to the head.

The fix: one team-scoped standing order that checks the dispatch source and routes the completion report to the right endpoint. No per-team install/remove toggling for seat pacing or file-based queue mode — the order is always installed, always context-aware.

## Metadata
- **Tags:** backend, refactor, reliability
- **Complexity:** 5

## User Review Required
No — the fix makes existing completion paths work correctly by routing based on dispatch source. No new product decisions.

## Complexity Audit

### Routine
- Writing the new `CONTEXT_AWARE_COMPLETION_ORDER_BODY(groupId, headName)` constant — text that tells the coder to check `GET /kanban/plan?planId=<planId>` and route based on the response.
- Installing the new order at `team` scope during `wireSpawnedTeam` (replacing the default callback instruction).
- Removing the per-team install/remove logic for `SEAT_QUEUE_DONE_ORDER_BODY` (seat pacing) and `TEAM_QUEUE_DONE_ORDER_BODY` (file-based queue auto mode) — the context-aware order replaces both.
- Removing the `applySeatPacingOrders` call from `wireSpawnedTeam` (teamWiring.ts:1830) and from `_propagatePacingToLiveGroups` (KanbanProvider.ts:4942).
- Removing the `applyTeamQueueOrders` call from `_handleTeamQueueMode` (LocalApiServer.ts:4165).
- Removing imports of deleted functions from KanbanProvider.ts:35 and LocalApiServer.ts:20.
- Updating `standing-orders-marker-contract.test.js` — the seat-paced test cases (lines 1234-1243) import `SEAT_QUEUE_DONE_ORDER_BODY` and test `applySeatPacingOrders` install/remove behavior. With the function deleted, these test cases must be rewritten to test the context-aware order's installation, or removed if covered by new tests.

### Complex / Risky
- The `GET /kanban/plan` check adds an HTTP call to the coder's completion flow. If the endpoint is down or the planId is absent (ad-hoc prompt, not a plan), the coder must fall back gracefully — report to the head. The order text must handle: planId present + endpoint reachable → check column; planId absent → report to head; endpoint down → report to head.
- The kanban column check: a plan in `LEAD CODED` / `CODER CODED` / `INTERN CODED` was dispatched from the STAGING column → POST to `/kanban/queue/done`. But a plan in those columns could also have been dispatched directly by the head (not through the queue). The `dispatchedAt` field distinguishes: if `dispatchedAt` is set AND the card came through `dispatchNextFromQueue`, it's a queue dispatch. But the coder can't easily tell the difference from the API response. Simpler: if the plan is in a coding column, POST to `/kanban/queue/done` — the endpoint's `_runQueueDone` handler already detects "no active card for `from`" and returns a 200 no-op (reason: "duplicate"), so a non-queue dispatch that POSTs to `queue/done` is harmless.
- Removing `applySeatPacingOrders` and `applyTeamQueueOrders` install/remove logic — the pacing toggle and the file-based queue auto/manual toggle no longer install/remove standing orders. The pacing toggle still controls in-flight check behaviour in `_runQueuePop` (head pacing: one-in-one-out; seat pacing: skip in-flight check). The file-based queue auto/manual toggle still controls whether the file-based `queue/done` endpoint dispatches the next item. But neither toggle touches standing orders anymore — the context-aware order is always installed.
- **External head preservation**: `wireSpawnedTeam` uses `EXTERNAL_HEAD_CALLBACK_INSTRUCTION` for external-headed teams (teamWiring.ts:1600-1602). The context-aware order's fallback (step 3) routes to `ptySendPrompt`, which is a dead click for external heads (non-terminal agents). The test at `external-headed-team-contract.test.js:370` explicitly asserts that external head callbacks must NOT route through `ptySendPrompt`. The fix must preserve the `EXTERNAL_HEAD_CALLBACK_INSTRUCTION` branch — only terminal-headed teams get the context-aware order.
- **`team-head` scope installation**: The context-aware order must be installed at `team-head` scope (for non-external heads) so the head seat also routes its completions contextually. Currently, `wireSpawnedTeam` only installs the callback at `team` scope (line 1662). The `team-head` scope installation was done by `applySeatPacingOrders`/`applyTeamQueueOrders`, which are being deleted. A new explicit `team-head` scope installation must be added to `wireSpawnedTeam`, with a deterministic id prefix (e.g. `context-aware-completion:<groupId>:team-head`) to avoid conflicting with the head prompt order's `(scope, teamId)` existence check at line 1692-1693. The context-aware order at `team-head` scope must be installed AFTER the head prompt check, or in a separate `mutateStandingOrders` call, so the head prompt's existence check doesn't find the context-aware order and skip the head prompt.
- **Webview toggle state derivation**: `loadQueueModeFromOrders()` (terminals.js:3945-3955) derives the auto/manual toggle state by scanning for `team-queue-done:<groupId>:` prefixed orders. Removing those orders breaks this derivation — the toggle will always show 'manual'. A new `queueMode` field must be stored on the group config in `terminals.groups` (following the same pattern as the `pacing` field), and the webview must read it from the group config instead of scanning standing orders.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The standing order is text read by the coder at completion time. The HTTP check to `GET /kanban/plan` is a read; the POST to `queue/done` is serialized on `_queueNextChain` (kanban) or `_teamQueueDoneChain` (file-based). No new race surface.
- **Security:** No new endpoints. The coder calls existing `GET /kanban/plan` and `POST /kanban/queue/done` / `POST /terminals/teams/<groupId>/queue/done` endpoints. Auth unchanged.
- **Side Effects:** Removing `applySeatPacingOrders` means the seat-paced standing order is no longer installed/removed when the pacing toggle changes. The context-aware order replaces it — it tells the coder to POST to `/kanban/queue/done` when the plan is in a coding column, which is what the seat-paced order said. The pacing toggle's in-flight check behaviour in `_runQueuePop` is unchanged. Removing `applyTeamQueueOrders` means the file-based queue's standing order is no longer installed/removed when the auto/manual toggle changes. The context-aware order replaces it — it tells the coder to POST to `/terminals/teams/<groupId>/queue/done` when the work came from the file-based queue. The auto/manual toggle's dispatch behaviour (dispatch next item on completion) is unchanged. The `queue/mode` endpoint (`_handleTeamQueueMode`, LocalApiServer.ts:4130) must be updated to write a `queueMode` field to the group config instead of calling `applyTeamQueueOrders`. The webview's `loadQueueModeFromOrders()` must be updated to read the `queueMode` field from the group config instead of scanning for prefixed orders.
- **Dependencies & Conflicts:** Depends on `GET /kanban/plan` endpoint (exists, LocalApiServer.ts:4789, `_handleGetPlan`). Depends on `POST /kanban/queue/done` (exists, LocalApiServer.ts:1985). Depends on `POST /terminals/teams/<groupId>/queue/done` (exists, LocalApiServer.ts:3895-3900, handler `_handleTeamQueueDone` at line 3961). Depends on `GET /kanban/plans?featureId=` (exists, LocalApiServer.ts:4642, `_handleGetPlans`). Does NOT conflict with the kanban queue-without-team plan (`kanban-queue-dispatch-without-team.md`) — that plan adds a workspace-scoped order for non-team agents; this plan replaces the team-scoped orders with one context-aware order. The two coexist: team agents get the context-aware team-scoped order; standalone agents get the workspace-scoped order.

## Dependencies
- `GET /kanban/plan?planId=<planId>` (exists, LocalApiServer.ts:4789, `_handleGetPlan`) — returns the plan record including `kanbanColumn`. Verified: `db.getPlanByPlanId(planId)` returns the record, spread with `content` at line 4805; `kanbanColumn` is a field on plan records (used at line 4827).
- `POST /kanban/queue/done` (exists, LocalApiServer.ts:1985, `_handleKanbanQueueDone`) — kanban STAGING column completion endpoint. The `_runQueueDone` handler (line 2050) returns a 200 no-op with `reason: "duplicate"` when there is no active card for `from` (line 2087-2090), so a non-queue dispatch that POSTs to `queue/done` is harmless.
- `POST /terminals/teams/<groupId>/queue/done` (exists, LocalApiServer.ts:3895-3900, handler `_handleTeamQueueDone` at line 3961) — file-based team queue completion endpoint. Already implemented and live.
- `GET /kanban/plans?featureId=<featureId>` (exists, LocalApiServer.ts:4642, `_handleGetPlans`) — returns subtasks for a feature. Used by the feature-completion check in the order text.
- `wireSpawnedTeam` (teamWiring.ts:1564) — where the team-scoped standing order is installed. Already installs the default callback at `team` scope (line 1662); this plan changes the text and adds a `team-head` scope installation.
- `applySeatPacingOrders` (teamWiring.ts:187) — to be deleted. Called at teamWiring.ts:1830 (inside `wireSpawnedTeam`) and KanbanProvider.ts:4942 (`_propagatePacingToLiveGroups`). Both call sites must be removed.
- `applyTeamQueueOrders` (teamWiring.ts:298) — to be deleted. Called at LocalApiServer.ts:4165 (`_handleTeamQueueMode`). Call site must be removed.
- `TEAM_QUEUE_ORDER_ID_PREFIX_EXPORT` (teamWiring.ts:355) — exported alias for `TEAM_QUEUE_ORDER_ID_PREFIX`. Not used outside teamWiring.ts. To be deleted with the prefix.
- `loadQueueModeFromOrders()` (terminals.js:3945) — webview function that derives auto/manual toggle state from `team-queue-done:` prefixed order presence. Must be replaced with reading a `queueMode` field from the group config.
- `standing-orders-marker-contract.test.js` (src/test/) — imports `SEAT_QUEUE_DONE_ORDER_BODY` at line 1014 and asserts on its exact text at lines 1236, 1242. Must be updated when the constant is deleted.
- `external-headed-team-contract.test.js` (src/test/) — asserts at line 370 that external head callbacks must NOT route through `ptySendPrompt`. The context-aware order must not be installed for external-headed teams.

## Adversarial Synthesis
Key risks: (1) the `GET /kanban/plan` HTTP call adds latency and a failure mode to the completion flow — mitigated by a graceful fallback (endpoint down or planId absent → report to head); (2) a plan in a coding column that was NOT dispatched from the queue will POST to `/kanban/queue/done` — mitigated by `_runQueueDone`'s existing "no active card for `from`" 200 no-op (harmless); (3) removing `applySeatPacingOrders` / `applyTeamQueueOrders` could break code that calls them — must audit all call sites and remove the callers (teamWiring.ts:1830, KanbanProvider.ts:4942, LocalApiServer.ts:4165) and their imports (KanbanProvider.ts:35, LocalApiServer.ts:20); (4) external-headed teams would break if the context-aware order's `ptySendPrompt` fallback replaced `EXTERNAL_HEAD_CALLBACK_INSTRUCTION` — mitigated by preserving the external head branch; (5) the webview's auto/manual toggle state derivation breaks when prefixed orders are removed — mitigated by adding a `queueMode` field to the group config; (6) the head seat loses context-aware routing if the `team-head` scope installation is not added — mitigated by explicit `team-head` scope installation with a deterministic id. Mitigations: graceful fallback, harmless no-op, full call-site audit, external head branch preservation, `queueMode` config field, `team-head` scope installation.

## Proposed Changes

### `src/services/teamWiring.ts` — new context-aware completion order
**Context:** Three standing order bodies exist today: `AGENT_GROUP_CALLBACK_INSTRUCTION` (default "report to head"), `SEAT_QUEUE_DONE_ORDER_BODY` (kanban "POST /kanban/queue/done"), and `TEAM_QUEUE_DONE_ORDER_BODY` (file-based "POST /terminals/teams/<groupId>/queue/done"). They conflict because they're installed per team, not per dispatch source.

**Logic:**
1. Add a new function `CONTEXT_AWARE_COMPLETION_ORDER_BODY(groupId: string, headName: string): string` that returns:
   ```
   When you finish a task, route your completion report based on where the work came from:

   1. If you have a PLAN_ID from your dispatch, call GET /kanban/plan?planId=<your planId>
      against the port in .switchboard/api-server-port.txt.
      - If the response shows kanbanColumn is "LEAD CODED", "CODER CODED", or "INTERN CODED",
        POST /kanban/queue/done with {"from":"<your terminal name>"}.
        The system will clear your terminal and dispatch the next staged card.
        A response of {"dispatched":null,"reason":"queue empty"} means the run is over — say so and stop.
        If you cannot complete it, POST /kanban/queue/done with
        {"from":"<your terminal name>","outcome":"failed"} and a one-line reason.
      - If the response shows any other column, report to your head (step 3).

   2. If you do not have a PLAN_ID (ad-hoc prompt, file-based queue item),
      POST /terminals/teams/<groupId>/queue/done with {"from":"<your terminal name>"}.
      The system will relay your report to your team lead, clear your terminal,
      and dispatch the next queued item.
      If the POST fails, report to your head directly (step 3).

   3. Fallback: report to your head <headName> via POST /terminals/verb/ptySendPrompt with
      {"name":"<headName>","data":"<your report>","clearBeforePrompt":false} — naming what
      you changed and what to review. Do not wait to be asked.

   Before reporting, if you have a featureId, check GET /kanban/plans?featureId=<your feature id> —
   if all subtasks are in LEAD CODED, POST /kanban/dispatch with
   {"plan":"<featurePlanId>","targetColumn":"CODE REVIEWED","from":"<your terminal name>"}
   instead of any of the above. The feature is complete — hand it to review.
   ```
2. In `wireSpawnedTeam`, replace the `callbackTemplate` (line 1600-1602) with a conditional that preserves the external head branch:
   ```typescript
   const callbackTemplate = opts.externalHead
       ? EXTERNAL_HEAD_CALLBACK_INSTRUCTION.replace(/\{teamId\}/g, groupId)
       : CONTEXT_AWARE_COMPLETION_ORDER_BODY(groupId, headName);
   ```
   The `teamPromptInstruction` (line 1604-1606) continues to use `callbackTemplate` when no custom `prompt` is supplied, with `{child}` interpolated to `headName` and `GIT_SAFETY_DIRECTIVE` appended. For external heads, `EXTERNAL_HEAD_CALLBACK_INSTRUCTION` is preserved — the context-aware order's `ptySendPrompt` fallback is not installed for non-terminal heads.

   > **Superseded:** In `wireSpawnedTeam`, replace the `callbackTemplate` (line 1600-1606) with `CONTEXT_AWARE_COMPLETION_ORDER_BODY(groupId, headName)`. The team prompt is now the context-aware order, not the unconditional "report to head."
   > **Reason:** The original proposal replaced BOTH branches of the `callbackTemplate` ternary, including the `EXTERNAL_HEAD_CALLBACK_INSTRUCTION` branch for external-headed teams. The context-aware order's fallback (step 3) routes to `ptySendPrompt`, which is a dead click for external heads (non-terminal agents). The test at `external-headed-team-contract.test.js:370` explicitly asserts that external head callbacks must NOT route through `ptySendPrompt`. Replacing the external head branch would silently break external-headed teams and violate an existing guard-rail test.
   > **Replaced with:** Preserve the external head branch — only terminal-headed teams get the context-aware order. External-headed teams keep `EXTERNAL_HEAD_CALLBACK_INSTRUCTION`.

3. Add a `team-head` scope installation of the context-aware order for non-external heads. This replaces the `team-head` scope installation that was done by `applySeatPacingOrders`/`applyTeamQueueOrders`. Install it in a separate `mutateStandingOrders` call AFTER the main order installation (replacing the `applySeatPacingOrders` call at line 1830), so the head prompt's `(scope, teamId)` existence check at line 1692-1693 does not find the context-aware order and skip the head prompt. Use a deterministic id prefix `context-aware-completion:<groupId>:team-head` so the order can be found and managed without scanning instruction text.

   > **Superseded:** The order is installed once during `wireSpawnedTeam` at `team` scope (and `team-head` scope for the head seat). It persists for the team's lifetime. No install/remove on toggle changes. The `mutateStandingOrders` call in `wireSpawnedTeam` already handles idempotent install — the order text changes, but the key `(scope, teamId)` is unchanged.
   > **Reason:** The original implementation note claimed the `mutateStandingOrders` call in `wireSpawnedTeam` "already handles" `team-head` scope installation. It does not. `wireSpawnedTeam` installs the callback at `team` scope only (line 1662). The `team-head` scope installation was done by `applySeatPacingOrders`/`applyTeamQueueOrders` — the functions being deleted. Without an explicit `team-head` scope installation, the head seat gets no context-aware routing and falls back to nothing. Additionally, installing the context-aware order at `team-head` scope inside the main `mutateStandingOrders` call would conflict with the head prompt's `(scope, teamId)` existence check (line 1692-1693), causing the head prompt to be skipped.
   > **Replaced with:** A separate `mutateStandingOrders` call after the main order installation, installing the context-aware order at `team-head` scope with a deterministic id, for non-external heads only.

4. Delete `SEAT_QUEUE_DONE_ORDER_BODY` (line 154), `SEAT_QUEUE_ORDER_ID_PREFIX` (line 169), `applySeatPacingOrders` (line 187) — the context-aware order replaces the seat-paced order. The pacing toggle in `_runQueuePop` still controls in-flight check behaviour, but it no longer installs/removes a standing order.
5. Delete `TEAM_QUEUE_DONE_ORDER_BODY` (line 258), `TEAM_QUEUE_ORDER_ID_PREFIX` (line 277), `TEAM_QUEUE_ORDER_ID_PREFIX_EXPORT` (line 355), `applyTeamQueueOrders` (line 298) — the context-aware order replaces the file-based queue order. The auto/manual toggle still controls whether the file-based `queue/done` endpoint dispatches the next item, but it no longer installs/removes a standing order.

**Implementation:** The context-aware order is installed at `team` scope during the main `mutateStandingOrders` call in `wireSpawnedTeam` (replacing the callback at line 1662), and at `team-head` scope in a separate call after (replacing the `applySeatPacingOrders` call at line 1830). Both use deterministic ids (`context-aware-completion:<groupId>:team` and `context-aware-completion:<groupId>:team-head`) for idempotent install and future management. The `team-head` scope installation is skipped for external heads (`if (!opts.externalHead)`). No install/remove on toggle changes.

**Edge Cases:** Coder has no planId (ad-hoc prompt) → step 2 (file-based queue). Coder has a planId but `GET /kanban/plan` fails → step 3 (report to head). Coder has a planId, endpoint works, column is a coding column → step 1 (kanban queue/done). Coder has a planId, endpoint works, column is not a coding column (e.g. CODE REVIEWED, COMPLETED) → step 3 (report to head — the plan already moved past coding, the queue/done would no-op anyway). Feature completion check runs before all paths — if all subtasks are LEAD CODED, the coder hands the feature to review regardless of which queue dispatched it. External-headed teams keep `EXTERNAL_HEAD_CALLBACK_INSTRUCTION` — the context-aware order is not installed for them.

### Call site cleanup — remove `applySeatPacingOrders` / `applyTeamQueueOrders` callers
**Context:** Both functions are called from multiple sites. With the context-aware order replacing both, all callers must be removed.

**Logic:**
1. Remove the `applySeatPacingOrders` call inside `wireSpawnedTeam` (teamWiring.ts:1830-1836) — the try/catch block that calls `applySeatPacingOrders` with `pacing: readTeamPacing({ pacing: opts.pacing })`. This call is replaced by the `team-head` scope context-aware order installation described above.

   > **Superseded:** Find all call sites of `applySeatPacingOrders` — likely in the pacing toggle handler (KanbanProvider or TaskViewerProvider). Remove the call.
   > **Reason:** The original plan said "likely in the pacing toggle handler" but missed the call site inside `wireSpawnedTeam` itself at line 1830 — the same function the plan is editing. Deleting `applySeatPacingOrders` without removing this call causes a compilation failure.
   > **Replaced with:** Three call sites must be removed: (a) `wireSpawnedTeam` at teamWiring.ts:1830, (b) `_propagatePacingToLiveGroups` at KanbanProvider.ts:4942, and (c) the import at KanbanProvider.ts:35.

2. Remove the `applySeatPacingOrders` call in `_propagatePacingToLiveGroups` (KanbanProvider.ts:4937-4948) — the for-loop that calls `applySeatPacingOrders` for each matched live group. The `pacing` field write (lines 4928-4935) stays — the toggle still writes the `pacing` field on the team group (read by `_runQueuePop` for the in-flight check); it just no longer installs/removes a standing order.
3. Remove the `applyTeamQueueOrders` call in `_handleTeamQueueMode` (LocalApiServer.ts:4165-4171). Replace it with writing a `queueMode` field to the group config via `mutateTerminalGroups` — `queueMode: 'auto'` or `queueMode: 'manual'` (following the same pattern as the `pacing` field). The toggle still controls whether the file-based `queue/done` endpoint dispatches the next item; it just no longer installs/removes a standing order.
4. Remove the import of `applySeatPacingOrders` from KanbanProvider.ts:35 and `applyTeamQueueOrders` from LocalApiServer.ts:20.

**Implementation:** Audit with `grep` for all call sites before removing. The toggle handlers become one-line field writes (pacing field, queueMode field) with no standing-order side effects.

**Edge Cases:** A team that was previously seat-paced has the old `SEAT_QUEUE_DONE_ORDER_BODY` installed. After this change, the order is not removed by the toggle. The `wireSpawnedTeam` re-run on next team spawn installs the context-aware order with the same `(scope, teamId)` key — `mutateStandingOrders` replaces the old text with the new text (idempotent install with text update). For teams that don't re-spawn, a one-time migration can scan for `seat-queue-done:` prefixed orders and remove them, or they can be left to age out (the context-aware order coexists — the coder sees both, but the context-aware order's conditional logic takes precedence because it's more specific).

### Webview update — `loadQueueModeFromOrders` → `queueMode` field
**Context:** `loadQueueModeFromOrders()` (terminals.js:3945-3955) derives the auto/manual toggle state by scanning for `team-queue-done:<groupId>:` prefixed orders. With those orders removed, the function always defaults to 'manual'. A `queueMode` field on the group config replaces the derivation.

**Logic:**
1. In `_handleTeamQueueMode` (LocalApiServer.ts:4130), after parsing the mode, write `queueMode` to the group config via `mutateTerminalGroups` — `{ ...group, queueMode: mode }` where `mode` is `'auto'` or `'manual'`. This replaces the `applyTeamQueueOrders` call.
2. In `terminals.js`, replace `loadQueueModeFromOrders()` with reading the `queueMode` field from the group config (already loaded during team-scoped init). If the field is absent, default to `'manual'` (same as the current fallback).
3. Remove the `loadQueueModeFromOrders` function and its call site (terminals.js:3935).

**Implementation:** The `queueMode` field follows the same pattern as `pacing` — stored on the group object in `terminals.groups`, read by the webview during init, written by the toggle endpoint. No persisted UI hint that can drift.

**Edge Cases:** Existing teams without a `queueMode` field default to `'manual'` — same as the current behavior when no `team-queue-done:` order is installed. Teams that were previously in auto mode will show `'manual'` until the user toggles to `'auto'` once (which writes the field). This is a one-time UX hiccup, not a functional regression — the context-aware order routes correctly regardless of the toggle state.

### Test updates — `standing-orders-marker-contract.test.js`
**Context:** The test file imports `SEAT_QUEUE_DONE_ORDER_BODY` (line 1014) and asserts on its exact text at lines 1236 and 1242. Deleting the constant breaks the import and the assertions.

**Logic:**
1. Remove the import of `SEAT_QUEUE_DONE_ORDER_BODY` from line 1014.
2. Rewrite the seat-paced test cases (lines 1234-1243) to test the context-aware order's installation at `team` and `team-head` scope, or remove them if the behavior is covered by new tests. The test should verify that `wireSpawnedTeam` installs the context-aware order at both scopes with the correct `groupId` and `headName` baked in.
3. Add a test that external-headed teams still get `EXTERNAL_HEAD_CALLBACK_INSTRUCTION` (not the context-aware order) — guards against the regression identified in the architecture review.

**Implementation:** The test file uses `teamWiringModule.exports` to access the module. Update the import to reference `CONTEXT_AWARE_COMPLETION_ORDER_BODY` instead of `SEAT_QUEUE_DONE_ORDER_BODY`.

## Verification Plan

> **Note:** Compilation and automated tests are NOT run in this improve pass (session directive). The checks below remain the plan's verification contract for the implementing coder.

### Automated Tests
1. `npm run compile` — clean (no dangling imports of `applySeatPacingOrders` / `applyTeamQueueOrders` / `SEAT_QUEUE_DONE_ORDER_BODY` / `TEAM_QUEUE_DONE_ORDER_BODY` / `TEAM_QUEUE_ORDER_ID_PREFIX_EXPORT`).
2. Unit: `wireSpawnedTeam` installs the context-aware order at `team` scope with the groupId and headName baked in.
3. Unit: `wireSpawnedTeam` installs the context-aware order at `team-head` scope for non-external heads (deterministic id `context-aware-completion:<groupId>:team-head`).
4. Unit: `wireSpawnedTeam` does NOT install the context-aware order for external-headed teams — `EXTERNAL_HEAD_CALLBACK_INSTRUCTION` is preserved.
5. Unit: the pacing toggle handler (`_propagatePacingToLiveGroups`) writes the `pacing` field but does NOT call `applySeatPacingOrders`.
6. Unit: the auto/manual toggle handler (`_handleTeamQueueMode`) writes the `queueMode` field to the group config but does NOT call `applyTeamQueueOrders`.
7. Unit: the webview reads `queueMode` from the group config, not from standing-order presence.
8. Regression: `_runQueuePop` head-paced in-flight check still works (pacing field read, unchanged).
9. Regression: `_runQueuePop` seat-paced in-flight skip still works (pacing field read, unchanged).
10. Regression: `POST /kanban/queue/done` — existing kanban completion tests pass unchanged (the endpoint is untouched; only the standing order text that tells coders to call it changed).
11. Regression: `POST /terminals/teams/<groupId>/queue/done` — existing file-based queue completion tests pass unchanged.
12. Regression: `external-headed-team-contract.test.js` — external head callback still does NOT route through `ptySendPrompt` (line 370 assertion).
13. Manual: dispatch a plan from the kanban STAGING column to a team coder. Coder finishes, checks `GET /kanban/plan`, sees coding column, POSTs to `/kanban/queue/done`. System clears terminal, dispatches next card. Head does not receive a ptySendPrompt.
14. Manual: dispatch an ad-hoc prompt from the file-based team queue to the lead. Lead delegates to a coder. Coder finishes, has no planId, POSTs to `/terminals/teams/<groupId>/queue/done`. System relays to lead, clears terminal, dispatches next item.
15. Manual: dispatch a plan directly from the head (not through either queue). Coder finishes, checks `GET /kanban/plan`, sees the plan is not in a coding column (or the planId is not in the kanban), reports to head via ptySendPrompt. Head receives the report.
16. Manual: complete all subtasks of a feature. Coder checks `GET /kanban/plans?featureId=...`, sees all LEAD CODED, POSTs to `/kanban/dispatch` with `CODE REVIEWED`. Feature moves to review. Neither queue/done endpoint is called.
17. Manual: toggle pacing from head to seat mid-run. No standing order change. The in-flight check behaviour changes (head: one-in-one-out; seat: skip). Coder's next completion still routes correctly via the context-aware order.
18. Manual: toggle queue mode from manual to auto. The `queueMode` field is written to the group config. The webview reflects the toggle state. No standing order change. The file-based `queue/done` endpoint dispatches the next item on completion.
19. Manual: spawn an external-headed team. Workers get `EXTERNAL_HEAD_CALLBACK_INSTRUCTION` (file-based reports). The context-aware order is NOT installed. Workers write report files to `.switchboard/teams/<teamId>/reports/`.

## Review Findings

Reviewer pass. Fixed two material defects in `src/services/teamWiring.ts`: (1) the order body
ended with a paragraph telling any seat to `POST /kanban/dispatch` a feature to `CODE REVIEWED`
once "all subtasks are in LEAD CODED" — an inference the parent feature explicitly forbids and
which is factually wrong (a column advances when work *starts*), and the implementing commit had
deleted the three CI-gated assertions in `completion-asserted-never-inferred.test.js` and
`review-team-triage.test.js` that existed to forbid it; the paragraph is gone, replaced by an
explicit prohibition, and the guards are restored and widened. (2) The `team-head` install handed
the head the *member* body, whose step-3 fallback names the head as the recipient — the lead was
told to `ptySendPrompt` itself, and the order never named the lead's own `POST /kanban/task/complete`;
a new `CONTEXT_AWARE_HEAD_COMPLETION_ORDER_BODY(groupId)` is installed at that scope instead, and
`migrateCodingTeamOrders` now heals head rows carrying any member body rather than rewriting them
to a newer member body. Files changed: `src/services/teamWiring.ts`,
`src/test/completion-asserted-never-inferred.test.js`, `src/test/review-team-triage.test.js`,
`src/test/standing-orders-marker-contract.test.js`, `src/test/queue-pipeline-contract.test.js`,
`protocol-catalog.json` (regenerated — `catalog:check` was red at HEAD from unrelated line drift).
Validation: `tsc -p tsconfig.test.json` clean, `eslint src` 0 errors, `catalog:check` /
`parity:check` / `standalone-parity:check` / `host-seam-parity:check` all pass, and
completion-asserted-never-inferred, standing-orders-marker (65/0), review-team-triage,
team-release-control, task-complete, atomic-team-lifecycle, shell-terminal-strip,
link-presets-mirror and queue-done-relay are green; three pre-existing failures unrelated to this
plan remain (see Deferred Findings).

Goal verdict: **achieved.** The unconditional report-to-head callback is gone from
`wireSpawnedTeam`; `AGENT_GROUP_CALLBACK_INSTRUCTION` survives only on the delegate/link-preset
path, external heads keep `EXTERNAL_HEAD_CALLBACK_INSTRUCTION`, and `applySeatPacingOrders` /
`applyTeamQueueOrders` and their three call sites and two imports are deleted with no orphaned
references. One deviation from the plan text: the plan's step-1 order body specified the
feature-completion board-position paragraph; it is removed, because the parent feature file
("Neither subtask may infer completion from a column, an mtime, or silence") and two pre-existing
CI gates forbid it. Routing on `kanbanColumn` to pick an *endpoint* is kept — that is the plan's
actual mechanism and is not an inference about doneness.

## Deferred Findings

- NIT — the `team` scope install is guarded by `(scope, teamId)` existence, so a team wired by an earlier build keeps its old team-order text on re-spawn rather than being updated; `migrateCodingTeamOrders` heals the known stale bodies on read, which covers it. `src/services/teamWiring.ts:1508`
- NIT — stale `seat-queue-done:` / `team-queue-done:` standing orders from earlier dev builds are never removed now that their only remover is deleted; teams have never shipped, so this is dev-local litter, not an install-base migration. `src/services/teamWiring.ts:1790`
- NIT — the member order still claims `queue/done` will "clear your terminal", which is not true for a review team's seats (the old `REVIEW_TEAM_QUEUE_DONE_ORDER_BODY` omitted that fragment); the endpoint's behaviour is unchanged, only the description is now uniform. `src/services/teamWiring.ts:160`
- MAJOR (pre-existing, not this plan) — `queue-pipeline-contract.test.js` asserts `private async _scheduleQueuePop` exists in `LocalApiServer.ts`; the scheduling-consolidation commit removed it and left the gate red. `src/test/queue-pipeline-contract.test.js:838`
- MAJOR (pre-existing, not this plan) — `external-headed-team-contract.test.js` case 8 asserts the generated external head prompt names "your only card action is the POST /kanban/dispatch"; that phrase is no longer in `agentGroupInstantiation.ts`. `src/test/external-headed-team-contract.test.js:410`
- MAJOR (pre-existing, not this plan) — `stage-marker-commit-contract.test.js` has two red cases: `KanbanProvider.ts` now makes a raw `getConfigJson(STANDING_ORDERS_CONFIG_KEY)` read outside `loadEffectiveStandingOrders`, and the definitions library stamps `definitionId` onto rows the "nothing stale" case expects untouched. `src/test/stage-marker-commit-contract.test.js:507`
