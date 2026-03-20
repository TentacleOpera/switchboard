# live feed not registering autoban moves

## Notebook Plan

live feed log does not show autoban moves

## Goal
When the Autoban engine dispatches plans (moves cards between columns), the sidebar activity feed should log each move so the user has visibility into what autoban is doing. Currently, autoban dispatches happen silently — the kanban board updates but the activity/live feed panel shows nothing.

## Source Analysis

The Autoban engine lives in `TaskViewerProvider.ts`:
- **`_autobanTickColumn()`** (line ~1245): processes one tick per column, calls `handleKanbanBatchTrigger()` to dispatch cards.
- **`_enqueueAutobanTick()`** (line ~1202): serializes ticks through a promise queue.
- The engine logs to `console.log` at line ~1349: `[Autoban] ${sourceColumn}: dispatching ${sessionIds.length} card(s) to ${role}` — but this is **only** to the debug console, not the UI activity feed.

The sidebar activity feed is rendered in `implementation.html` via the `activity-list` element (line ~1449). Activity events are appended through `SessionActionLog.ts` which writes to `.switchboard/sessions/activity.jsonl`.

The `appendWorkflowAuditEvent()` function in `register-tools.js` (line ~457) writes to the same `activity.jsonl` file but is only called from MCP tool invocations, not from the autoban engine directly.

## Proposed Changes

### Step 1: Add activity log emission to autoban dispatch (Routine)
**File:** `src/services/TaskViewerProvider.ts`
**Location:** Inside `_autobanTickColumn()`, after successful `handleKanbanBatchTrigger()` calls (~line 1350 and ~lines 1334/1340 for complexity-routed dispatches).
- After each successful dispatch (`ok === true`), call `this._getSessionLog(workspaceRoot).logEvent('autoban_dispatch', { sourceColumn, targetRole: role, sessionIds, batchSize: sessionIds.length })` for each dispatched batch.
- This ensures events land in `activity.jsonl` and the sidebar picks them up on next poll.

### Step 2: Add UI rendering for autoban_dispatch events (Routine)
**File:** `src/webview/implementation.html`
**Location:** Activity list rendering function (search for `activity-list` and the function that appends activity items).
- Add a case for `type === 'autoban_dispatch'` that renders a descriptive line like: `⚡ Autoban: moved {count} plan(s) from {sourceColumn} → {role}`.

### Step 3: Ensure sidebar refreshes on new activity events (Routine)
**File:** `src/services/TaskViewerProvider.ts`
- Verify that the sidebar webview polls or watches `activity.jsonl` for new entries. If it only loads on panel open, add a `postMessage` to the sidebar webview after writing the autoban dispatch log entry.

## Dependencies
- None. This is an isolated observability improvement.
- No overlap with other plans in `.switchboard/plans/`.

## Verification Plan
1. Enable Autoban with at least one column rule active.
2. Wait for an autoban tick to fire (or reduce interval to 1 min for testing).
3. Confirm the sidebar activity feed shows "Autoban: moved X plan(s)..." entries.
4. Confirm `activity.jsonl` contains `autoban_dispatch` entries.
5. Run `npm run compile` to verify no type errors.

## Complexity Audit

### Band A (Routine)
- Adding `logEvent()` call after dispatch (~3 lines).
- Adding UI rendering case for the new event type (~10 lines).
- Sidebar refresh signal (~2 lines).

### Band B — Complex / Risky
- None.


## Adversarial Review

### Grumpy Critique
- "You're adding logging to a hot path — what if `logEvent()` throws? The autoban tick could silently break." → Valid. Wrap the log call in try/catch so logging failures never stop dispatches.
- "What about the DB-routed path for PLAN REVIEWED with complexity routing? There are two dispatch branches." → Valid. Ensure both the low-complexity (`coder`) and high-complexity (`lead`) branches in `_autobanTickColumn()` get logging.

### Balanced Synthesis
- Wrap log calls in try/catch — logging is best-effort, must not block autoban.
- Ensure both dispatch branches (static routing at ~line 1350 and dynamic complexity routing at ~lines 1334/1340) emit events.
- Keep event payload small (column, role, count, sessionIds) to avoid bloating the JSONL file.

## Agent Recommendation
Send it to the **Coder agent** — this is a straightforward 3-step change with no architectural risk.

## Reviewer Pass Update

### Review Outcome
- Reviewer pass completed in-place against the implemented code.
- The main implementation in `src/services/TaskViewerProvider.ts` and `src/webview/implementation.html` correctly added autoban dispatch logging, covered both dispatch branches, and triggered live-feed refreshes.
- One material defect was found in the activity aggregation pipeline: `autoban_dispatch` events were being collapsed into generic `summary` events before reaching the webview, which meant the new event-specific renderer path did not reliably receive the intended event type.

### Fixed Items
- Preserved `autoban_dispatch` events as first-class activity events in `SessionActionLog._aggregateEvents()` so the live feed can render the dedicated autoban format instead of falling back to a generic summary.
- Added a focused regression test to ensure `autoban_dispatch` remains unaggregated and retains its typed payload for renderer-specific formatting.

### Files Changed During Reviewer Pass
- `src/services/SessionActionLog.ts`
- `src/test/session-action-log.test.ts`

### Validation Results
- `npm run compile` ✅ Passed.
- `npm run compile-tests` ✅ Passed.
- Targeted runtime validation against `out/services/SessionActionLog.js` ✅ Passed (`autoban_dispatch` remained typed and retained `targetRole`).
- `npm run lint` ⚠️ Blocked by existing repository tooling configuration: ESLint 9 requires an `eslint.config.*` file, but the repo script currently has no compatible config.
- `node out\test\session-action-log.test.js` ⚠️ Still fails on a pre-existing title-mapping assertion unrelated to the autoban reviewer fix (`expected 'Alpha Plan', got 'sess_summary_1'` for the older summary aggregation test).

### Remaining Risks
- The broader `session-action-log` test script has an existing failing assertion outside the autoban path, so full green automated coverage for that file is not yet available from the current repository baseline.
- Repository linting remains unavailable until the ESLint configuration is migrated or restored for ESLint 9.

### Final Reviewer Assessment
- Ready. The autoban live-feed implementation now satisfies the plan requirements, and the one material defect found during review has been corrected and targeted-verified.
