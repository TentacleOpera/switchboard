# Team Queue: Completion-Driven Dispatch (Replaces the Pump)

## Goal
Make the team work queue's auto-advance 100% reliable by driving dispatch off the coder's explicit completion report — the signal the system already treats as truth — instead of a polling pump that guesses at idle state. The coder says "I'm done"; the system clears the terminal and dispatches the next queued item. Delete the pump-oriented infrastructure that was built for the wrong model.

> **Superseded:** Driving dispatch off the plan-file mtime advance.
> **Reason:** The user explicitly and repeatedly rejected mtime as the trigger. Mtime advance is inferred by a periodic silence sweep (a 10-second poll in `PlanIngestionEngine`), not reported by the coder. The user's intent is "the team lead reports completion and the system acts on that, not on guesses." The mtime sweep IS a guess — it stats a file and compares timestamps. The explicit completion POST is the report.
> **Replaced with:** A standing order that tells the coder to POST a completion endpoint on task finish. The system handler clears the terminal, reads the file-based team queue, dequeues the next item, and dispatches it. The completion report is the trigger — explicit, not inferred.

## The problem, and the root cause
The work queue plan (`team-work-queue.md`) specified an auto-dispatch "pump": a loop that polls for idle terminals, claims the next item, delivers it, and waits for completion. This model is wrong for three reasons:

1. **Idle is a guess.** The pump checks `dispatchInFlight` and "unacknowledged in-progress markers" to decide if a terminal is idle. A terminal that is thinking, reading, or between tool calls looks idle. Interrupting it pastes a second prompt into an agent mid-task.
2. **Completion is not turn-end.** A `turn-end` event fires when an agent finishes its turn — but a turn can end mid-plan (context limit, stuck, waiting for input). The pump conflates "turn ended" with "plan done." They are not the same thing.
3. **The queue is decorative if dispatches bypass it.** In the feature session that just completed, every subtask was dispatched via `ptySendPrompt` with a `planId` in the dispatch field. None went through the queue. The queue held nothing. A system handler that checks the queue on completion would find it empty and do nothing — while the team lead sits idle with work pending.

The reliable completion signal is the one the user asked for: **the coder's explicit completion report**. Today, coders report to the team lead via `ptySendPrompt` (installed by standing orders). That callback already exists. The missing piece is not a pump that polls, not an mtime watcher that infers, and not an AI agent that remembers — it is a system-level handler that acts on the explicit completion report: clear the terminal, check the file-based team queue, dispatch the next item. Code, not cognition. 100% reliable.

The kanban DISPATCH column already has this exact pattern: `SEAT_QUEUE_DONE_ORDER_BODY` (teamWiring.ts:154) tells every seat to `POST /kanban/queue/done` on completion; `_runQueueDone` (LocalApiServer.ts:2022) handles the release → clear → pop cycle, serialized on `_queueNextChain`. This plan applies the same pattern to the file-based team queue (`.switchboard/teams/<groupId>/queue/`, `TeamQueueService.ts`).

## Metadata
- **Tags:** backend, frontend, api, feature, reliability, refactor
- **Complexity:** 6

## User Review Required
No — the plan's logic has been confirmed with the user. The endpoint relays completion reports to the lead (the lead stays in the loop), the queue dispatches to the lead (the lead delegates to members), and the feature-completion check is a standing-order amendment the coder performs before posting. The cleanup work (delete claim/staleness, rewire manual send) is mechanical.

## Complexity Audit

### Routine
- Deleting the claim/staleness mechanism from `TeamQueueService.ts` (`claimItem`, `releaseClaim`, `readClaim`, `CLAIM_STALENESS_HOURS`, `QueueClaimResult`, `claimed/` directory) — mechanical deletion of functions no longer called after the `sendNextQueueItem` rewire and the new `queue/done` endpoint.
- Deleting the `/claim` endpoint branch in `LocalApiServer._handleTeamQueueRoute` — one `if` block + the `claimItem` import.
- Rewiring `sendNextQueueItem` (terminals.js) to drop the claim call — dispatch first pending item, delete on success.
- Removing `state`/`claimedBy`/`claimedTs` claim fields from `QueueItem` and `parseQueueItem`.

### Complex / Risky
- The new `POST /terminals/teams/<groupId>/queue/done` endpoint and its handler: clear terminal → read queue → dispatch next → delete on success. Must serialize concurrent completion reports (two coders finishing simultaneously). Mirrors the kanban `_runQueueDone` / `_queueNextChain` pattern but operates on the file-based queue, not the kanban column.
- The team-scoped standing order that replaces "report to head" for teams in auto mode. Must be installed/uninstalled when the auto/manual toggle changes. The groupId is baked into the order text at install time. Mirrors `SEAT_QUEUE_DONE_ORDER_BODY` / `applySeatPacingOrders` in teamWiring.ts.
- Rewiring the auto/manual toggle from "pump on/off" (dead) to "completion-driven standing order installed/uninstalled" (live). The toggle's UI element stays; its behaviour changes completely.
- The feature-completion check in the standing order text: the coder calls `GET /kanban/plans?featureId=<featureId>` and, if all subtasks are in `LEAD CODED`, posts to `POST /kanban/dispatch` with the feature plan ID and `targetColumn: "CODE REVIEWED"` (the existing feature-completion path from agentGroupInstantiation.ts:273). This is standing order text, not system code.

## Edge-Case & Dependency Audit

- **Race Conditions:** Two coders on the same team finish simultaneously and both POST `queue/done`. The handler must serialize — both completions are processed sequentially on a promise chain (mirroring `_queueNextChain`). The first completion dispatches the next queue item; the second completion finds the queue empty (or dispatches the item after that). No double-dispatch.
- **Security:** The new `queue/done` endpoint is under `/terminals/teams/<groupId>/queue/done`. The `groupId` is already validated by `isSafeId` in the existing `_handleTeamQueueRoute` parser. No new traversal surface. The `from` field (terminal name) is used to clear the terminal — it must be validated against the team's roster before clearing, so a coder cannot clear another team's terminal.
- **Side Effects:** Auto mode installs a standing order that changes the completion delivery path: instead of the coder sending a message directly to the lead's terminal, the coder POSTs to the endpoint, which relays the report to the lead and then acts (clear + dispatch). The lead still receives the completion report — the endpoint is a relay, not a replacement. The relay makes the completion report interceptable by other consumers (orchestrator, future mobile monitoring). If the system handler fails after the relay (dispatch step errors), the lead has already seen the completion and can act manually. If the POST itself fails (endpoint down), the standing order tells the coder to fall back to reporting to the head directly via ptySendPrompt.
- **Dependencies & Conflicts:** Depends on team identity foundation (resolve terminal → team → groupId, already landed). Depends on the file-based team queue storage (`TeamQueueService.ts`, already landed). Depends on the standing orders system (`mutateStandingOrders`, `applyStandingOrders`, already landed). Does NOT depend on the plan-file mtime watcher or the silence sweep. Does NOT conflict with the kanban DISPATCH column's `queue/done` system — this is a separate queue surface with a separate endpoint path.

## Dependencies
- Team identity foundation (landed) — resolving a terminal to its team via `terminals.groups` (`isSpawnedTeamGroup`, `teamHeadName`).
- Team work queue storage (landed) — `TeamQueueService.ts` enqueue/list/delete/reorder.
- Standing orders system (landed) — `mutateStandingOrders`, `applyStandingOrders`, team-scoped orders.
- `ptySendPrompt` dispatch path (exists) — the system handler dispatches the next item through the same path a hand-dispatched prompt uses.
- `ptyClearTerminal` (exists) — the system handler clears the finishing terminal.
- Feature completion path (exists) — `POST /kanban/dispatch` with `targetColumn: "CODE REVIEWED"` and the feature plan ID (agentGroupInstantiation.ts:273).

## Adversarial Synthesis
Key risks: (1) if the system handler fails after the coder POSTs, the completion report is lost and the queue stalls; mitigated by the endpoint relaying the report to the lead before acting, so the lead always sees the completion even if the dispatch step fails, plus a fallback in the standing order text ("if the POST fails, report to your head directly"); (2) concurrent completion reports must serialize to prevent double-dispatch; mitigated by a promise chain mirroring `_queueNextChain`; (3) the `from` terminal name must be validated against the team roster before clearing, so a coder cannot clear another team's terminal; (4) the auto/manual toggle rewire changes the toggle's meaning — an operator who previously toggled to "auto" and saw nothing happen will now see completion-driven dispatch activate. Mitigations: relay-then-act ordering, serialize the handler, validate `from` against roster, document the toggle's new behaviour in the UI tooltip.

## Proposed Changes

### `src/services/LocalApiServer.ts` — new `queue/done` endpoint + handler
**Context:** The kanban DISPATCH column has `POST /kanban/queue/done` (line 1917) handled by `_runQueueDone` (line 2022), serialized on `_queueNextChain` (line 46). The file-based team queue has no equivalent — the `/claim` endpoint (line 3842) is the pump's claim mechanism, not a completion signal. This plan adds the file-based queue's completion endpoint.

**Logic:**
1. Add `POST /terminals/teams/<groupId>/queue/done` to `_handleTeamQueueRoute`. Parse: `parts[3] === 'done'` (the existing parser handles `parts[0]=groupId, parts[1]='queue', parts[2]=itemId, parts[3]=action`; add `'done'` as a valid action alongside `'claim'`).
2. Body: `{from: "<terminal name>", planId?: "<plan id>"}`. The `from` field is the reporting terminal's name. The `planId` is optional — used for the feature-completion check.
3. Handler (serialized on a promise chain — either `_queueNextChain` or a new `_teamQueueDoneChain`):
   a. Validate `from` against the team's roster (using `resolveTeamMembers` callback, same as the kanban path). If `from` is not a member of this team, return 400.
   b. **Relay the completion report to the lead.** Send the coder's completion message to the team head via `ptySendPrompt` (same delivery path the standing-order "report to head" used, `clearBeforePrompt: false`, `standingOrders: false` — a machine-origin relay, not a dispatched task). This happens BEFORE the clear-and-dispatch steps, so the lead always sees the report even if the dispatch step fails. The relay also makes the completion report interceptable by other consumers (orchestrator, future mobile monitoring) — they can hook into the endpoint or the relay path.
   c. Clear the finishing terminal via `clearTerminalContext` callback (same callback the kanban `_runQueueDone` uses, line 2106-2115).
   d. Read the file-based queue via `listQueue(workspaceRoot, groupId)`.
   e. If items exist: take the first pending item, dispatch its body via `ptySendPrompt` to the team head (resolved via `teamHeadName(group)`). The queue dispatches to the lead; the lead delegates to members. Individual plan-file routing to specific seats is the kanban DISPATCH column's system (`dispatchNextFromQueue` with seat pacing), already landed — this queue does not duplicate it. On successful dispatch, delete the item from the queue via `deleteItem`. If dispatch fails, leave the item queued.
   f. If no items: return `{success: true, dispatched: null, reason: "queue empty"}` — the coder knows the team is done with queued work.
   g. Return `{success: true, dispatched: {planId, terminal}}` on successful dispatch.
4. Delete the `/claim` endpoint branch (lines 3842–3858) — no longer needed.
5. Remove `claimItem` and `releaseClaim` from the import on line 37.

**Implementation:** The handler mirrors `_runQueueDone`'s structure: serialize on a chain → validate → relay to lead → clear → pop → dispatch. The difference is the queue source: `_runQueueDone` reads the kanban `DISPATCH` column from the DB; this handler reads `.switchboard/teams/<groupId>/queue/` via `listQueue`. The dispatch target is always the team head (resolved via `teamHeadName(group)`) — the queue dispatches to the lead, the lead delegates to members. Individual plan-file routing to specific seats is the kanban DISPATCH column's job, not this queue's.

**Edge Cases:** `from` not in roster → 400. Queue directory doesn't exist → return `{dispatched: null, reason: "queue empty"}` (no queue = no queued work). `ptySendPrompt` fails → item stays queued, return error. Two simultaneous POSTs → serialized on the chain, second POST sees the queue after the first already popped.

### `src/services/teamWiring.ts` — new team-scoped standing order for auto mode
**Context:** `SEAT_QUEUE_DONE_ORDER_BODY` (line 154) is the standing order for the kanban DISPATCH column's seat-paced mode. `applySeatPacingOrders` (line 187) installs/removes it per team. This plan adds an equivalent for the file-based team queue.

**Logic:**
1. Add a new constant `TEAM_QUEUE_DONE_ORDER_BODY(groupId)` — a function that returns the standing order text with the groupId baked in:
   ```
   When you finish the task you were dispatched, POST /terminals/teams/<groupId>/queue/done
   with {"from":"<your terminal name>"} against the port in .switchboard/api-server-port.txt.
   The system will relay your completion report to your team lead, clear your terminal,
   and dispatch the next queued item to the lead.
   If there are no more items, your terminal stays cleared and the team is done with queued work.
   If the POST fails, report to your head directly via ptySendPrompt as a fallback.
   Before posting, check GET /kanban/plans?featureId=<your feature id> — if all subtasks
   are in LEAD CODED, POST /kanban/dispatch with {"plan":"<featurePlanId>","targetColumn":"CODE REVIEWED","from":"<your terminal name>"}
   instead of posting to queue/done. The feature is complete — hand it to review.
   ```
2. Add `applyTeamQueueOrders(opts: {db, groupId, headName, roster, enabled: boolean})` — mirrors `applySeatPacingOrders`. When `enabled` (auto mode on): install the `TEAM_QUEUE_DONE_ORDER_BODY` order at `team` and `team-head` scope. When `enabled` is false (auto mode off / manual): remove any previously-installed order for this team. Idempotent. Serialized through `mutateStandingOrders`.
3. Use a deterministic id prefix `team-queue-done:<groupId>:` so the order can be found and removed without scanning instruction text (same pattern as `SEAT_QUEUE_ORDER_ID_PREFIX`).

**Implementation:** The order is team-scoped — it applies to every seat on the team (head + members). The `parent` field is set to the head name so `selectOrders`' head-exclusion resolves correctly (same as `applySeatPacingOrders`). The groupId is baked into the text at install time — the coder does not need to discover its team; the order tells it the endpoint directly.

**Edge Cases:** Installing the order before the `queue/done` endpoint exists leaves coders calling a 404 — the fallback ("if the POST fails, report to your head") degrades gracefully. Removing the order when switching to manual mode must be immediate so a stale order never reaches a live agent (the known failure mode `a-stale-standing-order-can-still-reach-a-live-agent.md` exists to prevent).

### `src/webview/terminals.js` — rewire auto/manual toggle, rewire manual send
**Context:** The auto/manual toggle (lines 3721–3745) currently does nothing — the pump was never built. `sendNextQueueItem` (lines 3878–3917) is the sole live caller of the `/claim` endpoint. The toggle's `saveQueueMode`/`loadQueueMode` (lines 3920–3952) persists the mode in namespaced settings.

**Logic:**
1. **Keep the toggle UI** (the `modeToggle`/`manualBtn`/`autoBtn` elements). Rewire its behaviour:
   - Clicking "Auto": call a new API endpoint (or reuse `saveSetting`) to install the team-scoped standing order via `applyTeamQueueOrders`. The toggle now controls whether the completion-driven standing order is installed, not whether a pump runs.
   - Clicking "Manual": call the API to remove the standing order via `applyTeamQueueOrders`.
   - Update the `autoBtn.title` tooltip: "Auto mode: when a coder finishes a task, the system clears the terminal and dispatches the next queued item automatically. Manual mode: you click Send Next Now for each item."
2. **Rewire `sendNextQueueItem`** (lines 3878–3917): remove the `fetch(.../claim)` call (lines 3883–3895). New flow: take the first pending item (`_queueItems[0]` after the `state` field collapse), dispatch its body via `POST /terminals/verb/ptySendPrompt` to the team head, and on a successful `ptySendPrompt` response, delete the item from the file-based queue via `DELETE /terminals/teams/<groupId>/queue/<id>`. If the `ptySendPrompt` fetch fails, do NOT delete — the item stays queued for retry.
3. **Add a synchronous button-disable on click**: set `sendBtn.disabled = true` inside the click handler BEFORE the first `await`, so a double-click cannot double-dispatch. Re-render restores the correct disabled state from `_queueItems.length`.
4. **Delete `saveQueueMode`/`loadQueueMode`** (lines 3920–3952) — the mode is no longer a persisted UI state; it is a standing-order install/remove action. The toggle's state is derived from whether the standing order is installed (query the standing orders API on team-scoped init).

**Implementation:** The toggle's click handler calls a new API endpoint to install/remove the standing order. The endpoint is `POST /terminals/teams/<groupId>/queue/mode` with body `{mode: "auto" | "manual"}`, handled in LocalApiServer — it calls `applyTeamQueueOrders` with `enabled: mode === "auto"`. The toggle's initial state on team-scoped init is determined by querying whether the standing order exists (or by reading the persisted setting as a hint, then confirming against the actual order state).

**Edge Cases:** Toggle to auto before any items are queued → the standing order is installed; when items are queued and a coder completes, the system dispatches the next one. Toggle to manual mid-run → the standing order is removed; the coder's next completion reports to the head as usual; queued items wait for manual "Send Next Now." Empty queue → `sendNextQueueItem` returns early (existing guard, line 3879). `ptySendPrompt` fails → do not delete the item; re-fetch and re-render.

### `src/services/TeamQueueService.ts` — delete claim/staleness mechanism
**Context:** The `claimItem`/`releaseClaim`/`readClaim` functions and the `claimed/` subdirectory were designed for the pump's poll-claim-dispatch model. In the completion-driven model there is no claim race — the system dispatches the next item only after the coder's explicit completion report, and the manual button is single-operator.

**Logic:**
1. Delete `claimItem` (lines 296–341), `releaseClaim` (lines 449–465), `readClaim` (lines 160–177), `CLAIM_STALENESS_HOURS` (line 39), and `QueueClaimResult` (lines 69–73).
2. Remove the `claimed/` subdirectory creation from `bootstrapTeamQueue` (lines 114–115): delete `const claimedDir` and the `mkdir` for it. Keep the `queueDir` creation.
3. Remove claim-related fields from `QueueItem` (lines 52–54): delete `state`, `claimedBy`, `claimedTs`. The `state: 'pending' | 'claimed'` union collapses — remove the field entirely and update consumers (the UI render's `state-${item.state}` CSS class and `sendNextQueueItem`'s `i.state === 'pending'` filter).
4. Update `parseQueueItem` (lines 124–158): remove the `claimed`/`claimData` parameters and the `state`/`claimedBy`/`claimedTs` assignments.
5. Update `listQueue` (lines 185–220): remove the `claimedDir` construction (line 191), the `readClaim` call (line 205), and the claim data passed to `parseQueueItem` (line 206). The `claimed/` subdirectory is not a `.md` file so the existing `.md` filter (line 193) already excludes it — no change needed to the filter.
6. Update `deleteItem` (lines 349–372): remove the `claimPath` construction and `unlink` (lines 365–367) — no claim sidecar to clean up.

**Implementation:** Keep `bootstrapTeamQueue`, `enqueueItem`, `listQueue`, `deleteItem`, `reorderQueue`, `isSafeId`, `MAX_QUEUE_ITEM_BODY` — these are storage and are correct regardless of dispatch model.

**Edge Cases:** Existing `claimed/` directories on disk become orphaned. They are not read after `readClaim` is deleted. A one-time `fs.rm` of `claimed/` inside `bootstrapTeamQueue` is optional (best-effort, ignore errors) but not required — the directory is inert.

## Verification Plan

> **Note:** Compilation and automated tests are NOT run in this improve pass (session directive). The checks below remain the plan's verification contract for the implementing coder.

### Automated Tests
1. `npm run compile` — clean (no dangling imports of `claimItem`/`releaseClaim`/`CLAIM_STALENESS_HOURS`/`QueueClaimResult`).
2. Unit: `POST /terminals/teams/<groupId>/queue/done` with a non-empty queue → relays the completion report to the lead via `ptySendPrompt`, clears the `from` terminal, dispatches the first pending item to the lead, deletes it from the queue on successful dispatch.
3. Unit: `queue/done` with an empty queue → returns `{dispatched: null, reason: "queue empty"}`, terminal is cleared, no dispatch.
4. Unit: `queue/done` with `from` not in the team roster → 400.
5. Unit: `queue/done` with a failed `ptySendPrompt` → item stays queued, error returned.
6. Unit: two concurrent `queue/done` POSTs on the same team → serialized on the chain, no double-dispatch.
7. Unit: `applyTeamQueueOrders` with `enabled: true` → standing order installed at `team` and `team-head` scope with the groupId baked in. `enabled: false` → order removed.
8. Unit: `listQueue` returns all items as `pending` with no `claimed/` directory interaction; a `claimed/` directory on disk is not enumerated as an item.
9. Unit: `sendNextQueueItem` rewire — dispatching the first pending item calls `ptySendPrompt` then `DELETE` on the item; a failed `ptySendPrompt` does NOT delete the item.
10. Regression: `queue-pipeline-contract.test.js` — the existing kanban `dispatchNextFromQueue` / `queue/done` contract tests pass unchanged (this plan does not touch the kanban DISPATCH queue path).
11. Regression: `claimInboxItemIn` / orchestrator reports inbox tests pass unchanged (ScheduledJobsService is untouched).
12. Manual: queue three plans to a team, toggle to auto, dispatch the first manually. On the coder's completion POST, the system clears the terminal and dispatches the second. On the second's completion, the third dispatches. No AI agent involvement.
13. Manual: complete the last queued item → terminal is cleared, response is `{dispatched: null, reason: "queue empty"}`, no further dispatch.
14. Manual: toggle to manual mid-run → the standing order is removed; the coder's next completion reports to the head; queued items wait for "Send Next Now."
15. Manual: complete all subtasks of a feature → coder checks `GET /kanban/plans?featureId=...`, sees all in LEAD CODED, posts to `POST /kanban/dispatch` with `targetColumn: "CODE REVIEWED"` instead of `queue/done`. Feature moves to review.
16. Manual: a feature with no queue → `queue/done` is never called (no standing order installed), existing dispatch flow is unchanged.

## Completion Report

Implemented the completion-driven dispatch model: the coder's explicit `POST /terminals/teams/<groupId>/queue/done` report now drives queue advance (relay-to-lead → clear terminal → dispatch next item), replacing the never-built polling pump. Added the `queue/done` and `queue/mode` endpoints in `LocalApiServer.ts` (serialized on a new `_teamQueueDoneChain`, mirroring the kanban `_runQueueDone`), the `TEAM_QUEUE_DONE_ORDER_BODY`/`applyTeamQueueOrders` standing-order machinery plus a `resolveTeamHeadForOrigin` helper in `teamWiring.ts` (wired as a new `resolveTeamHead` callback in `TaskViewerProvider.ts`), and rewired the webview toggle (`terminals.js`) to install/remove the standing order via `queue/mode` with state derived from the actual orders on init. Deleted the claim/staleness mechanism (`claimItem`/`releaseClaim`/`readClaim`/`CLAIM_STALENESS_HOURS`/`QueueClaimResult`, the `claimed/` directory, and the `state`/`claimedBy`/`claimedTs` fields) from `TeamQueueService.ts`, removed the `/claim` endpoint, and rewired `sendNextQueueItem` to dispatch-then-delete. No issues encountered; compilation and tests were skipped per session directive.

## Review Findings

Reviewed the full completion POST path and changed `src/services/LocalApiServer.ts`, `TeamQueueService.ts`, `teamWiring.ts`, `src/webview/terminals.js`, and `src/test/queue-pipeline-contract.test.js`. Fixed the cross-team URL/roster mismatch, changed serialization to per-team chains, removed the now-orphaned head resolver, surfaced delete failures, and made queue-mode UI derive from actual standing orders after every write. `compile-tests`, `compile`, `catalog:check`, lint, and the CI-wired queue pipeline contract all passed. Remaining risk is the unavoidable dispatch/delete crash window of a file queue without a transactional move primitive.
