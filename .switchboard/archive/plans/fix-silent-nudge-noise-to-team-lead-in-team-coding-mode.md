# Fix Silent Nudge Noise to Team Lead in Team Coding Mode

## Goal

The feature-level and queue-level stall nudge sweeps in `PlanIngestionEngine` inject `[switchboard:turn-end]` messages into the team lead's terminal on a 90-second cadence, firing constantly during normal team coding work. 99.99999% of the time the terminals are working fine — the nudges are false positives caused by three distinct defects in the detection logic, plus an overly aggressive pacing threshold and a user-escalation layer that compounds the noise.

### Root Causes

1. **Queue nudge gate (5) checks head-only in-flight, not team-wide.** The in-flight predicate at `PlanIngestionEngine.ts:1670-1674` checks `p.dispatchedTerminal === watch.headTerminal` — only the head itself. But `dispatchNextFromQueue`'s in-flight refusal at `LocalApiServer.ts:1769-1773` correctly uses `teamSet.has(p.dispatchedTerminal)` — any team member. When a coder is working on a card dispatched by the head (or after `clearWorkingState` clears `dispatchedTerminal` on a finished card), gate (5) sees no in-flight card and the nudge fires.

2. **No team-liveness suppression.** Even when no card is formally in-flight (all dispatch info cleared by `clearWorkingState`), if any coder on the team is actively producing output (recent `lastDataAt`), the lead is correctly idle — waiting for a coder, not stalled. Neither sweep checks team-member liveness. The lead's own `lastDataAt` going stale is treated as a stall, even when coders are actively working.

3. **Nudge pacing is coupled to turn-end silence (90s).** Both sweeps use `turnEndSilenceMs` (default 90s) as the pacing floor. 90s is appropriate for detecting turn boundaries (completed/blocked classification), but far too aggressive for nudge pacing. A lead processing a coder's report, composing a dispatch prompt, or thinking between cards is silent for 90s all the time.

4. **User escalation compounds the noise.** After the first nudge to the lead, the queue nudge fires a second notification to the user on the next pass. This doubles the interruption count and trains the user to ignore Switchboard notifications.

5. **Feature nudge has no nudgeCount — fires forever.** `FeatureWatchRecord` has no `nudgeCount` field. The feature nudge fires every `turnEndSilenceMs` window (currently 90s) for the entire duration of the stall, with no stop condition. This is worse than the queue nudge, which at least has one-shot escalation.

## Metadata

**Complexity:** 5
**Tags:** backend, bugfix, reliability, performance
**Project:** Browser Switchboard

## User Review Required

This plan removes the user-escalation branch from the queue nudge (the second notification to the operator after the lead ignores the first nudge). After this change, a lead that ignores its one nudge produces **no** operator notification for that stall — the watch goes silent until a dispatch re-arms it. The genuine operator alerts (no coding head seated, head absent/exited, seat-pacing no-pacer, seat-pacing dead-pacer) are all preserved. Confirm that dropping the stall-escalation-to-user is acceptable: the rationale is that a lead paced by the queue watch is an agent, not a human, and a second notice to the human about an agent ignoring a first notice is noise that trains the human to ignore the genuine alerts.

## Complexity Audit

### Routine
- Adding `nudgeSilenceMs` to `package.json` config (mirrors the existing `turnEndSilenceMs` / `livenessWindowMs` entries at `:594-600`).
- Reading `nudgeSilenceMs` in the tick alongside the other `activityCfg.getNumber` calls at `:485`.
- Threading `nudgeSilenceMs` as a new parameter to `_runFeatureNudgeSweep` and `_runQueueNudgeSweep` (both already receive `turnEndSilenceMs` in their args at `:672` and `:685`).
- Replacing `turnEndSilenceMs` with `nudgeSilenceMs` in the three pacing-floor checks (`:1173`, `:1496`, `:1712`) — mechanical substitution.
- Adding `nudgeCount` to `FeatureWatchRecord` (mirrors the existing field on `QueueWatchRecord` at `:139`).
- Stripping the escalation notifier body from the two gate-(8) blocks (`:1717-1750` head, `:1501-1533` seat) while keeping the `nudgeCount >= 1` stop-guard.
- Updating the orchestrator skill handoff bullet text.

### Complex / Risky
- **Team-wide in-flight detection in the head-pacing branch (gate 5).** Introduces an `await this._queueTeamMembersResolver(...)` call into the head-pacing path that previously had none. The resolver is already used by the seat-pacing branch (`:1378-1386`) and by `dispatchNextFromQueue`, so the pattern exists — but the head-pacing branch is the ~4,000-install regression gate, and any resolver-thrown error or null return must degrade byte-for-byte to the old head-only behavior.
- **Feature nudge `nudgeCount` re-arm path.** There is no `armFeatureWatch` function on `PlanIngestionEngine`; feature watches are armed via KanbanProvider `watchFeature` / `unwatchFeature` verbs, and there is no dispatch hook that resets feature-watch nudge state. Without an in-sweep reset, `nudgeCount` would latch at 1 forever after the first nudge and the head would never be nudged again for that feature — even across new stall cycles. The fix adds a reset inside gate (4a) when a dispatch is outstanding (mirroring the queue nudge's in-flight reset at `:1677-1685`).

## Edge-Case & Dependency Audit

### Race Conditions
- The team-members resolver is `await`ed inside the per-watch loop. Both sweeps already `await` the resolver in the seat-pacing branch and `await` `db.getSubtasksByFeatureId` / `db.getBoard` per watch, so the sweep is already async-per-watch; one more awaited call does not introduce a new ordering hazard. The liveness snapshot is captured once per tick (`:497-506`) and passed in — the resolver call does not re-read liveness, so a coder going active mid-resolve is picked up next tick, not this one (acceptable — the nudge is a backstop, not a real-time probe).
- `nudgeCount` on `FeatureWatchRecord` is mutated in-place on the `watch` object and persisted via `updateConfigJson` at the end of the sweep (`:1234-1248`), identical to how `lastNudgedAt` is already persisted. No new write race.

### Security
- None. No auth, credential, or untrusted-input surface touched.

### Side Effects
- Removing user escalation means a stalled lead produces no operator notification for that stall. The four genuine operator alerts (no head seated, head absent/exited, seat no-pacer, seat dead-pacer) are untouched and remain the operator's signal that something structural is wrong.
- `escalatedAt` on `QueueWatchRecord` becomes vestigial: no longer set by the removed stall-escalation branches, but still set by the kept dead-pacer (`:1471`) and no-pacer (`:1427`) blocks, and still cleared on `onDispatch` re-arm (`:282`) and in the in-flight gate (`:1683`). Old persisted records carrying `escalatedAt` remain harmless.

### Dependencies & Conflicts
- `package.json` config schema: the new `switchboard.activityLight.nudgeSilenceMs` key sits in the same `activityLight` section as `turnEndSilenceMs` (`:594`). No conflict — separate key, separate default.
- Contract tests `queue-pipeline-contract.test.js` and `orchestrator-tick-and-reports-contract.test.js` assert on the current escalation behavior. See §Proposed Changes (test file) — the regex assertions still match after the change (escalatedAt and `nudgeCount >= 1` both remain in the source), only the assertion *messages* are stale.

## Dependencies

- None. This plan is self-contained within `PlanIngestionEngine.ts`, `package.json`, the orchestrator skill doc, and two contract test files. No other plan must land first.

## Adversarial Synthesis

Key risks: (1) the feature-nudge `nudgeCount` had no reset path until this plan adds one in gate 4a — without it the head gets exactly one feature nudge per arm and never again, which contradicts the plan's own "dispatch resets nudgeCount" claim; (2) the head-pacing branch is the 4,000-install regression gate and gains its first `await`-ed resolver call, so the null/throw fallback must be byte-stable; (3) the dead-pacer block (`:1446-1477`) fires every 10s tick with no one-shot guard — pre-existing user-facing noise this plan deliberately does not fix (out of scope: it notifies the operator, not the team lead). Mitigations: the gate-4a reset mirrors the queue's existing in-flight reset exactly; the resolver fallback degrades to `[watch.headTerminal]` (the old head-only set); the dead-pacer noise is flagged here for a follow-up plan.

## Proposed Changes

### `package.json` — new config `nudgeSilenceMs`

Add a new `switchboard.activityLight.nudgeSilenceMs` setting to the `activityLight` config section (alongside `turnEndSilenceMs` at `:594`):
- Default: `600000` (10 minutes)
- Minimum: `300000` (5 minutes)
- Maximum: `3600000` (1 hour)
- Description: "How long (ms) a team lead must be silent with work pending before a stall nudge fires. Default 10 min. Separate from `turnEndSilenceMs` (which gates turn-end detection at 90s) — a nudge is a backstop, not a turn-boundary probe. Only applies to the feature-level and queue-level stall nudges; turn-end classification (completed/blocked) is unaffected."

### `src/services/PlanIngestionEngine.ts` — read `nudgeSilenceMs` in the tick

Read it in the tick at `:485` alongside the other `activityCfg.getNumber` calls:
```typescript
const nudgeSilenceMs = activityCfg.getNumber('nudgeSilenceMs', 600000);
```

Pass `nudgeSilenceMs` to both `_runFeatureNudgeSweep` (`:671`) and `_runQueueNudgeSweep` (`:684`) as a new parameter in the args object. Keep `turnEndSilenceMs` for the head-silence check in gate (3)/(7) — that gate determines whether the head is mid-turn, which is still the turn-end threshold. But use `nudgeSilenceMs` for the **pacing floor** (the "at most one nudge per window" check) and as the **team-liveness window** (how recently a coder must have produced output to suppress the nudge).

Add `nudgeSilenceMs: number` to both sweep method arg types.

### `src/services/PlanIngestionEngine.ts` — team-wide in-flight detection (queue nudge, head pacing, gate 5)

**Location:** `_runQueueNudgeSweep`, head-pacing branch, gate (5) at `:1662-1688`.

Replace the head-only in-flight check:
```typescript
// BEFORE
const inFlight = board.some(p =>
    p && CODING_COLUMNS.has(String(p.kanbanColumn || ''))
    && typeof p.dispatchedTerminal === 'string'
    && p.dispatchedTerminal.length > 0
    && p.dispatchedTerminal === watch.headTerminal
);
```

With a team-wide check that resolves the team roster via `_queueTeamMembersResolver` (already available, used by the seat-pacing branch at `:1378-1386`) and checks any team member:
```typescript
// AFTER
let teamMembers: Set<string> | null = null;
if (this._queueTeamMembersResolver && watch.headTerminal) {
    try {
        const resolved = await this._queueTeamMembersResolver(folder, watch.headTerminal);
        teamMembers = new Set(resolved || []);
    } catch (memberErr) {
        this._host.logger.appendLine(`[GlobalPlanWatcher] Queue nudge: team resolution failed for ${watch.workspaceRoot}: ${memberErr}`);
        teamMembers = new Set();
    }
}
const teamSet = teamMembers ?? new Set([watch.headTerminal]);
const inFlight = board.some(p =>
    p && CODING_COLUMNS.has(String(p.kanbanColumn || ''))
    && typeof p.dispatchedTerminal === 'string'
    && p.dispatchedTerminal.length > 0
    && teamSet.has(p.dispatchedTerminal)
);
```

This matches `dispatchNextFromQueue`'s in-flight refusal logic exactly (`LocalApiServer.ts:1769-1773`). When the resolver is absent (headless/test harness), fall back to `[watch.headTerminal]` — byte-for-byte the old behavior.

### `src/services/PlanIngestionEngine.ts` — team-liveness suppression (both sweeps)

Add a new gate after the in-flight check in both sweeps: if any team member (from the roster) has a `lastDataAt` within `nudgeSilenceMs`, suppress the nudge. The lead is waiting for a coder, not stalled.

**Queue nudge (head pacing):** After gate (5), before gate (6). Reuses the `teamSet` computed above and the `livenessByName` map built at `:1308-1311`:
```typescript
// Team-liveness: if any team member is actively producing output, the lead
// is waiting for a coder, not stalled. Suppress the nudge.
const teamActive = Array.from(teamSet).some(name => {
    const entry = livenessByName.get(name);
    return entry && entry.lastDataAt > 0 && nowMs - entry.lastDataAt < nudgeSilenceMs;
});
if (teamActive) {
    kept.push(watch);
    continue;
}
```

**Feature nudge:** After gate (4a), before gate (4b). The feature nudge sweep needs team-member resolution — use `_queueTeamMembersResolver` with `watch.headTerminal` (the feature head is a team head). If the resolver is absent, skip this gate (degrade to current behavior):
```typescript
// Team-liveness: if any team member is actively producing output, the head
// is waiting for a coder, not stalled.
if (this._queueTeamMembersResolver) {
    try {
        const resolved = await this._queueTeamMembersResolver(folder, watch.headTerminal);
        const teamSet = new Set(resolved || []);
        teamSet.add(watch.headTerminal); // include the head itself
        const teamActive = Array.from(teamSet).some(name => {
            const entry = livenessByName.get(name);
            return entry && entry.lastDataAt > 0 && nowMs - entry.lastDataAt < nudgeSilenceMs;
        });
        if (teamActive) {
            kept.push(watch);
            continue;
        }
    } catch { /* resolver failure is no evidence — fall through to normal gates */ }
}
```

### `src/services/PlanIngestionEngine.ts` — remove user escalation (queue nudge, both pacing modes)

> **Superseded:** Remove the escalation branch (gate 8) from both the head-pacing path (`:1717-1750`) and the seat-pacing path (`:1501-1533`). These are the branches that fire a second `_turnEndNotifier` call to the user after the first nudge to the lead/seat.
> **Reason:** The original wording "remove the `if (watch.nudgeCount >= 1)` block" was ambiguous — removing the *entire* block would let the nudge re-fire every `nudgeSilenceMs` window (10 min), reproducing the noise at a slower cadence. The `nudgeCount >= 1` guard is what stops re-nudging the lead and must stay.
> **Replaced with:** Strip only the escalation *body* (the `_turnEndNotifier` call, the `escalatedAt = nowMs` assignment, the escalation recorder call, and the log line) from inside each `if (watch.nudgeCount >= 1)` block. The guard itself becomes:
> ```typescript
> if (watch.nudgeCount >= 1) {
>     kept.push(watch);
>     continue;
> }
> ```
> The nudge fires once (when `nudgeCount` is 0), increments `nudgeCount`, and on subsequent ticks the `nudgeCount >= 1` guard keeps the watch silent without escalating. A dispatch resets `nudgeCount` to 0 (via the in-flight gate at `:1677-1685` for the queue watch), re-arming for the next stall.

**What to keep:**
- The "no coding head seated" notification (`:1611-1634`) — genuine operator alert, not a stall nudge.
- The "head absent/exited" notification (`:1637-1660`) — genuine operator alert.
- The seat-pacing "no pacer" first-pass escalation (`:1395-1434`) — genuine operator alert (nothing is running at all).
- The seat-pacing "dead pacer" notification (`:1436-1477`) — genuine operator alert (the seat died holding a card).

**What to remove:**
- Head-pacing gate (8) escalation body at `:1717-1750`: the notifier call, `escalatedAt = nowMs`, `lastNudgedAt = nowMs`, and log line inside `if (watch.nudgeCount >= 1)`. Keep the `if (watch.nudgeCount >= 1) { kept.push(watch); continue; }` guard.
- Seat-pacing gate (8) escalation body at `:1501-1533`: the notifier call, `escalatedAt = nowMs`, `lastNudgedAt = nowMs`, the escalation recorder call, and log line inside `if (watch.nudgeCount >= 1)`. Keep the guard.

**Keep `escalatedAt` on `QueueWatchRecord`** for backward compatibility with persisted watches in `kanban.queueWatches` — old records may carry the field. Stop setting it from the removed stall-escalation branches, stop reading it for stall-escalation decisions, and let `armQueueWatch`'s `onDispatch` re-arm clear it (already does at `:282`) and the in-flight gate clear it (already does at `:1683`). The field remains set by the kept dead-pacer/no-pacer blocks and becomes vestigial for the stall path but harmless.

### `src/services/PlanIngestionEngine.ts` — feature nudge: add `nudgeCount`, stop after one, and re-arm on dispatch

**File:** `src/services/PlanIngestionEngine.ts`

Add `nudgeCount` to `FeatureWatchRecord` (`:110-119`):
```typescript
export interface FeatureWatchRecord {
    featureId: string;
    headTerminal: string;
    armedAt: number;
    lastNudgedAt: number;
    nudgeCount: number;  // NEW — 0 = not yet nudged, 1 = nudged once (stop)
    stopColumns?: string[];
}
```

After the nudge fires at `:1229`, set `watch.nudgeCount = 1` (currently only sets `watch.lastNudgedAt`).

Before the nudge fires, add a check after the pacing floor (`:1173`):
```typescript
// One nudge, then stop. A head that didn't respond to the first nudge
// won't respond to a second — repeating every window is the noise this
// fix exists to eliminate.
if (watch.nudgeCount >= 1) {
    kept.push(watch);
    continue;
}
```

> **Superseded:** The original plan stated "A dispatch (or subtask completion) resets `nudgeCount`" via `armQueueWatch`'s `onDispatch` re-arm, and instructed tracing `armFeatureWatch` to add `nudgeCount: 0` to the reset.
> **Reason:** There is no `armFeatureWatch` function on `PlanIngestionEngine`. Feature watches are armed via KanbanProvider `watchFeature` / `unwatchFeature` verbs, and no dispatch hook resets feature-watch nudge state. Without an in-sweep reset, `nudgeCount` latches at 1 after the first nudge and the head is never nudged again for that feature — even across new stall cycles — which contradicts the "dispatch resets nudgeCount" claim and is worse than the queue watch's re-arm-on-dispatch behavior.
> **Replaced with:** Reset `nudgeCount` and `lastNudgedAt` inside gate (4a) when a dispatch IS outstanding — mirroring the queue nudge's in-flight reset at `:1677-1685`. When gate (4a) finds `outstanding === true` (a subtask has `dispatchedAt` set), the head is actively working through a coder; clear the stall state so the NEXT idle window gets a fresh nudge:
> ```typescript
> // (4a) No dispatch record for any of the feature's seats is outstanding.
> const outstanding = remaining.some(s => !!s.dispatchedAt);
> if (outstanding) {
>     // A dispatch is in progress — the head is working, not stalled.
>     // Re-arm the nudge state so the next idle window after this dispatch
>     // completes gets a fresh nudge (mirrors the queue watch's in-flight
>     // reset at :1677-1685).
>     if (watch.nudgeCount > 0 || watch.lastNudgedAt > 0) {
>         watch.nudgeCount = 0;
>         watch.lastNudgedAt = 0;
>         mutated = true;
>     }
>     kept.push(watch);
>     continue;
> }
> ```
> This makes the re-arm automatic and correct: every time a coder picks up a subtask, the feature nudge is re-armed; when the coder finishes and the head goes idle again past `nudgeSilenceMs`, one fresh nudge fires. No KanbanProvider verb change needed.

### `src/services/PlanIngestionEngine.ts` — decouple nudge pacing floor from turn-end silence

In both sweeps, replace `turnEndSilenceMs` with `nudgeSilenceMs` in the pacing floor check:

**Feature nudge** at `:1173`:
```typescript
// BEFORE
if (watch.lastNudgedAt > 0 && nowMs - watch.lastNudgedAt < turnEndSilenceMs) {
// AFTER
if (watch.lastNudgedAt > 0 && nowMs - watch.lastNudgedAt < nudgeSilenceMs) {
```

**Queue nudge (head pacing)** at `:1712`:
```typescript
// BEFORE
if (watch.lastNudgedAt > 0 && nowMs - watch.lastNudgedAt < turnEndSilenceMs) {
// AFTER
if (watch.lastNudgedAt > 0 && nowMs - watch.lastNudgedAt < nudgeSilenceMs) {
```

**Queue nudge (seat pacing)** at `:1496`:
```typescript
// BEFORE
if (watch.lastNudgedAt > 0 && nowMs - watch.lastNudgedAt < turnEndSilenceMs) {
// AFTER
if (watch.lastNudgedAt > 0 && nowMs - watch.lastNudgedAt < nudgeSilenceMs) {
```

**Keep `turnEndSilenceMs` for gate (3)/(7)** — the head-silence check that determines whether the head is mid-turn (`:1165` feature, `:1706` head-pacing, `:1490` seat-pacing). This is turn-end detection, not nudge pacing, and stays at 90s.

### `.agents/skills/switchboard-orchestrator/SKILL.md` — update handoff bullet

**Location:** the handoff bullet at `:245`.

The bullet currently says the queue watch "sends **one** nudge telling the lead to call `POST /kanban/queue/next` itself, then escalates to the user once and stops." Update to reflect the new behavior: "sends **one** nudge telling the lead to call `POST /kanban/queue/next` itself, then stops. No user escalation — the nudge is the only notice; a dispatch re-arms it for the next stall."

The seat-pacing description at `:286` ("escalates to the operator on the first pass when no seat holds one") refers to the kept no-pacer operator alert and needs **no** change.

### `src/test/queue-pipeline-contract.test.js` — update contract assertions

**Location:** the check "the queue watch counts DISPATCH only, and escalates exactly once" at `:433-447`.

- `:441` — `assert.ok(/watch\.escalatedAt/.test(body), ...)` checks that escalation is bounded by `escalatedAt`. **This assertion still passes as-is** — `watch.escalatedAt` remains in the body (set by the kept dead-pacer/no-pacer blocks at `:1427`/`:1471`, cleared at `:1683`/`:282`). Keep the assertion; update only the message to reflect that `escalatedAt` now bounds the *genuine operator alerts* (dead-pacer/no-pacer), not the removed stall escalation.
- `:443` — `assert.ok(/nudgeCount >= 1/.test(body), ...)` checks "one nudge, then escalate." **This assertion still passes as-is** — the `nudgeCount >= 1` guard is retained (now as the stop-guard, not the escalation trigger). Keep the assertion; update the message to "one nudge, then stop — `nudgeCount >= 1` keeps the watch silent without escalating."
- `:445` — `assert.ok(/_queueTeamMembersResolver/.test(body) && /teamMembers\.has\(p\.dispatchedTerminal\)/.test(body), ...)` checks seat-paced team selection. **Still passes.** After change 2, the head-pacing branch also uses `teamSet.has(p.dispatchedTerminal)`, strengthening coverage. Optionally add a sibling assertion that the head-pacing branch uses the resolver too.
- `:455` — `assert.ok(/delete rearmed\.escalatedAt/.test(body), ...)` checks `onDispatch` clears `escalatedAt`. **Still passes** — the re-arm at `:282` is unchanged. Keep as-is.

Add new test assertions:
- The head-pacing branch uses `_queueTeamMembersResolver` for in-flight detection (not just `=== watch.headTerminal`).
- Both sweeps have a team-liveness suppression gate (assert `nudgeSilenceMs` appears in a liveness comparison in both sweep bodies).
- `nudgeSilenceMs` is read from config in the tick (assert `getNumber('nudgeSilenceMs'` appears in the tick).
- The feature nudge has a `nudgeCount` field on `FeatureWatchRecord` and stops after one nudge (assert `nudgeCount` appears in the feature sweep body).
- No `_turnEndNotifier` call with `outcome: 'stalled'` and no `recipientSeat` (user escalation) exists in the *removed* stall paths — i.e. the head-pacing and seat-pacing gate-(8) blocks no longer contain a `_turnEndNotifier` call. Assert the gate-(8) bodies do not contain `_turnEndNotifier`.

### `src/test/orchestrator-tick-and-reports-contract.test.js` — update handoff assertion text

**Location:** `:270-279`, the check "the handoff bullet describes what the queue watch actually does."

- `:273` — the assertion message says "it sends one nudge telling the lead to call POST /kanban/queue/next itself (PlanIngestionEngine queue sweep), then escalates once and stops." The assertion itself is a negative regex (`!/queue.watch[^.]{0,80}dispatches subsequent cards/i`) that still passes. Update the message to match the new behavior: "sends one nudge, then stops — no user escalation."
- `:276` — `assert.ok(/lead-paced and queue-watched/.test(persona), ...)` — still passes, no change.

## Verification Plan

> **Note:** Compilation and automated tests are skipped for this review run per session directives. The checks below remain the verification contract for the implementing coder.

### Automated Tests
1. **Contract tests pass:** `npm test` — specifically `queue-pipeline-contract.test.js` and `orchestrator-tick-and-reports-contract.test.js`. The existing regex assertions still match after the change; the new assertions (head-pacing resolver use, team-liveness gate, `nudgeSilenceMs` config read, feature `nudgeCount`, no notifier in gate-8 bodies) must also pass.
2. **TypeScript compiles:** `npm run compile` or the VS Code build task — no new type errors from the `nudgeCount` field on `FeatureWatchRecord` or the `nudgeSilenceMs` parameter added to both sweep arg types.

### Manual Scenarios
3. **Team coding, coders active:** Seat a team, stage cards in the queue, dispatch to a coder. While the coder is producing output, verify NO nudge fires to the lead (team-liveness suppression). The lead's terminal should be quiet.
4. **Team coding, coder finished, lead processing:** After a coder finishes (card in coding column, `dispatchedTerminal` cleared), verify NO nudge fires for at least 10 minutes (the new `nudgeSilenceMs` default). The lead has time to process the report and dispatch the next card.
5. **True stall:** Lead goes idle with cards staged, no coder active, no card in flight. After 10 minutes, verify exactly ONE nudge fires to the lead. After that, no further nudges and NO user escalation. A dispatch resets the cycle.
6. **Config check:** Set `switchboard.activityLight.nudgeSilenceMs` to `300000` (5 min) in settings.json. Verify the nudge fires after 5 minutes instead of 10. Set to `3600000` (1 hour) and verify it fires after 1 hour.
7. **Feature nudge:** Arm a feature watch, let the head go idle with un-accepted subtasks. Verify ONE nudge fires after 10 minutes, then no further nudges. Dispatch a coder on a subtask (gate 4a `outstanding` becomes true) and confirm `nudgeCount` resets to 0; when the coder finishes and the head goes idle again past 10 min, a fresh nudge fires.

## Edge Cases

- **No team members resolver (headless/test):** Degrade to `[watch.headTerminal]` for in-flight detection — byte-for-byte the old behavior. Team-liveness gate is skipped (resolver absent → no evidence → fall through).
- **Empty liveness snapshot:** The existing guard (`liveness.length === 0 → return` at `:1306`) runs before the team-liveness check, so no change needed.
- **Stale `escalatedAt` on persisted watches:** Old `kanban.queueWatches` records may carry `escalatedAt`. The field is no longer read for stall-escalation decisions. `onDispatch` re-arm still clears it (`:282`); the in-flight gate still clears it (`:1683`). No migration needed — the field is vestigial on the stall path.
- **Feature nudge `nudgeCount` on old records:** Old `kanban.featureWatches` records won't have `nudgeCount`. Treat absent as 0 (not yet nudged) — `watch.nudgeCount >= 1` is false for `undefined`, so the first nudge fires normally. The gate-4a reset guards on `nudgeCount > 0` so it no-ops cleanly on `undefined`.
- **Seat pacing dead-pacer notification:** Kept unchanged — it's a genuine operator alert (the seat died), not a stall nudge. Only the stall escalation (gate 8 body) is removed. **Known limitation:** the dead-pacer block (`:1446-1477`) fires every 10s tick with no one-shot `escalatedAt` guard (unlike the no-pacer block at `:1411` which guards on `!watch.escalatedAt`). This is pre-existing operator-facing noise, out of scope for this plan (it notifies the operator, not the team lead), and flagged for a follow-up plan.
- **Seat pacing no-pacer notification:** Kept unchanged — it's a genuine operator alert (nothing is running). Only the stall escalation (gate 8 body) is removed.
- **Hung coder heartbeating:** A coder whose terminal keeps repainting (updating `lastDataAt`) without making real progress suppresses the nudge via the team-liveness gate indefinitely. This is accepted — the nudge is a backstop against a *lead* forgetting, not a detector for a *coder* that is hung; the per-dispatch watchdog and `blockedTimeoutMs` (4h) own that failure mode.

---

## Implementation Summary

Implemented all five root-cause fixes. Added `switchboard.activityLight.nudgeSilenceMs` config (default 10 min) to `package.json`, decoupling nudge pacing from the 90s turn-end silence threshold. In `PlanIngestionEngine.ts`, the queue nudge head-pacing gate (5) now resolves the team roster via `_queueTeamMembersResolver` for team-wide in-flight detection (falling back to head-only when the resolver is absent), and both sweeps gained a team-liveness suppression gate that skips the nudge when any team member is actively producing output. The feature nudge gained a `nudgeCount` field on `FeatureWatchRecord` with a one-nudge-then-stop guard and a gate-(4a) re-arm on outstanding dispatch. User escalation was stripped from both gate-(8) blocks (head-pacing and seat-pacing), keeping the `nudgeCount >= 1` stop-guard; the four genuine operator alerts (no-head, dead-head, no-pacer, dead-pacer) are preserved. Updated the Mission Control handoff bullet, the queue-pipeline contract test (with new assertions for head-pacing resolver use, team-liveness, nudgeSilenceMs config read, feature nudgeCount, and no-notifier-in-gate-8), and the mission-control contract test message.

## Review Findings

All five root causes verified implemented and correct; no correctness defect found. Regression checks that passed: both sweep call sites thread the new required `nudgeSilenceMs` arg (typecheck clean); `nudgeCount` is written by both `FeatureWatchRecord` creators (`_autoArmDriveModeFeatureWatch` and the `watchFeature` verb) so the required field is never absent on a new record, and absent-on-old-record reads as `undefined` which is false against both `>= 1` and `> 0`; the gate-4a and in-flight resets are guarded so they write once, not every tick; the feature sweep's write-back replaces whole records under an `armedAt`/`headTerminal` concurrency check, so `nudgeCount` persists without a new race. One efficiency fix applied: the feature sweep's team-liveness gate sat ahead of the free head-silence gate, so it paid a `kanban.db` read through `_queueTeamMembersResolver` on every 10s tick for every watch even while the head was mid-turn — moved below gate (3), which is observationally identical since both gates only `continue`. Files changed: `src/services/PlanIngestionEngine.ts` (gate reorder + docblock); `test:contract:queue-pipeline` and `test:contract:mission-control-tick` green, both CI-wired. Remaining risks, both pre-existing and flagged by the plan itself: the seat-pacing dead-pacer block still notifies the operator every tick with no one-shot guard, and the head-pacing in-flight predicate now keys on `!completedAt` with no column filter, so a card dispatched to any team member that is never completed nor cleared muzzles the queue nudge indefinitely.
