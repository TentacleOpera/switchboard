# Replace mtime-based completion detection with explicit API-based completion for team coders

## Goal

Team coders on head-paced teams currently have their completion detected by the plan-file watcher: any mtime advance on the plan file after dispatch triggers `clearWorkingState`, which fires the turn-end notification and moves the card. This is unreliable — a coder that edits the plan file mid-work (e.g., appending a partial `## Completion Summary` after finishing one part of a multi-part plan) triggers premature turn-end, premature card movement, and a false completion notification to the lead.

### The problem, observed

A coder was dispatched on a two-part plan. It finished Part 2, appended a `## Completion Summary` to the plan file, and the file watcher fired — clearing the working state, moving the card to CODER CODED, and notifying the lead. But the coder was still working on Part 1. The lead received a premature turn-end notification and the card moved prematurely.

### Root cause

Commit `c5185aa8` (Jul 7) replaced content-based completion detection (the `**Stage Complete:**` marker) with mtime-based detection. The reasoning was: "the dispatch flow does not write the plan file, so any mtime advance reaching here while dispatched_at is set is the agent's completion edit." This assumption is wrong — the agent can edit the plan file mid-work for many reasons (partial completion reports, plan updates, notes). The file watcher has no way to distinguish a mid-work edit from a completion edit.

### Why the fix is straightforward

The system **already has** explicit API-based completion for two other agent types:
- **Seat-paced coders:** `SEAT_QUEUE_DONE_ORDER_BODY` standing order tells them to `POST /kanban/queue/done` when finished.
- **Standalone coders:** `GLOBAL_QUEUE_DONE_ORDER_BODY` standing order tells them to `POST /kanban/queue/done` when finished.

The `POST /kanban/queue/done` endpoint already calls `clearWorkingState` (the activity-light off-switch). The missing pieces for head-paced team coders are:
1. The team-scoped standing order doesn't include the queue/done instruction — it only has the callback instruction (`AGENT_GROUP_CALLBACK_INSTRUCTION`) + `GIT_SAFETY_DIRECTIVE`.
2. The `_runQueueDone` path doesn't fire the turn-end notifier or the completion broadcast — it only clears working state and pops the next card (for seat-paced teams).
3. The `CODING_COMPLETION_REPORT_DIRECTIVE` still tells the coder to append a summary to the plan file as the completion signal.
4. The mtime-based file-watcher completion detection is still active, racing with the API path.

## Metadata

**Complexity:** 7
**Tags:** bugfix, backend, reliability, refactor
**Project:** Browser Switchboard

## Proposed Changes

### Part 1 — Add queue/done instruction to team coder standing orders

**1a. Define a team-coder queue/done instruction constant — `src/services/teamWiring.ts`**

Add a new exported constant near `SEAT_QUEUE_DONE_ORDER_BODY`:

```ts
/**
 * The queue/done instruction appended to the team-scoped standing order for
 * head-paced team coders. Tells the coder to POST /kanban/queue/done when it
 * has finished ALL work on the dispatched plan — not after individual parts.
 * This is the explicit completion signal that replaces the unreliable mtime-
 * based file-watcher detection. The endpoint clears the card's activity light
 * and fires the turn-end notification to the lead.
 *
 * Mirrors SEAT_QUEUE_DONE_ORDER_BODY but uses <your terminal name> (the coder
 * knows its own terminal name) and adds the "ALL parts" qualifier to prevent
 * premature posts on multi-part plans.
 */
export const TEAM_CODER_QUEUE_DONE_INSTRUCTION =
    'When you have finished ALL parts of the dispatched plan, POST /kanban/queue/done with '
    + '{"from":"<your terminal name>"} against the port in .switchboard/api-server-port.txt. '
    + 'This signals completion — the system clears your activity light and notifies your lead. '
    + 'Do NOT post after finishing individual parts — only when ALL work is complete. '
    + 'If you cannot complete it, call the same endpoint with {"from":"<your terminal name>",'
    + '"outcome":"failed"} and a one-line reason.';
```

**1b. Append the instruction to the team-scoped standing order — `src/services/teamWiring.ts`, `wireSpawnedTeam` (~line 1816)**

Update the default team prompt construction to include the queue/done instruction:

Before (line 1816-1818):
```ts
const teamPromptInstruction = prompt
    ? prompt.replace(/\{child\}/g, headName).replace(/\{teamId\}/g, groupId)
    : `${callbackTemplate.replace(/\{child\}/g, headName)}\n${GIT_SAFETY_DIRECTIVE}`;
```

After:
```ts
const teamPromptInstruction = prompt
    ? prompt.replace(/\{child\}/g, headName).replace(/\{teamId\}/g, groupId)
    : `${callbackTemplate.replace(/\{child\}/g, headName)}\n${GIT_SAFETY_DIRECTIVE}\n${TEAM_CODER_QUEUE_DONE_INSTRUCTION}`;
```

When the caller supplies a custom `prompt`, the queue/done instruction is NOT appended — the caller's text wins. This matches the existing pattern for `GIT_SAFETY_DIRECTIVE` (which is also only in the default prompt). However, the `CODING_COMPLETION_REPORT_DIRECTIVE` (updated in Part 2) is appended per-dispatch via `ensureCompletionDirective`, so even custom-prompt teams get the API instruction on every dispatch.

**1c. Update the `migrateCodingTeamOrders` rewriter — `src/services/teamWiring.ts` (~line 2064)**

The rewriter currently matches old team-scoped orders by `indexOf` on fragments (`OLD_HEADPROMPT_FRAGMENT`, `BUGGY_HEADPROMPT_FRAGMENT`, `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT`). Wait — that rewriter is for `team-head` scoped orders (head prompts), not `team` scoped orders (member prompts). Let me re-check.

Actually, looking at the code more carefully: `migrateCodingTeamOrders` at line 2064 rewrites `team-head` scoped orders (the head's standing orders). The `team` scoped orders (member prompts) are handled by `migratePerMemberPairRowsToTeamScoped` at line 2063, which converts old per-member pair rows into team-scoped orders.

For the member prompt migration: the existing team-scoped orders already have the callback instruction + `GIT_SAFETY_DIRECTIVE`. We need to add the queue/done instruction to orders that don't have it. This is an additive change (old text + appended instruction), so we need a negative-check approach (match if the order contains a known fragment but NOT the queue/done marker).

Add a new fragment constant and marker:

```ts
/**
 * Substring unique to the current team-scoped member prompt (before the
 * queue/done instruction is appended). Used by the team-order rewriter's
 * negative check: a team-scoped order that contains this fragment but NOT
 * the QUEUE_DONE_MARKER is pre-queue-done-instruction and must be rewritten.
 */
export const PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT = 'Do not wait to be asked';

/**
 * Substring unique to TEAM_CODER_QUEUE_DONE_INSTRUCTION. Used by the
 * team-order rewriter's negative check for idempotency: a rewritten order
 * contains this marker, so it does not re-match.
 */
export const QUEUE_DONE_MARKER = 'POST /kanban/queue/done with';
```

Add a new migration function or extend the existing one to handle `team` scoped orders:

```ts
// In the team-order rewriter, add a condition for team-scoped orders:
if (o.scope === 'team' && typeof o.instruction === 'string') {
    if (o.instruction.indexOf(PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT) !== -1
        && o.instruction.indexOf(QUEUE_DONE_MARKER) === -1) {
        // Append the queue/done instruction to the existing order
        const newInstruction = o.instruction + '\n' + TEAM_CODER_QUEUE_DONE_INSTRUCTION;
        rewritten.push({ ...o, instruction: newInstruction });
        drop.add(o.id);
        touched = true;
        continue;
    }
}
```

**1d. Mirror in `terminals.js` — `src/webview/terminals.js`**

The standing-orders rewriter has a mirror in `terminals.js`. Add the `PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT`, `QUEUE_DONE_MARKER`, and `TEAM_CODER_QUEUE_DONE_INSTRUCTION` mirrors, and update the rewriter condition. Follow the same two-copy pattern enforced by `stage-marker-commit-contract.test.js`.

### Part 2 — Update the CODING_COMPLETION_REPORT_DIRECTIVE

**2a. Change the directive text — `src/services/agentPromptBuilder.ts` (~line 996)**

The directive is the per-dispatch completion handshake, appended idempotently by `ensureCompletionDirective`. Currently it tells the coder to append a summary to the plan file (the mtime-based signal). Change it to tell the coder to POST the API call.

Before:
```ts
export const CODING_COMPLETION_REPORT_DIRECTIVE = `COMPLETION REPORT: When you have finished implementing the plan, append a brief summary (3-5 sentences) to the END of the original plan file. Include: what you implemented, files changed, and any issues encountered. This edit signals task completion to the kanban board — the file watcher detects it and clears the card's working-state light. Do NOT skip this step.`;
```

After:
```ts
export const CODING_COMPLETION_REPORT_DIRECTIVE = `COMPLETION REPORT: When you have finished implementing ALL parts of the plan, POST /kanban/queue/done with {"from":"<your terminal name>"} against the port in .switchboard/api-server-port.txt. This signals task completion to the kanban board — the system clears your card's activity light and notifies your lead. Do NOT post after finishing individual parts — only when ALL work is complete. Also append a brief summary (3-5 sentences) to the END of the original plan file for the record. Do NOT skip the POST.`;
```

The plan-file summary is kept as a secondary "for the record" step — the POST is the completion signal, not the file edit. The sentinel for `ensureCompletionDirective` stays `'COMPLETION REPORT:'` (unchanged), so the idempotent guard still works.

**2b. Update the load-bearing comment — `src/services/agentPromptBuilder.ts` (~lines 985-995)**

The comment above the directive says it is "the sole signal the completion-detection chain keys on" and describes the file-watcher mtime mechanism. Update it to describe the API-based mechanism:

```ts
// CODING_COMPLETION_REPORT_DIRECTIVE is the completion-protocol handshake. It
// tells the dispatched agent to POST /kanban/queue/done when ALL work is complete.
// The API endpoint calls clearWorkingState (activity-light off-switch) and fires
// the turn-end notification to the lead. The autoban wake and the switchboard-manage
// skill's Column Oversight pass depend on this handshake. The directive is
// deliberately NON-overridable for code-touching roles: ensureCompletionDirective()
// re-appends it idempotently AFTER any defaultPromptOverride is applied, so a `replace`-
// mode role override cannot silently drop the handshake and leave cards stuck on. Do NOT
// treat this as prose, move it before the override application, or remove the post-override
// placement — the consumers above will break silently (cards never clear, oversight
// passes time out on work that succeeded).
```

**2c. Update `ensureCompletionDirective` — `src/services/agentPromptBuilder.ts` (~line 1061)**

The sentinel check stays `'COMPLETION REPORT:'` — no change needed to the function itself. But verify the tests that check for this sentinel still pass.

### Part 3 — Wire completion callbacks into the _runQueueDone path

Currently, `_runQueueDone` (LocalApiServer.ts:2157) calls `clearWorkingState` but does NOT fire:
- The completion broadcast (`broadcastAgentCompleted` — the browser Terminals panel toast)
- The turn-end notifier (`notifyTurnEnd` — the notification to the lead + autoban dispatch)

Both of these are fired from the file-watcher path in `PlanIngestionEngine.ts` on the `transitioned` gate. They need to fire from `_runQueueDone` too.

**3a. Add callbacks to LocalApiServer options — `src/services/LocalApiServer.ts`**

Add two new optional callbacks to the `LocalApiServerOptions` interface (alongside the existing `clearTerminalContext` and `terminalVerb`):

```ts
/** Fired when a seat's working state is cleared (non-NULL→NULL transition) via
 *  queue/done. Mirrors PlanIngestionEngine._onWorkingStateCleared →
 *  broadcastAgentCompleted. The record is the pre-clear read (still has
 *  dispatchedAt, dispatchedTerminal, etc.) so the broadcast can include them. */
onWorkingStateCleared?: (record: any, workspaceRoot: string) => void;

/** Fired when a seat's turn ends via queue/done. Mirrors
 *  PlanIngestionEngine._turnEndNotifier → notifyTurnEnd + handleAutobanTurnEnd.
 *  The host resolves the recipient and delivers the notification. */
onTurnEndNotify?: (info: { seatName: string; planFile: string; outcome: 'completed'; workspaceRoot: string; body?: string }) => void;
```

**3b. Fire the callbacks in _runQueueDone — `src/services/LocalApiServer.ts` (~line 2212)**

After `clearWorkingState` returns `transitioned = true`, fire both callbacks:

```ts
if (transitioned) {
    // Fire the completion broadcast (browser toast) — mirrors the
    // file-watcher path's _onWorkingStateCleared callback.
    if (this._options.onWorkingStateCleared) {
        try { this._options.onWorkingStateCleared(held, workspaceRoot); } catch (e) {
            console.warn('[LocalApiServer] onWorkingStateCleared callback failed:', e);
        }
    }
    // Fire the turn-end notifier (lead notification + autoban) — mirrors
    // the file-watcher path's _turnEndNotifier callback. Composed body
    // uses the same composer as the watcher path for consistency.
    if (this._options.onTurnEndNotify) {
        try {
            const body = composeCompletedTurnEndBody(held, from, held.planFile, Date.now());
            this._options.onTurnEndNotify({
                seatName: from,
                planFile: held.planFile,
                outcome: 'completed',
                workspaceRoot,
                body,
            });
        } catch (e) {
            console.warn('[LocalApiServer] onTurnEndNotify callback failed:', e);
        }
    }
}
```

Note: `composeCompletedTurnEndBody` is currently exported from `PlanIngestionEngine.ts`. Either import it into `LocalApiServer.ts`, or extract it to a shared utility module. Importing from `PlanIngestionEngine` is fine — `LocalApiServer` already imports from other service modules.

**3c. Wire the callbacks in extension.ts — `src/extension.ts`**

When constructing `LocalApiServer`, pass the new callbacks:

```ts
onWorkingStateCleared: (record, wsRoot) => {
    taskViewerProvider.broadcastAgentCompleted(record, wsRoot);
},
onTurnEndNotify: (info) => {
    taskViewerProvider.notifyTurnEnd(info);
    taskViewerProvider.handleAutobanTurnEnd(info);
},
```

This mirrors the existing wiring at extension.ts:1085 (`setOnWorkingStateCleared`) and extension.ts:1152 (`setTurnEndNotifier`).

**3d. Wire the callbacks in bootstrap.ts — `src/standalone/bootstrap.ts`**

The standalone host has its own turn-end notifier callback (bootstrap.ts:2181). Wire the same callbacks into the standalone `LocalApiServer` construction. The standalone host's turn-end delivery uses `deliverPrompt` instead of `notifyTurnEnd`, so the callback should match the existing standalone pattern.

### Part 4 — Remove mtime-based completion detection

**4a. Remove the real-time watcher completion detection — `src/services/PlanIngestionEngine.ts` (~lines 2096-2145)**

Remove the `if (updatedRecord.dispatchedAt)` block that calls `clearWorkingState` and fires the turn-end notifier on plan file mtime advance. The file watcher still updates plan metadata (metadata parsing, DB upsert, feature links, ClickUp sync) — it just no longer treats a plan file edit as a completion signal.

The block to remove:
```ts
// REMOVE this entire block:
if (updatedRecord.dispatchedAt) {
    try {
        const transitioned = await db.clearWorkingState(relativePath, workspaceId);
        // ... (the completion broadcast, turn-end notifier, logging)
    } catch (clearErr) {
        // ...
    }
}
```

Replace with a log line noting that mtime-based completion is retired:
```ts
if (updatedRecord.dispatchedAt) {
    this._host.logger.appendLine(
        `[GlobalPlanWatcher] Plan file edited while dispatched (mtime-based completion retired — waiting for POST /kanban/queue/done): ${relativePath}`
    );
}
```

**4b. Remove the sweep's mtime-based completion detection — `src/services/PlanIngestionEngine.ts` (~lines 592-631)**

The periodic sweep currently checks `stat.mtimeMs > dispatchedMs` and calls `clearWorkingState` if true. Remove this check — the sweep should only use the silence/blocked detection (the `else if (!record.blockedAt)` arm at line 632) and the timeout fallback.

The block to remove:
```ts
// REMOVE the mtime check and the `if (completed)` arm:
let completed = false;
for (const planRoot of planRoots) {
    try {
        const stat = await fs.promises.stat(path.join(planRoot, record.planFile));
        if (stat.mtimeMs > dispatchedMs) { completed = true; break; }
    } catch (statErr) { /* ... */ }
}
if (completed) {
    const transitioned = await db.clearWorkingState(record.planFile, wsId);
    // ... (the completion broadcast, turn-end notifier, logging)
}
```

Keep the `else if (!record.blockedAt)` arm (silence → blocked) and the timeout sweep (`clearStaleWorkingState`).

**4c. Keep `clearStaleWorkingState` (timeout) as the fallback — no change**

The 20-minute timeout sweep (`clearStaleWorkingState`) remains as the safety net for when a coder never calls the API (crash, stuck, etc.). This is the correct fallback — it's a timeout, not a false-positive on mid-work edits.

**4d. Update the `TurnEndInfo` interface comment — `src/services/PlanIngestionEngine.ts` (~line 88)**

The `outcome` field's doc says `completed` = "plan file mtime advanced." Update to reflect the new mechanism:

```ts
/** `completed` = the seat POSTed /kanban/queue/done (the seat finished);
 *  `blocked` = silence without a report;
 *  `stalled` = the feature-level nudge — no dispatch is outstanding, the head went idle with
 *  un-accepted subtasks remaining, and the engine is waking it with evidence. */
outcome: 'completed' | 'blocked' | 'stalled';
```

### Part 5 — Tests

**5a. Update `src/test/seat-safeguards-fleet-prompt-path.test.js`**

- The test at line 978 (`ensureDispatchProtocolDirectives attaches both completion and report directives idempotently`): Still asserts `COMPLETION REPORT:` is present — will pass (sentinel unchanged). Update any assertion that checks for the old directive body text ("append a brief summary to the END of the original plan file") to check for the new body text ("POST /kanban/queue/done").
- The test at line 1011: Update the `directivesAttached` record check if it references the old directive text.

**5b. Update `src/test/orchestrator-tick-and-reports-contract.test.js`**

- The test at line 552-558: The assertion checks that the report directive states "IN ADDITION TO, never INSTEAD OF" the plan-file completion report. Update to reflect the new directive text (the plan-file summary is now "for the record," not the completion signal).
- The test at line 557: The regex check `!/CODING_COMPLETION_REPORT_DIRECTIVE\s*=\s*`[^`]*ORCHESTRATOR REPORT/` still passes (the directive still doesn't contain "ORCHESTRATOR REPORT").

**5c. Update `src/test/autoban-reviewer-prompt-regression.test.js`**

- The test at line 79-80: Asserts the directive contains "per the COMPLETION REPORT step." Update if the new directive text changes this reference.

**5d. Update `src/test/queue-pipeline-contract.test.js`**

- The test at line 189: The comment says "A plan-file mtime advance clears dispatchedAt (clearWorkingState)." Update the comment and any mock that simulates mtime-based clearing. The mock `clearWorkingState` at line 280 and 337 stays — it's used by the queue/done path too.

**5e. Add test for the _runQueueDone turn-end notifier**

Add a test that verifies `_runQueueDone` fires the `onTurnEndNotify` and `onWorkingStateCleared` callbacks when `clearWorkingState` returns `transitioned = true`. Follow the pattern of existing queue/done tests.

**5f. Add test for the team-scoped standing order migration**

Add a test that verifies the `migrateCodingTeamOrders` (or new migration function) appends `TEAM_CODER_QUEUE_DONE_INSTRUCTION` to team-scoped orders that don't have the `QUEUE_DONE_MARKER`, and is idempotent on second pass.

**5g. Add test for the terminals.js mirror**

Add test assertions in `stage-marker-commit-contract.test.js` for the new `TEAM_CODER_QUEUE_DONE_INSTRUCTION`, `PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT`, and `QUEUE_DONE_MARKER` two-copy rule (teamWiring.ts + terminals.js).

## What does NOT change

- **`POST /kanban/queue/done` endpoint** — the endpoint itself is unchanged. It already calls `clearWorkingState`, handles duplicates, and pops the next card. The only addition is firing the two new callbacks.
- **Seat-paced teams** — `SEAT_QUEUE_DONE_ORDER_BODY` is unchanged. Seat-paced teams already POST when done.
- **Standalone coders** — `GLOBAL_QUEUE_DONE_ORDER_BODY` is unchanged. Standalone coders already POST when done.
- **File-based team queue** — `POST /terminals/teams/<groupId>/queue/done` is unchanged. It already relays to the lead.
- **`clearStaleWorkingState` (timeout sweep)** — remains as the fallback for when a coder never calls the API.
- **The silence/blocked detection** — the sweep's `else if (!record.blockedAt)` arm (silence → blocked) is unchanged. A coder that goes silent without posting is still marked blocked.
- **`ensureCompletionDirective` sentinel** — stays `'COMPLETION REPORT:'`. The idempotent guard is unchanged.
- **`AGENT_GROUP_CALLBACK_INSTRUCTION`** — the "report to head" instruction stays in the team prompt. It's the fallback for when the API call fails (the coder reports to the head directly via ptySendPrompt). The queue/done instruction is appended alongside it, not replacing it.
- **Per-dispatch GIT POLICY block** — `buildGitPolicyBlock` continues to compose branch/commit/push/safety per-dispatch. Unchanged.
- **`seatBlock: false` on turn-end notifications** — unchanged. A machine notice has no task to constrain.
- **`clearBeforePrompt: false` on turn-end notifications** — unchanged. Never wipe the recipient's context.

## Edge cases

- **Coder can't reach the API (server not running):** The `AGENT_GROUP_CALLBACK_INSTRUCTION` is the fallback — the coder reports to the head directly via `POST /terminals/verb/ptySendPrompt`. The head receives the report and can act on it. The timeout sweep (`clearStaleWorkingState`) clears the working state after 20 minutes if no API call is made.
- **Coder posts prematurely (after finishing one part, not all):** The standing order and directive both say "Do NOT post after finishing individual parts — only when ALL work is complete." This is the same LLM-compliance risk as any instruction, but the explicit API call is a more deliberate action than a file edit — the coder has to construct and send a curl command, which is harder to do accidentally than editing a file. The premature-post risk is lower than the premature-mtime risk.
- **Duplicate posts (network retry):** The `clearWorkingState` `IS NOT NULL` gate makes the second post a no-op (returns `transitioned = false`). The callbacks only fire on `transitioned = true`, so no double-notification.
- **File watcher still fires on plan file edits:** The watcher still updates plan metadata, feature links, and ClickUp sync. It just no longer calls `clearWorkingState` or fires the turn-end notifier. A plan file edit while dispatched is logged but does not trigger completion.
- **Custom-prompt teams:** When the caller supplies a custom `prompt` to `wireSpawnedTeam`, the queue/done instruction is NOT appended to the standing order (the caller's text wins). But the `CODING_COMPLETION_REPORT_DIRECTIVE` (updated in Part 2) is still appended per-dispatch via `ensureCompletionDirective`, so even custom-prompt teams get the API instruction on every dispatch.
- **Reviewer and tester roles:** The `CODING_COMPLETION_REPORT_DIRECTIVE` is appended to all code-touching roles via `ensureCompletionDirective`. Reviewers and testers will also be told to POST when done. This is correct — their completion should also be explicit, not mtime-based.
- **Standalone host (bootstrap.ts):** The standalone host has its own turn-end notifier callback. The new `onTurnEndNotify` callback on `LocalApiServer` needs to be wired in the standalone host too, using the standalone `deliverPrompt` pattern.
- **`terminals.js` mirror synchronization:** The standing-orders rewriter mirror in `terminals.js` must be updated alongside `teamWiring.ts`. The `stage-marker-commit-contract.test.js` enforces byte-identity — a missed mirror breaks the test and ships divergent delivery between host and webview.

## Dependencies

None — this plan is self-contained. No other plan or session is a prerequisite.

## Verification Plan

### Automated Tests

1. `node --check src/services/agentPromptBuilder.ts` — syntax check
2. `node --check src/services/LocalApiServer.ts` — syntax check
3. `node --check src/services/teamWiring.ts` — syntax check
4. `node --check src/services/PlanIngestionEngine.ts` — syntax check
5. `node --check src/extension.ts` — syntax check
6. `node --check src/standalone/bootstrap.ts` — syntax check
7. Run `src/test/seat-safeguards-fleet-prompt-path.test.js` — updated directive assertions pass
8. Run `src/test/orchestrator-tick-and-reports-contract.test.js` — updated directive assertions pass
9. Run `src/test/autoban-reviewer-prompt-regression.test.js` — updated directive assertions pass
10. Run `src/test/queue-pipeline-contract.test.js` — updated mtime/clearWorkingState assertions pass
11. Run `src/test/stage-marker-commit-contract.test.js` — new fragment/marker two-copy rule assertions pass
12. Run new test: `_runQueueDone` fires `onTurnEndNotify` and `onWorkingStateCleared` on `transitioned = true`
13. Run new test: team-scoped standing order migration appends `TEAM_CODER_QUEUE_DONE_INSTRUCTION`, idempotent on second pass

### Manual Verification

14. Grep `CODING_COMPLETION_REPORT_DIRECTIVE` in `agentPromptBuilder.ts` — confirm the directive text says "POST /kanban/queue/done" and "Do NOT post after finishing individual parts"
15. Grep `TEAM_CODER_QUEUE_DONE_INSTRUCTION` in `teamWiring.ts` — confirm it's appended to the default team prompt in `wireSpawnedTeam`
16. Grep `TEAM_CODER_QUEUE_DONE_INSTRUCTION` in `terminals.js` — confirm the mirror exists and is byte-identical
17. Grep `onTurnEndNotify` in `LocalApiServer.ts` — confirm the callback is fired in `_runQueueDone` on `transitioned = true`
18. Grep `onTurnEndNotify` in `extension.ts` — confirm it's wired to `notifyTurnEnd` + `handleAutobanTurnEnd`
19. Grep `onWorkingStateCleared` in `extension.ts` — confirm it's wired to `broadcastAgentCompleted`
20. Grep `if (updatedRecord.dispatchedAt)` in `PlanIngestionEngine.ts` — confirm the mtime-based `clearWorkingState` call is removed (only the log line remains)
21. Grep `stat.mtimeMs > dispatchedMs` in `PlanIngestionEngine.ts` — confirm the sweep's mtime-based completion check is removed
22. Manual: dispatch a subtask to a team coder, wait for the coder to POST /kanban/queue/done, confirm the lead receives the turn-end notification and the card's activity light clears
23. Manual: dispatch a multi-part plan to a team coder, confirm that a mid-work plan file edit does NOT trigger turn-end notification or card movement
