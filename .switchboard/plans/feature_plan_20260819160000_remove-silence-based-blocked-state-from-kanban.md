# Remove Silence-Based "Blocked" State from the Kanban

## Metadata

**Complexity:** 5
> **Superseded:** Complexity: 4
> **Reason:** The plan touches 6+ files (PlanIngestionEngine.ts, KanbanDatabase.ts, KanbanProvider.ts, kanban.html, package.json, two test files) with ~15 distinct edit sites. Single-file changes are 3-4; this is multi-file with moderate logic (the `isWorkingState` signature change ripples to 4 call sites, the feature rollup SQL rewrite, and the webview signature/update path). 5 is the correct score per the scoring guide ("Medium — multi-file changes, moderate logic").
> **Replaced with:** Complexity: 5
**Tags:** backend, frontend, bugfix, refactor, ui
**Project:** Browser Switchboard

## Goal

### Problem

The kanban board has a "Waiting on you" badge — a yellow dashed ring + badge text on cards — driven by PTY output silence. When a dispatched terminal goes quiet for 90 seconds without advancing the plan file's mtime, the `GlobalPlanWatcher` stamps `blocked_at`, and the kanban renders the blocked decoration. This was designed as a CLI-agnostic "which seat needs me" signal for fleet operators.

It doesn't work. Silence is ambiguous — it cannot distinguish "agent asked a question" from "agent is thinking," "agent is running a build," "agent crashed," or "the operator moved the plan to a different column and the agent's dispatch is stale." The result is a board that cries wolf: cards light up yellow for reasons that have nothing to do with waiting on the operator. The user's exact words: "I don't want to be spammed with a hundred different bling."

A second, related bug: column transitions (`moveCardToColumnWithReason`) never clear `dispatched_at`. When a plan is moved to `PLAN REVIEWED` or `COMPLETED`, the working state stays live until the 10-minute timeout sweep. This is why the user's specific card was glowing — it was moved to `PLAN REVIEWED` but the dispatch state was never cleared, so the silence detector stamped it blocked.

A third bug: the 30-minute hard cap in `clearStaleWorkingState` and `isWorkingState` force-clears a card after 30 minutes from dispatch regardless of liveness. A coder actively producing output on a complex task gets its card yanked at 30 minutes. The liveness heartbeat already protects live terminals via the `last_liveness_at` basis — the hard cap was meant to catch a wedged agent that produces output but never finishes, but that is a rare edge case and the false positive (yanking a card from a working coder) is worse than the false negative (a wedged agent stays lit until the operator notices).

### Outcome

After this fix:
- The "Waiting on you" badge, dashed amber ring, and `title="Agent waiting on you…"` tooltip are gone from the kanban.
- The silence branch in `PlanIngestionEngine.ts` no longer stamps `blocked_at` or fires the `blocked` turn-end outcome.
- The `setBlockedState` writer is removed — no code writes to `blocked_at`.
- The `isWorkingState` derive simplifies to `working = (now - basis) < timeoutMs`. No `blocked` boolean is computed or returned. The 30-minute hard cap (`withinHardCap`) is removed — a live terminal producing output stays lit indefinitely.
- The feature rollup SQL drops the `anyBlocked` term and the `hardCapCutoff` guard.
- The `clearStaleWorkingState` blocked-retention clause and the 30-minute hard cap clause are both removed. The 10-minute silence timeout stays as the dead-process backstop.
- The `blockedTimeoutMs` config setting is no longer read — and is removed from `package.json` so it does not appear in the settings UI.
- Column transitions clear `dispatched_at` so the working glow doesn't linger on moved cards.
- The `blocked_at` column stays in the schema (shipped in V59, ~4,000 installs — removing it requires a migration and it's harmless as a dead column).

### What is NOT removed

- **The `completed` turn-end outcome** (plan-file mtime advance) — the reliable completion signal. Stays untouched.
- **The `stalled` turn-end outcome** (feature nudge / queue nudge) — the backstop that wakes an idle head with un-accepted subtasks. Stays untouched. These sweeps use `turnEndSilenceMs` as a threshold for the head's own idleness but do NOT depend on `blocked_at` or the silence branch.
- **The `'blocked'` value in the `TurnEndInfo` outcome union** — still used by the Phone-a-Friend dispatch-drop path (`_emitPhoneAFriendNotice('blocked', ...)` at `TaskViewerProvider.ts:5996`). The type, the `notifyTurnEnd` message branch, and the `writeOrchestratorReport` `kind: 'blocked'` mapping all stay.
- **The `handleAutobanTurnEnd` hook** — confirmed no-op (empty body at `TaskViewerProvider.ts:1728-1731`). Stays as-is.
- **The `turnEndSilenceMs` config setting** — still used by the feature nudge and queue nudge sweeps for head-idleness detection. Stays.
- **The `recordLiveness` heartbeat** — still stamps `last_liveness_at` for the working age basis. Stays (just stops nulling `blocked_at`, which is always NULL after this fix).
- **The `blocked_at` column in the DB schema** — stays as a dead column. No writer, no reader.

## User Review Required

- **Confirm the dead-column strategy**: The `blocked_at` column stays in the schema (no migration to drop it). This is the low-risk choice for ~4,000 existing installs. If you prefer a V61 migration to drop the column, flag it before implementation — the plan does not include one.
- **Confirm the `package.json` config removal**: The `switchboard.activityLight.blockedTimeoutMs` setting is removed from `package.json`. Any user who has explicitly set this value in their `settings.json` will get an "unknown configuration setting" warning. This is cosmetic and harmless, but worth confirming.

## Complexity Audit

### Routine
- Deleting the silence branch in `PlanIngestionEngine.ts` (lines 594-608) — straightforward deletion of an `else if` block.
- Removing `setBlockedState()` from `KanbanDatabase.ts` — single method deletion, no callers after step 1.
- Removing CSS rules for `.is-blocked` from `kanban.html` — pure CSS deletion.
- Removing `blockedTimeoutMs` config reads from `KanbanProvider.ts` (6 sites) — mechanical removal of a config read and its pass-through.
- Removing `blockedTimeoutMs` from `package.json` — single config block deletion.
- Simplifying `clearStaleWorkingState` SQL — removing one OR clause from a WHERE condition.
- Updating contract tests — adjusting assertions to target the `completed` arm instead of the silence branch.

### Complex / Risky
- **`isWorkingState` signature change** — removing `blockedAt` and `blockedTimeoutMs` parameters changes the return type from `{ working: boolean; blocked: boolean }` to `{ working: boolean }`. This ripples to 4 call sites in `KanbanProvider.ts` (lines 2082, 3833, 4063, 8450) and the `KanbanCard` interface (line 136). Each call site and card-building site must be audited to ensure no remaining `blocked` destructuring or property assignment.
- **Feature rollup SQL rewrite** — `getFeatureWorkingStates` in `KanbanDatabase.ts` (lines 6461-6498) changes its return type and SQL query. The `anyBlocked` term and `blockedCutoff` parameter are removed. All consumers of the `blocked` property in the returned Map must be updated.
- **Column-transition fix (step 8)** — adding `clearWorkingState` call inside `moveCardToColumnWithReason` is a new side effect on a critical path. Must verify it doesn't interfere with integration sync, queue position clearing, or feature file regeneration that follow in the same `if (outcome.ok)` block.
- **Webview board signature** — `buildBoardSignature` (kanban.html:7024) includes `card.blocked` in its hash. Removing it changes the signature format, which triggers a full board re-render on the first poll after deploy. This is a one-time visual flash, not a correctness issue, but worth noting.

## Edge-Case & Dependency Audit

### Race Conditions
- **Column transition vs. completion**: If a plan-file mtime advance (completion) and a column move happen in the same tick, both call `clearWorkingState`. The second call is a no-op (`dispatched_at` already NULL → `getRowsModified() === 0` → `transitioned === false`). No race.
- **Column transition vs. timeout sweep**: If the timeout sweep and a column move race, both null `dispatched_at`. Same no-op behavior. No race.

### Security
- No security implications. The `blocked_at` column is an internal state field with no auth surface.

### Side Effects
- **Board signature change**: Removing `card.blocked` from `buildBoardSignature` changes the signature format. The first poll after deploy will detect a "change" on every card and trigger a full re-render. This is a one-time flash, not a correctness issue.
- **Dead config warning**: Users who have explicitly set `switchboard.activityLight.blockedTimeoutMs` in their `settings.json` will see an "Unknown Configuration Setting" warning after the `package.json` entry is removed. This is cosmetic and harmless — VS Code ignores unknown settings.
- **Comment rot**: Multiple comments across `KanbanDatabase.ts` (lines 96, 103, 108, 481-493), `PlanIngestionEngine.ts` (line 226), `TaskViewerProvider.ts` (line 1560), and `terminals.js` (line 4736) reference `blocked_at`, `setBlockedState`, or the blocked arm. These will be stale after the fix. Optional cleanup — leaving them minimizes the diff but creates confusion for future readers.

### Dependencies & Conflicts

#### Turn-end notifier — three producers, one being removed

| Producer | Outcome | Status |
|----------|---------|--------|
| Plan-file mtime advance (`PlanIngestionEngine.ts:566-592`) | `completed` | **Stays** — reliable completion signal |
| Silence branch (`PlanIngestionEngine.ts:594-608`) | `blocked` | **Removed** — flawed silence heuristic |
| Feature nudge sweep (`PlanIngestionEngine.ts:1163-1171`) | `stalled` | **Stays** — independent of `blocked_at` |
| Queue nudge sweep (same file, further down) | `stalled` | **Stays** — independent of `blocked_at` |
| Phone-a-Friend dispatch drop (`TaskViewerProvider.ts:5996`) | `blocked` | **Stays** — legitimate "dispatch dropped" signal, NOT silence-based |

After removal, the turn-end notifier still fires for `completed` (mtime advance), `stalled` (feature/queue nudge), and `blocked` (Phone-a-Friend dispatch drop). The only thing lost is the silence-based "your child went quiet" message to the parent terminal — which was a false-positive generator.

#### Feature nudge and queue nudge — independent of the silence branch

Both sweeps were verified to have NO dependency on `blocked_at` or the silence branch:
- They use `turnEndSilenceMs` as a threshold for the **head's own** `lastDataAt` (is the head idle?), not for detecting child silence.
- They have their own gates (un-accepted subtasks, no outstanding dispatch, head active, pacing floor).
- They share the `notifiedSeatsThisTick` set with the silence branch, but the set is additive — removing the silence branch's contribution just means the set is smaller (only `completed` entries from the mtime-advance path). The nudge gates still work correctly.

#### `handleAutobanTurnEnd` — confirmed no-op

The method body at `TaskViewerProvider.ts:1728-1731` is:
```ts
public handleAutobanTurnEnd(info: ...): void {
    // Turn-end detection survives, but completion-driven dispatch is deleted.
    // The schedule calls the queue pop; a self-pacing lead calls it directly.
    // Nothing to do here — the notifier hook stays for the activity light.
}
```
Empty. No dependency on `blocked` outcome.

#### Column-transition bug — root cause traced

`moveCardToColumnWithReason` (`KanbanProvider.ts:7588-7650`) updates the column, syncs integrations, clears queue position, and regenerates feature files — but never clears `dispatched_at`. The only clearers are:
- `clearWorkingState` — called on plan-file mtime advance (the completion path)
- `clearStaleWorkingState` — the timeout sweep (10 min default)
- `recordLiveness` — nulls `blocked_at` (not `dispatched_at`) on heartbeat

So when a plan is moved to `PLAN REVIEWED` after being coded, `dispatched_at` stays live. The silence detector then sees "dispatched + silent + no mtime advance" and stamps `blocked_at`. Even after removing the silence detector, the working glow would linger for up to 10 minutes on a moved card. The fix (step 8) clears `dispatched_at` on column transition.

## Dependencies

- `sess_20260808083000 — PTY turn-end from output silence` (the V59 plan that introduced the silence branch and `blocked_at` — this plan reverses the silence-detection portion while keeping the column and the `blocked` outcome type for Phone-a-Friend)
- `sess_20260807103000 — PTY liveness heartbeat gates activity-light sweep` (the V58 plan that introduced `last_liveness_at` and the heartbeat — unaffected, stays intact)

## Adversarial Synthesis

Key risks: (1) incomplete reference cleanup — the `KanbanCard` interface, `buildBoardSignature`, incremental update path, and `package.json` config are all sites the original plan missed; a coder following the original would leave dead surface area that confuses future readers. (2) The column-transition fix adds a new side effect (`clearWorkingState`) on a critical path — safe because the call is idempotent and ignores the `transitioned` return, but must be placed before the integration sync to avoid a stale-glow race. Mitigations: the added step 10 (interface + package.json + webview signature cleanup) closes all gaps; the column-transition placement is specified precisely (after `if (outcome.ok)`, before integration sync).

## Proposed Changes

### 1. Remove the silence branch in `PlanIngestionEngine.ts`

**File:** `src/services/PlanIngestionEngine.ts`

Delete the `else if (!record.blockedAt)` block at lines 594-608. This block:
- Called `db.setBlockedState(record.planFile, wsId, livenessIso)`
- Fired `_turnEndNotifier({ outcome: 'blocked', ... })`
- Added the seat to `notifiedSeatsThisTick`

After removal, the `if (completed) { ... }` branch (mtime advance → `completed` outcome) remains, and the `else` falls through to nothing. The `silentTerminals` classification still runs (it populates the array), but the loop that acts on it has its body removed. The `silentTerminals` array can also be removed to avoid dead code, but this is optional — leaving it populated but unused is harmless and minimizes the diff.

**Also remove:** The `blockedTimeoutMs` config read at line 448 (`activityCfg.getNumber('blockedTimeoutMs', ...)`) and its pass-through to `clearStaleWorkingState` at line 614. After removing the blocked retention logic in `clearStaleWorkingState` (step 5), this parameter is unused. The call at line 614 simplifies from `db.clearStaleWorkingState(wsId, timeoutMs, { forceTerminals, blockedTimeoutMs })` to `db.clearStaleWorkingState(wsId, timeoutMs, { forceTerminals })`.

**Also update:** The comment at line 226 referencing `!record.blockedAt` for the blocked arm — update to reflect that only the `transitioned` boolean gates the completed arm (the blocked arm is removed).

### 2. Remove `setBlockedState()` from `KanbanDatabase.ts`

**File:** `src/services/KanbanDatabase.ts`

Remove the `setBlockedState` method (lines 10068-10074). After step 1, no caller exists.

**Also update:** The JSDoc comment at lines 93-99 and the migration comment at lines 481-493 that describe `blocked_at` as having a writer — update to note the writer was removed and the column is now dead (retained for schema compatibility).

### 3. Simplify `isWorkingState()` in `KanbanProvider.ts`

**File:** `src/services/KanbanProvider.ts`

Remove the `blockedAt` parameter and `blockedTimeoutMs` parameter from `isWorkingState()` (lines 167-192). Remove the `blocked` computation (lines 189-190). Remove the `withinHardCap` hard cap (line 189: `const withinHardCap = now - ts <= 3 * timeoutMs`) — a live terminal producing output should stay lit indefinitely, not be force-cleared after 30 minutes. Simplify `working` to:
```ts
const working = (now - basis) < timeoutMs;
return { working };
```

The return type changes from `{ working: boolean; blocked: boolean }` to `{ working: boolean }`. All callers that destructure `blocked` must be updated (see step 4).

**Also update:** The JSDoc comment at lines 147-165 that describes the V59 `blocked` extension — update to note the blocked term was removed and the function reverted to its pre-V59 working-only form.

Remove the `blockedTimeoutMs` config reads at lines 1244, 2200, 3822, 4043, 8429, and 12208. Remove the `blockedTimeoutMs` parameter from `_buildBoardCards` (line 2063) and all call sites (lines 1245, 2201, 12210).

### 4. Remove `blocked` from all card-building sites and the `KanbanCard` interface in `KanbanProvider.ts`

**File:** `src/services/KanbanProvider.ts`

**Interface:** Remove `blocked?: boolean` from the `KanbanCard` interface (line 136). After this fix, no code sets this property.

**Card-building sites:** At each site where `isWorkingState(...)` is called, the result is used to set card properties. Remove the `blocked` property from every card object:

- **Site 1** (`_buildBoardCards`, line 2082): `isWorkingState(...)` result is destructured into `cardState`, then `blocked: cardState.blocked` is set at line 2098. Remove line 2098.
- **Site 2** (line 3833): `isWorkingState(...)` result is destructured into `cardState2`, then `blocked: cardState2.blocked` is set at line 3850. Remove line 3850.
- **Site 3** (line 4063): `isWorkingState(...)` result is destructured into `cardState3`, then `blocked: cardState3.blocked` is set at line 4076. Remove line 4076.
- **Site 4** (line 8450): `isWorkingState(...)` result is spread directly into the card object via `...isWorkingState(...)`. After the return type change (step 3), the spread no longer includes `blocked`. No explicit removal needed — the spread adapts automatically.

**Feature rollup sites:** At lines 2081, 3832, 4062, the card state for feature cards reads `featureState?.blocked`. Replace `{ working: featureState?.working ?? false, blocked: featureState?.blocked ?? false }` with `{ working: featureState?.working ?? false }` at lines 2081, 3832, 4062.

### 5. Remove blocked retention from `clearStaleWorkingState` in `KanbanDatabase.ts`

**File:** `src/services/KanbanDatabase.ts`

Simplify the UPDATE at lines 10262-10268. The current SQL:
```sql
UPDATE plans SET dispatched_at = NULL, last_liveness_at = NULL, blocked_at = NULL
WHERE workspace_id = ? AND dispatched_at IS NOT NULL AND (
  (blocked_at IS NULL AND (MAX(dispatched_at, COALESCE(last_liveness_at, dispatched_at)) < ? OR dispatched_at < ?))
  OR (blocked_at IS NOT NULL AND blocked_at < ?)
)
```
Simplify to:
```sql
UPDATE plans SET dispatched_at = NULL, last_liveness_at = NULL, blocked_at = NULL
WHERE workspace_id = ? AND dispatched_at IS NOT NULL AND (
  MAX(dispatched_at, COALESCE(last_liveness_at, dispatched_at)) < ? OR dispatched_at < ?
)
```
The `blocked_at = NULL` in the SET clause is a no-op (always NULL after this fix) but leaving it is harmless and minimizes the diff. Remove the `blockedTimeoutMs` parameter from `clearStaleWorkingState` (line 10248) and the `blockedCutoff` computation (line 10254). Update the call at `PlanIngestionEngine.ts:614` to stop passing `blockedTimeoutMs`.

**Also remove the 30-minute hard cap.** The current SQL includes `OR dispatched_at < ?` where the parameter is `hardCapCutoff = 3 × timeoutMs` (30 minutes by default). This force-clears a card after 30 minutes from dispatch **regardless of liveness** — a coder actively producing output on a complex task gets its card yanked at 30 minutes. The liveness heartbeat (`last_liveness_at`) already protects live terminals via the `MAX(dispatched_at, COALESCE(last_liveness_at, dispatched_at)) < cutoff` clause, so a terminal producing output within the last 10 minutes is spared. The hard cap was meant to catch a wedged agent that produces output but never finishes (e.g. an infinite loop that prints), but that is a rare edge case and the false positive (yanking a card from a working coder) is worse than the false negative (a wedged agent stays lit until the operator notices).

Remove the `hardCapCutoff` computation (line 10612: `const hardCapCutoff = new Date(Date.now() - 3 * maxAgeMs).toISOString()`) and the `OR dispatched_at < ?` clause from the SQL. The SQL simplifies further to:

```sql
UPDATE plans SET dispatched_at = NULL, last_liveness_at = NULL, blocked_at = NULL
WHERE workspace_id = ? AND dispatched_at IS NOT NULL
  AND MAX(dispatched_at, COALESCE(last_liveness_at, dispatched_at)) < ?
```

Parameters change from `[workspaceId, cutoff, hardCapCutoff, blockedCutoff]` to `[workspaceId, cutoff]`. The `maxAgeMs` parameter (the 10-minute silence timeout) stays — it is the dead-process backstop, clearing cards whose terminals have not produced output in 10 minutes.

**Also remove** the `blockedTimeoutMs` parameter from `getFeatureWorkingStates` (line 6464) and the `anyBlocked` / `blockedCutoff` terms from the feature rollup SQL (lines 6470, 6476-6479, 6492). The SQL simplifies to just the `anyWorking` term:
```sql
SELECT feature_id AS featureId,
       MAX(dispatched_at IS NOT NULL
           AND MAX(dispatched_at, COALESCE(last_liveness_at, dispatched_at)) >= ?
           AND dispatched_at >= ?) AS anyWorking
FROM plans
WHERE workspace_id = ? AND feature_id IS NOT NULL AND feature_id != ''
  AND status = 'active' AND is_feature = 0
GROUP BY feature_id
```
Parameters change from `[cutoff, hardCapCutoff, blockedCutoff, blockedCutoff, workspaceId]` to `[cutoff, workspaceId]` (the `hardCapCutoff` parameter is also removed — see the hard cap removal above). The return type changes from `Map<string, { working: boolean; blocked: boolean }>` to `Map<string, { working: boolean }>`. Update the type annotations at lines 6465-6466 and the consumer at `KanbanProvider.ts:2075`. The feature rollup SQL also drops the `dispatched_at >= ?` hard-cap guard:

```sql
SELECT feature_id AS featureId,
       MAX(dispatched_at IS NOT NULL
           AND MAX(dispatched_at, COALESCE(last_liveness_at, dispatched_at)) >= ?) AS anyWorking
FROM plans
WHERE workspace_id = ? AND feature_id IS NOT NULL AND feature_id != ''
  AND status = 'active' AND is_feature = 0
GROUP BY feature_id
```

### 6. Remove blocked UI from `kanban.html`

**File:** `src/webview/kanban.html`

Remove:
- CSS rules for `.kanban-card.is-blocked::after` (lines 1047-1057), `.kanban-card.is-blocked .blocked-badge` (lines 1072-1082), and their theme variants (lines 1059-1094)
- The `is-blocked` class logic in `applyWorkingClass()` (lines 8466-8492) — simplify to just `is-working`
- The `isBlocked` variable and `blockedClass` in `createCardHtml()` (lines 8587-8590)
- The `blockedBadge` HTML (line 8592) and its insertion into `cardMetaContent` (lines 8593-8595)
- The `card.blocked` property read (line 8587)

The `applyWorkingClass` function simplifies to:
```js
function applyWorkingClass(cardEl, isWorking) {
    if (!cardEl) return;
    if (isWorking) {
        cardEl.classList.add('is-working');
        cardEl.setAttribute('title', 'Agent working…');
    } else {
        cardEl.classList.remove('is-working');
        cardEl.removeAttribute('title');
    }
}
```

**Also update `buildBoardSignature`** (line 7024): Remove `|${card.blocked ? '1' : '0'}` from the signature string. The signature becomes:
```js
.map(card => `${card.workspaceRoot || ''}|${card.planId || card.sessionId || ''}|${card.column}|${card.topic || ''}|${card.planFile || ''}|${card.complexity || 'Unknown'}|${card.lastActivity || ''}|${card.isFeature ? '1' : '0'}|${card.subtaskCount || 0}|${card.featureId || ''}|${card.working ? '1' : '0'}`)
```
Note: This changes the signature format. The first poll after deploy will detect a "change" on every card and trigger a one-time full board re-render. This is a cosmetic flash, not a correctness issue.

**Also update the incremental update path** (lines 9552-9559): The condition currently checks `!!nc.working !== !!cur.working || !!nc.blocked !== !!cur.blocked`. Remove the `blocked` terms:
```js
if (!!nc.working !== !!cur.working) {
    const cardEl = document.querySelector(`.kanban-card[data-plan-id="${CSS.escape(id)}"]`) || document.querySelector(`.kanban-card[data-session="${CSS.escape(id)}"]`);
    applyWorkingClass(cardEl, !!nc.working);
    cur.working = nc.working;
    cur.lastActivity = nc.lastActivity;
}
```
Remove the `cur.blocked = nc.blocked;` assignment (line 9559).

### 7. Clean up `blocked_at` references in `clearWorkingState` and `recordLiveness`

**File:** `src/services/KanbanDatabase.ts`

In `clearWorkingState` (line 9943): the `blocked_at = NULL` in the SET clause is now a no-op. Leave it to minimize the diff (harmless dead reference to a dead column).

In `recordLiveness` (line 10311): the `blocked_at = NULL` in the SET clause is also a no-op. Leave it for the same reason.

In the `toKanbanPlanRecord` mapper (line 10454): the `blockedAt` field mapping can stay (it reads a dead column that's always NULL) or be removed. Leaving it minimizes the diff and is harmless. If left, the `KanbanPlanRecord` type still has `blockedAt` — this is fine as a dead field.

### 8. Clear `dispatched_at` on column transition

**File:** `src/services/KanbanProvider.ts`

In `moveCardToColumnWithReason` (line 7588), after the column update succeeds (`outcome.ok`), if the plan had a live `dispatched_at`, clear it. This prevents the working glow from lingering on a card that's been moved to a different column.

Add after line 7616 (`if (outcome.ok) {`), before the integration sync at line 7617:
```ts
if (plan?.dispatchedAt) {
    const wsId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
    if (wsId) {
        // Clear the working state without firing the completion broadcast —
        // a column move is not a completion event. The transitioned boolean
        // is deliberately ignored.
        await db.clearWorkingState(plan.planFile, wsId);
    }
}
```

This is safe because:
- `clearWorkingState` returns `transitioned` but the caller ignores it — no completion broadcast or turn-end notifier fires.
- A new dispatch stamps a fresh `dispatched_at`, so clearing on move doesn't break the dispatch flow.
- Same-column drags don't call `moveCardToColumnWithReason` (the webview checks `moveFrom !== targetColumn` before calling).
- If the plan was not dispatched (`dispatchedAt` is null), the guard skips the call entirely — no overhead on non-dispatched cards.

### 9. Update contract tests

**File:** `src/test/terminal-plan-attribution-contract.test.js`

The test at line 283 ("the turn-end silence branch resolves the plan root with matchWorktreePath") asserts on the silence branch's existence. After removing the silence branch, the `completed` arm (mtime advance) still uses `matchWorktreePath` and `fs.promises.stat`. Update the test to assert on the `completed` arm instead of the silence branch:
- Change the substring extraction to target the `if (completed)` block (the mtime-advance path) rather than `if (silentTerminals.length > 0)`.
- Remove the assertion `branch.includes('if (!record.blockedAt)')` (line 297) — the blocked guard no longer exists.
- Keep the `matchWorktreePath` and `fs.promises.stat` assertions — they apply to the `completed` arm too.

The test at line 300 ("the silence branch cannot fire on a missing lastDataAt") asserts on the `silentTerminals` classification loop. After removing the silence branch, the classification still runs (it populates `silentTerminals`), but if the array is also removed, this test should be deleted. If the array is left (harmless dead code), the test still passes but is testing dead code — update the test name to reflect it's testing the classification guard, not the silence branch.

**File:** `src/test/orchestrator-tick-and-reports-contract.test.js`

The test at line 456 asserts the outcome→kind mapping: `info.outcome === 'completed' ? 'finished' : 'blocked'`. This mapping stays (Phone-a-Friend and `stalled` still produce `kind: 'blocked'` reports). No change needed.

The test at line 344 checks that the orchestration skill docs name `blocked` as a report kind. This stays. No change needed.

### 10. Remove `blockedTimeoutMs` from `package.json` and clean up stale comments

**File:** `package.json`

Remove the `switchboard.activityLight.blockedTimeoutMs` configuration block (lines 602-609). After steps 1 and 3, no code reads this setting. Leaving it in `package.json` means users see it in the settings UI, configure it, and nothing happens — a UX bug.

Note: Users who have explicitly set this value in their `settings.json` will see an "Unknown Configuration Setting" warning after removal. This is cosmetic and harmless — VS Code ignores unknown settings.

**Optional comment cleanup** (minimizes diff if skipped, but prevents future confusion):
- `src/services/KanbanDatabase.ts` lines 93-99: JSDoc describes `blocked_at` as having a writer — update to note the writer was removed.
- `src/services/KanbanDatabase.ts` lines 481-493: V59 migration comment describes the writer — update.
- `src/services/PlanIngestionEngine.ts` line 226: Comment references `!record.blockedAt` — update.
- `src/services/TaskViewerProvider.ts` line 1560: Comment references `!record.blockedAt` guard — update.
- `src/webview/terminals.js` line 4736: Comment references `blocked_at` — update.

## Verification Plan

### Automated Tests
1. **Contract tests**: Run `node src/test/terminal-plan-attribution-contract.test.js` — the updated silence-branch test passes (assertions now target the `completed` arm).
2. **Orchestrator contract test**: Run `node src/test/orchestrator-tick-and-reports-contract.test.js` — all tests pass unchanged (the outcome→kind mapping and report kinds are unaffected).

### Manual Verification
3. **Kanban visual**: Open the kanban board. No card shows a yellow dashed ring, "Waiting on you" badge, or `title="Agent waiting on you…"`. The green "working" glow still appears on cards with a live `dispatched_at`.
4. **Column transition clears glow**: Dispatch a plan to a coder terminal. While the glow is active, drag the card to `PLAN REVIEWED`. Verify the glow clears immediately (not after 10 minutes).
5. **Completed outcome still fires**: Dispatch a plan, let the agent write to the plan file. Verify the parent terminal receives the `[switchboard:turn-end] Seat '...' finished its turn` message.
6. **Feature nudge still fires**: Arm a feature watch, let the head go idle with un-accepted subtasks. Verify the head receives the `[switchboard:turn-end] Feature stall` nudge.
7. **Phone-a-Friend blocked still works**: Trigger a Phone-a-Friend dispatch drop (no terminal running). Verify the `blocked` report is written to `.switchboard/orchestrator/reports/` and the orchestrator (if running) receives the notification.
8. **No `blocked_at` writes**: After exercising the board, query `SELECT COUNT(*) FROM plans WHERE blocked_at IS NOT NULL` — returns 0. No code path writes to `blocked_at`.
9. **No `blockedTimeoutMs` in settings UI**: Open VS Code Settings, search for `blockedTimeoutMs` — no result. The config setting is gone.
10. **TypeScript compiles**: Run `npx tsc --noEmit` — no type errors from the `isWorkingState` return type change or the `KanbanCard` interface change.
11. **Hard cap removed**: Dispatch a plan to a coder terminal. Let the coder produce output continuously for 30+ minutes (or simulate by stamping `last_liveness_at` to recent timestamps while `dispatched_at` is old). Verify the card's working glow stays lit — it is NOT force-cleared by the 30-minute hard cap. The 10-minute silence timeout still clears a card whose terminal stops producing output for 10 minutes.

## Implementation Summary

Silence-based blocked state detection and decoration were completely removed from the codebase. The silence sweep, `_blockedCandidates`, and `setBlockedState` were removed from `PlanIngestionEngine.ts` and `KanbanDatabase.ts`, while `isWorkingState` and `getFeatureWorkingStates` were simplified to track only working state without a hard cap. In `kanban.html`, all `is-blocked` CSS rules, badges, and signature flags were stripped, and `moveCardToColumnWithReason` in `KanbanProvider.ts` now immediately clears working state on column transitions. The `switchboard.activityLight.blockedTimeoutMs` setting was removed from `package.json` and contract tests were updated accordingly.
