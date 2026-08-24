# Kanban queue/done completion post does not relay to the team lead

## Goal

When a team member finishes a dispatched card and POSTs `/kanban/queue/done`, the team lead must receive a completion message. Today the POST succeeds (`{"success":true}`), the handler releases the latch, clears the terminal, and pops the next card — but **sends nothing to the lead**. The lead never learns the member finished.

The file-based team queue path (`_handleTeamQueueDone`) already does this correctly — it explicitly resolves the head from the registered group and sends a relay via `terminalVerb` (lines 4200–4214). The kanban path (`_runQueueDone`) never got the same relay.

### Problem Analysis

**Evidence from testing.** The user pasted an implementation prompt to the team lead. The lead dispatched work to a member. The member finished and produced this terminal output:

```
Yes, finished. /kanban/queue/done already POSTed (success). Reporting to Coding now.
$ curl -s -X POST http://127.0.0.1:56216/terminals/verb/ptySendPrompt ...
  '{"name":"Coding","data":"COMPLETION REPORT ...","clearBeforePrompt":false}'
```

The `queue/done` POST succeeded. The lead got nothing. The member also sent a `ptySendPrompt` to "Coding" — a wrong recipient (separate issue, see below).

**Why `queue/done` sends nothing to the lead.** The kanban `_runQueueDone` handler (`LocalApiServer.ts:2179`) was designed as a headless "release → clear → pop" pipeline. Its own docstring says "No head, no clock, no review hop" (line 2076). After releasing the latch, it fires two callbacks:

1. `onWorkingStateCleared` (line 2269) — broadcasts agent completion to the webview/activity light.
2. `onTurnEndNotify` (line 2274) — calls `notifyTurnEnd` in `TaskViewerProvider.ts:1780`.

Neither sends a message to the team lead. `notifyTurnEnd` is a **Mission Control notification path**, not a team-lead relay. Its recipient resolution (`TaskViewerProvider.ts:1842–1864`) walks the seat's `parentInstanceId` in the pty fleet, then falls back to the adopted Mission Control seat, then to a role scan for `'mission-control'`. It was never designed to deliver to the team head, and it fails silently in several real scenarios:

- **Head not active:** The active-status pre-check at line 1888 silently skips delivery when the head terminal is not `'active'` at the instant of the check.
- **Unparented/shared members:** `resolveTeamScopedRoleTerminal`'s own comment (`teamWiring.ts:2932–2933`) notes that `scope: 'shared'` members are "unparented and therefore invisible to any `parentInstanceId`-based lookup."
- **No pty host:** If `this._ptyHostPort` is falsy (line 1815), `notifyTurnEnd` returns early after writing a Mission Control report file — which nothing reads without an orchestrator present.
- **Mission Control fallback overrides:** If the parent chain doesn't resolve, the adopted Mission Control seat or a `'mission-control'` role terminal receives the message instead of the team head.

**The file-based handler already does it right.** `_handleTeamQueueDone` (`LocalApiServer.ts:4145`) explicitly resolves the head from the registered group (`teamHeadName(group)`, line 4186) and sends a relay message via `terminalVerb('ptySendPrompt', ...)` (lines 4200–4214). The relay runs BEFORE the clear-and-dispatch steps, so the lead always sees the report even if dispatch fails. The kanban path never got this relay.

**The `ptySendPrompt` to "Coding" is a separate symptom.** The default team prompt installed by `wireSpawnedTeam` (`teamWiring.ts:2010–2012`) includes `AGENT_GROUP_CALLBACK_INSTRUCTION` with `{child}` substituted to `headName`. The member follows this instruction and sends `ptySendPrompt` to whatever name was baked in at install time. If the head name was "Coding" at spawn, or a stale order persisted from a prior spawn (the `!teamExists` guard at line 2127 skips re-installation), the member sends to the wrong terminal. This is a real bug but it's secondary — the `queue/done` POST should be the authoritative relay path, and it's completely silent.

### Root Cause

The kanban `_runQueueDone` handler was modeled as a headless pipeline with no team-lead awareness. It delegates notification to `notifyTurnEnd` — a Mission Control path whose recipient resolution was never designed to reach the team head. The file-based handler's explicit relay pattern (resolve head from registered group, send via `terminalVerb`) was never ported to the kanban path.

## Metadata

**Complexity:** 4
**Tags:** backend, bugfix, reliability
**Project:** Browser Switchboard

## User Review Required

No — the fix is a straight port of the file-based handler's proven relay pattern into the kanban handler. No design decisions require a human eye. The seat→group resolution (`_resolveTeamGroupForSeat`) is new but follows the existing `_resolveRegisteredTeamGroup` pattern exactly.

## Complexity Audit

### Routine

- **Reading terminal groups from the DB**: `_runQueueDone` already has `this._options.getKanbanDatabase`, and `_resolveRegisteredTeamGroup` (line 3944) shows the exact pattern — read `TERMINALS_GROUPS_KEY` and `'terminals.groups'` from `db.getConfigJson`, deduplicate by `id`.
- **Resolving the team head**: `teamHeadName(group)` (imported at line 25) returns the declared head name from the group's `head` field. Already used by `_handleTeamQueueDone` at line 4186.
- **Sending the relay**: `this._options.terminalVerb('ptySendPrompt', { name: headName, data: relayMsg, clearBeforePrompt: false, standingOrders: false }, workspaceRoot)` — the exact call at lines 4205–4210 in the file-based handler. `terminalVerb` is already available in `_runQueueDone`'s scope (used for the dispatch step).
- **Best-effort error handling**: wrap in try/catch, log on failure, do not abort the pop — the same pattern as the file-based handler (lines 4211–4213).

### Complex / Risky

- **Resolving the group from a seat name (not a group ID)**: `_runQueueDone` receives `from` (the seat name), not a `groupId`. Unlike `_handleTeamQueueDone` which receives `groupId` from the URL, the kanban handler must scan all registered groups to find the one whose `order` or `members` array contains `from`. This is a new lookup, but it is a simple array scan over the same groups array `_resolveRegisteredTeamGroup` already reads. A seat not in any group (standalone agent) returns `null` — the relay is skipped, which is correct (standalone agents have no head).
- **Double-notification with `notifyTurnEnd`**: After the fix, the lead receives the explicit relay from `_runQueueDone` AND potentially the `notifyTurnEnd` message (if its parent-chain walk happens to resolve to the head). These have different content and different purposes (relay = "member X finished, here's what's next"; turn-end = "seat X finished its turn on plan Y"). The redundancy is acceptable — the relay is the authoritative team-lead notification; `notifyTurnEnd` continues serving Mission Control. If double-delivery becomes noisy, a follow-up can gate `onTurnEndNotify` to skip when the explicit relay succeeded.
- **Relay ordering**: The relay must run BEFORE the clear-and-pop steps (same as the file-based handler at line 4193). Placing it after the clear risks the head's terminal being cleared before the relay arrives; placing it after the pop risks the next dispatch overwriting the head's context before the relay is read. The file-based handler's ordering (relay → clear → pop) is the proven sequence.
- **Standalone agents**: A standalone agent (not on any team) POSTs `queue/done` via `GLOBAL_QUEUE_DONE_ORDER_BODY`. It has no team head. The group scan returns `null`, the relay is skipped, and `notifyTurnEnd` continues to handle whatever notification is appropriate. This is correct — the relay is team-scoped.

## Edge-Case & Dependency Audit

**Migration.** The relay is additive — a new message that was previously silent. No stored state changes shape. Users whose team leads were unaware of completions will now see relay messages, which is the intended behaviour. No migration needed.

**Security.** Neutral. The relay uses the existing `terminalVerb` seam with the same `ptySendPrompt` call the file-based handler already makes. No new endpoints, no new auth surface. The relay message is agent-facing text rendered as text.

**Side effects.** Team leads will start receiving completion messages they were not receiving before. This is the fix. The `notifyTurnEnd` path continues to fire independently; if both deliver to the head, the lead sees two messages with different content. This is acceptable and can be refined later if noisy.

**Ordering.** No dependencies on other plans. The fix is self-contained within `_runQueueDone`. The `context-aware-completion-reporting.md` plan (which unifies the standing orders) is orthogonal — it changes which order text is installed, not how `_runQueueDone` handles the POST.

**Race conditions.** The relay runs inside the `_queueNextChain` critical section (same as the rest of `_runQueueDone`), so it serializes with dispatches. The `terminalVerb` call is async but the chain awaits it before proceeding to clear-and-pop. No new race surface.

## Dependencies

None. The fix is self-contained within `_runQueueDone` in `LocalApiServer.ts`. The `context-aware-completion-reporting.md` plan (which unifies standing-order text) is orthogonal — it changes which order text is installed, not how `_runQueueDone` handles the POST.

## Adversarial Synthesis

Key risk: the relay depends on `teamHeadName(group)` resolving a live head terminal — if the head terminal is inactive, the `ptySendPrompt` call is made but may not be received. Mitigation: the call is best-effort (logged, non-fatal), and unlike `notifyTurnEnd` it does NOT gate on active-status — so it attempts delivery in every case where `notifyTurnEnd` silently skips. The relay runs before clear-and-pop inside the `_queueNextChain` critical section, so it serializes correctly with dispatches. The seat→group scan (`_resolveTeamGroupForSeat`) is O(groups × roster) per completion — negligible for team counts in the single digits.

## Proposed Changes

### `src/services/LocalApiServer.ts` — add explicit team-lead relay in `_runQueueDone`

**Context**: After the latch release and completion callbacks (lines 2268–2287), BEFORE the terminal clear (line 2304), add an explicit relay to the team lead — mirroring `_handleTeamQueueDone`'s relay at lines 4193–4214.

**New helper** — resolve the registered team group containing a seat name:

```typescript
/**
 * Find the registered terminal group whose roster contains `seatName`.
 * Scans both TERMINALS_GROUPS_KEY and the legacy 'terminals.groups' key,
 * deduplicating by id (same pattern as _resolveRegisteredTeamGroup).
 * Returns the group object or null when the seat is not on any team
 * (standalone agent — no head to relay to).
 */
private async _resolveTeamGroupForSeat(
    workspaceRoot: string,
    seatName: string
): Promise<any | null> {
    if (!seatName) { return null; }
    const db = await this._options.getKanbanDatabase?.(workspaceRoot);
    if (!db) { return null; }
    const groups: any[] = [];
    for (const key of [TERMINALS_GROUPS_KEY, 'terminals.groups']) {
        try {
            const raw = await db.getConfigJson(key, []);
            if (!Array.isArray(raw)) { continue; }
            for (const group of raw) {
                if (group && typeof group.id === 'string'
                    && !groups.some(existing => existing.id === group.id)) {
                    groups.push(group);
                }
            }
        } catch { /* best effort */ }
    }
    return groups.find(g => {
        if (!g || typeof g !== 'object') { return false; }
        const roster: string[] = Array.isArray(g.order) && g.order.length
            ? g.order
            : (Array.isArray(g.members) ? g.members : []);
        return roster.includes(seatName);
    }) || null;
}
```

**Relay insertion** — inside `_runQueueDone`, after the `onTurnEndNotify` block (line 2287) and before the terminal clear (line 2290):

```typescript
// ── Relay the completion to the team lead ────────────────
// BEFORE the clear-and-pop steps, so the lead always sees
// the report even if the dispatch step fails. Mirrors the
// file-based _handleTeamQueueDone relay (lines 4193–4214).
// Best-effort: a relay failure is logged and does NOT abort
// the pop. A standalone agent (no team group) skips the relay
// — notifyTurnEnd handles whatever notification is appropriate.
if (outcome === 'finished') {
    try {
        const group = await this._resolveTeamGroupForSeat(workspaceRoot, from);
        const headName = group ? teamHeadName(group) : undefined;
        if (headName && this._options.terminalVerb) {
            const relayMsg = `[queue/done] ${from} reports its dispatched task complete`
                + (planId ? ` (plan ${planId})` : '')
                + `. The system is clearing ${from} and dispatching the next card.`
                + (held?.featureId ? ` Feature ${held.featureId} may be ready for review — check if all subtasks are coded.` : '');
            try {
                await this._options.terminalVerb('ptySendPrompt', {
                    name: headName,
                    data: relayMsg,
                    clearBeforePrompt: false,
                    standingOrders: false,
                }, workspaceRoot);
            } catch (relayErr) {
                console.warn('[LocalApiServer] queue/done relay to team lead failed:', relayErr);
            }
        }
    } catch (groupErr) {
        console.warn('[LocalApiServer] queue/done team group resolution failed:', groupErr);
    }
}
```

**Why `standingOrders: false`**: A relay is not a task dispatch — appending the lead's standing-orders block is pure inflation on the relay path. This matches the file-based handler's call at line 4209.

**Why `clearBeforePrompt: false`**: The relay must not reset the lead's context. The lead may be mid-reasoning about another subtask; clearing would destroy that context. This matches the file-based handler's call at line 4208.

**Why gated on `outcome === 'finished'`**: A `failed` report is a release, not a completion. The escalation ladder (lines 2317+) handles failures — re-staging to a stronger seat or parking. Relaying "member finished" to the lead for a failure would mislead the lead into advancing a card nobody completed. This matches the `onTurnEndNotify` gate at line 2268.

**Why `teamHeadName(group)` instead of `parentInstanceId` walk**: The registered group's `head` field is the authoritative head name — it's what `wireSpawnedTeam` stamps and what `_handleTeamQueueDone` reads. It does not depend on pty fleet parent-child relationships, which can be stale, missing for shared members, or point to Mission Control instead of the team head.

### No changes to `notifyTurnEnd`

`notifyTurnEnd` continues to serve its Mission Control purpose — writing report files and delivering live notifications to the Mission Control/orchestrator. The explicit relay is additive: it fills the gap for team leads that `notifyTurnEnd` was never designed to cover. If double-delivery becomes a concern in practice, a follow-up can gate `onTurnEndNotify` to skip when the explicit relay succeeded, but that is not required for this fix.

## Verification Plan

### Goal Invariants

- A team member's `POST /kanban/queue/done` delivers a completion message to the team lead's terminal.
- The relay runs before the terminal clear and pop, so the lead sees the report even if dispatch fails.
- A standalone agent's `queue/done` (no team group) does not attempt a relay — no head to send to.
- A `failed` outcome does not relay a "finished" message to the lead.
- The relay is best-effort: a `terminalVerb` failure is logged, not fatal — the pop still proceeds.
- The head name is resolved from the registered group's `head` field, not from the pty fleet's `parentInstanceId` chain.

### Automated Tests

- **Team member completion relays to lead**: set up a registered team group with head `H` and member `M`; dispatch a card to `M`; POST `/kanban/queue/done` with `{"from":"M"}`; assert `terminalVerb` was called with `ptySendPrompt`, `name: "H"`, `clearBeforePrompt: false`, `standingOrders: false`, and a message containing `M reports its dispatched task complete`.
- **Relay runs before clear and pop**: same setup; assert the `ptySendPrompt` relay call precedes the `clearTerminalContext` call and the pop dispatch (verify call order via a mock that records invocation sequence).
- **Standalone agent skips relay**: POST `queue/done` with a `from` name not in any registered group; assert `terminalVerb` was NOT called with `ptySendPrompt` for a relay (the pop may still dispatch to the same seat, which is a separate call).
- **Failed outcome skips relay**: POST `queue/done` with `{"from":"M","outcome":"failed"}`; assert no relay `ptySendPrompt` call was made (the escalation ladder runs instead).
- **Relay failure does not abort pop**: mock `terminalVerb` to throw on the relay call; assert the terminal is still cleared and the pop still runs (verify `clearTerminalContext` was called and the response includes `dispatched` or `queue empty`).
- **Head name resolved from group, not parent chain**: register a team where the head's `parentInstanceId` does NOT point to a Mission Control; POST `queue/done` from a member; assert the relay targets the group's declared `head` field, not a Mission Control terminal.

### Manual Verification

- Start a team with a lead and a coder. Dispatch a card to the coder via the kanban queue. Wait for the coder to POST `queue/done`. Confirm the lead's terminal shows the relay message (`[queue/done] <coder> reports its dispatched task complete...`) before the next card is dispatched.
- Repeat with the lead terminal in a non-active state (e.g., between turns). Confirm the relay still attempts delivery (the `terminalVerb` call is made regardless of active status — unlike `notifyTurnEnd`'s active-status pre-check).

## Implementation Summary

Added `_resolveTeamGroupForSeat` helper (mirrors `_resolveRegisteredTeamGroup`'s group-reading pattern but scans rosters for a seat name instead of matching by groupId). Inserted an explicit team-lead relay block into `_runQueueDone` in `LocalApiServer.ts`, placed after the `onTurnEndNotify` callback block and before the terminal clear — the same relay-then-act ordering the file-based `_handleTeamQueueDone` uses. The relay is gated on `outcome === 'finished'`, resolves the head via `teamHeadName(group)` (not the pty fleet parent chain), sends via `terminalVerb('ptySendPrompt', ...)` with `clearBeforePrompt: false` and `standingOrders: false`, and is fully best-effort (logged, non-fatal). Standalone agents (no team group) skip the relay. `notifyTurnEnd` is left untouched — it continues serving Mission Control.

## Review Findings

Three MAJOR defects fixed in `src/services/LocalApiServer.ts`: the relay had no `headName !== from` guard, so a head posting its own `queue/done` (routine — seat pacing installs the order at `team-head` scope and the head is `order[0]` of its own roster) prompted itself moments before being cleared; it fired `ptySendPrompt` at `externalHead` groups whose head owns no pty seat (a dead click the `EXTERNAL_HEAD_CALLBACK_INSTRUCTION` reports-inbox path already covers); and it keyed the message off the *request's* optional `planId` rather than `held.planId`, so the shipped standing orders (which POST `{"from":"<seat>"}` with no planId) told the lead only that "somebody finished something". Also added a `{success:false}` response check (`ptySendPrompt` never throws on a dead recipient) and collapsed the group-config read duplicated between `_resolveRegisteredTeamGroup` and `_resolveTeamGroupForSeat` into one `_readRegisteredTeamGroups`. The plan named six automated tests and none were written — added `src/test/queue-done-lead-relay-contract.test.js` (9 checks, verified to fail against the pre-fix logic) and wired `test:contract:queue-done-relay` into `package.json` and `.github/workflows/integration-tests.yml`. Validation: `npm run compile-tests` clean, eslint 0 errors, and `queue-pipeline` / `external-headed-team` / `completion-asserted-never-inferred` / `terminal-groups-key` / `terminal-groups-headrole` / `mission-control-tick` all green; `stage-marker-commit` (2) and `team-scoped-role-routing` (1) fail at HEAD from other agents' in-flight work in `KanbanProvider.ts` / `teamWiring.ts`, both unmodified here. Remaining risk, deferred as the plan decided: `notifyTurnEnd`'s `parentInstanceId` walk also resolves to the head for spawned teams, so the lead receives two back-to-back prompts with different content.
