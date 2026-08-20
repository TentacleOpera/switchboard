# Kanban Queue Dispatch Without a Team

## Goal
Make the kanban DISPATCH column's queue dispatch work with any agent group — the general-purpose grid, not just spawned teams. Today the "Run queue" button, `POST /kanban/queue/next`, and `POST /kanban/queue/done` all require `from` to resolve to a registered team roster or they fail. The user's expected flow is:

1. Stage cards in Dispatch
2. Click Run
3. System sends first card to the appropriate agent (complexity routing, no team needed)
4. Agent finishes, posts completion
5. System sends next card

No team, no head, no pacing toggle, no roster resolution. Just: queue → route → complete → next.

## The problem, and the root cause
The queue dispatch system (`dispatchNextFromQueue`, `_runQueuePop`, `_runQueueDone`) was built as a team feature — subtask 1 of the "Team Queue: Completion-Driven Dispatch" plan. Every layer assumes a team:

1. **The UI button** (kanban.html:7729) is disabled when `!lastCodingHeadLive` — `codingHeadLive` is derived from `resolveCodingRolesFromGroups`, which reads `terminals.groups` and only finds heads of registered team groups. A standalone coder terminal not in any group is invisible.

2. **The `runQueue` handler** (KanbanProvider.ts:12061) calls `resolveCodingHeadFromGroups` to find `from` — the same function, same limitation. If no team head is found, it errors: "No coding head is live. Seat a coding team first."

3. **The pop** (`_runQueuePop`, LocalApiServer.ts:1724) calls `resolveTeamMembers` to get the roster. If the resolver returns null/empty, it 400s: "from does not resolve to a live team." There is no fallback to workspace-wide routing.

4. **The in-flight check** (LocalApiServer.ts:1755-1771) scans for cards held by any member of the team roster. Without a roster, it cannot determine if the "team" is busy.

5. **The completion path** (`_runQueueDone`, LocalApiServer.ts:2049) uses the same roster to find the in-flight card. Without a roster, it finds the card by `dispatchedTerminal === from` only — which works for a single terminal but not for a group.

6. **The standing order** (`SEAT_QUEUE_DONE_ORDER_BODY`, teamWiring.ts:154) is installed per team via `applySeatPacingOrders`. A standalone agent not on any team never receives the order and never knows to POST `queue/done`.

The fix is to add a fallback path at each layer: when `from` does not resolve to a team, use workspace-wide routing and terminal-level in-flight detection instead of team-scoped routing and roster-level in-flight detection.

## Metadata
- **Tags:** backend, frontend, api, bugfix, reliability
- **Complexity:** 6

## User Review Required
No — the fix makes an existing feature work the way the user originally expected. No new product decisions.

## Complexity Audit

### Routine
- Enabling the "Run queue" button when any coding terminal is live (not just team heads) — one condition change in kanban.html + one new flag in the board state payload.
- Removing the 400 in `_runQueuePop` when `from` doesn't resolve to a team — replace with a fallback to workspace-wide routing.
- The `_runQueueDone` path — already works by terminal name (`dispatchedTerminal === from`), no change needed.

### Complex / Risky
- The in-flight check: today it scans for cards held by any team member. Without a team, the check must be skipped (same as the seat-paced path). The completion POST is the single trigger — serialized on `_queueNextChain` — so there is no race to arbitrate. Skipping loses the user-facing 409 ("team already in flight"), but a second Run click would pop the next queued card (not re-dispatch the same card), which is acceptable and matches seat-paced behavior.
- The completion standing order: `SEAT_QUEUE_DONE_ORDER_BODY` is team-scoped. A standalone agent needs the same instruction. The standing orders system supports `global` scope (applies to all terminals), which is the correct scope for a workspace-wide order — `global` is harmless to non-coding terminals (they have no dispatched card to complete) and redundant (not conflicting) for team agents who already have the team-scoped order.
- The `runQueue` handler's `from` resolution: `resolveCodingHeadFromGroups` only finds team heads. Need a fallback to a new resolver that reads from the in-memory `_terminalAgentInfo` cache (populated at terminal creation time, workspace-agnostic) cross-referenced with `getFleetLiveness()` for PTY fleet terminals — NOT `getAliveRoleTerminalNames`, which reads from the deprecated `.switchboard/state.json` and is invisible to PTY fleet terminals.
- The existing test contract: `queue-pipeline-contract.test.js:209-215` explicitly asserts that an unresolvable `from` is a 400, "never workspace-wide routing." The plan's fallback changes this contract: the 400 should still fire when `from` is not a live terminal at all, but should NOT fire when `from` is a live terminal not on any team. The test must be updated.

## Edge-Case & Dependency Audit

- **Race Conditions:** Without a team, the in-flight check is skipped (same as seat-paced mode). The completion POST is the single trigger — serialized on `_queueNextChain` — so there is no race. Two agents finishing simultaneously both POST `queue/done`; the chain serializes; the first pops the next card, the second finds the queue empty or pops the card after that. A second Run click while the first card is in flight would pop the next queued card (the pop is serialized on the same chain), not re-dispatch the same card — the terminal would have two cards in flight, which matches seat-paced behavior.
- **Security:** No new endpoints. The existing `queue/next` and `queue/done` endpoints are unchanged in their auth/path. The `from` validation changes: instead of requiring `from` to be in a team roster, it requires `from` to be a live terminal (verified via `getRegisteredTerminals` or the terminal registry). A non-existent terminal name is still rejected. The `_runQueuePop` 400's safety comment ("never fall back to workspace-wide routing, which would let one team pull work 'as' another") is addressed by the fact that `from` is resolved by the `runQueue` handler (the system itself), not by external callers — the cross-team leak risk is minimal for the Run button path. The HTTP endpoint (`POST /kanban/queue/next`) still accepts `from` from the caller, so the fallback should only activate when `from` is verified as a live terminal not on any team, not when `from` is an arbitrary string.
- **Side Effects:** The "Run queue" button becomes enabled in workspaces with no team — only standalone coders. This is the intended behaviour. Team workspaces are unaffected: when `from` resolves to a team, the existing team-scoped path runs unchanged. The `global`-scoped standing order applies to ALL terminals, but the instruction ("POST /kanban/queue/done when you finish the card you were dispatched") is only actionable by coding terminals that received a queue-dispatched card — non-coding terminals see it as noise but never act on it.
- **Dependencies & Conflicts:** Does not conflict with the team-scoped dispatch path — the fallback only activates when `resolveTeamMembers` returns null/empty. Does not conflict with seat pacing — seat-paced teams still use the team-scoped path. The `global`-scoped standing order coexists with team-scoped orders (team agents receive both, but both say the same thing — redundant, not conflicting). The existing test at `queue-pipeline-contract.test.js:209-215` MUST be updated to reflect the new contract (400 only when `from` is not a live terminal, not when `from` is a live terminal not on a team).

## Dependencies
- `getAliveRoleTerminalNames` (TaskViewerProvider.ts:7174) — **DO NOT USE** as the fallback resolver. It reads from the deprecated `.switchboard/state.json` via `_readTerminalRegistryState` and is invisible to PTY fleet terminals. Six separate code comments warn against it (KanbanProvider.ts:1280-1284, 2604-2605, 5207-5209, 8182-8183, 12056-12060; TaskViewerProvider.ts:13222-13225). Use the new `getAliveCodingTerminalNames()` method instead (see Proposed Changes).
- `_terminalAgentInfo` (TaskViewerProvider.ts:1217) — in-memory `Map<string, { role, displayName }>` populated at terminal creation time. Workspace-agnostic. The correct source for finding live coding terminals by role without reading `state.json`.
- `getFleetLiveness()` (TaskViewerProvider.ts:1159) — returns `Array<{ friendlyName, lastDataAt, status }>` from `this._ptyLiveness`. The PTY fleet liveness source. Must be cross-referenced to include PTY fleet terminals in the fallback resolver.
- `performKanbanDispatch` (LocalApiServer.ts:1450) — already supports workspace-wide routing when `restrictToOriginTeam` is false and `targetTerminalOverride` is absent. When `resolveTeamRoleTerminal` returns null (no team), it falls back to workspace-wide routing (line 1543: "fell back to workspace-wide"). Already landed.
- `clearTerminalContext` callback (LocalApiServer.ts:313) — clears a terminal by name. Already landed, used by `_runQueueDone`.
- Standing orders system (`mutateStandingOrders`, `applyStandingOrders`, `selectOrders`) — supports `global`, `team`, `pair`, `team-head` scopes. There is NO `workspace` scope. Use `global` scope for the workspace-wide completion order.
- `SEAT_QUEUE_DONE_ORDER_BODY` (teamWiring.ts:154) — the existing team-scoped completion instruction. The `global`-scoped order should use the same text with `<your terminal name>` instead of `<your seat name>`.

## Adversarial Synthesis
Key risks: (1) the `global`-scoped standing order is delivered to ALL terminals including non-coding ones — but the instruction is only actionable by coding terminals with a dispatched card, so the noise is harmless; (2) skipping the in-flight check for non-team dispatch loses the user-facing 409, but a second Run click pops the next queued card (not the same card), matching seat-paced behavior; (3) the fallback resolver must read from `_terminalAgentInfo` + `getFleetLiveness()`, NOT the deprecated `getAliveRoleTerminalNames` — using the deprecated resolver would make PTY fleet terminals invisible and silently fail. Mitigations: use `global` scope (harmless to non-coding terminals), skip in-flight check (completion POST is the trigger), use new `getAliveCodingTerminalNames()` method (reads in-memory cache, not `state.json`).

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — new `getAliveCodingTerminalNames()` method
**Context:** The plan needs a fallback resolver that finds live coding terminals (lead or coder role) without reading from the deprecated `.switchboard/state.json`. The in-memory `_terminalAgentInfo` cache (line 1217) maps terminal names to `{ role, displayName }` and is populated at terminal creation time. `getFleetLiveness()` (line 1159) tracks PTY fleet terminal liveness.

**Logic:**
1. Add a new public method `getAliveCodingTerminalNames(): string[]` that:
   a. Iterates `_terminalAgentInfo` entries, filtering by role `'lead'` or `'coder'`.
   b. Checks liveness via `vscode.window.terminals` (for VS Code terminals) — a terminal is alive when `exitStatus === undefined`.
   c. Also checks `getFleetLiveness()` for PTY fleet terminals — a terminal is alive when `status !== 'exited'` and `friendlyName` matches.
   d. Returns the list of alive coding terminal names (leads first, then coders, sorted).
2. Prune stale entries from `_terminalAgentInfo` during iteration (same pattern as `getActualTerminalAgentNames` at line 1877-1897).

**Implementation:**
```typescript
public getAliveCodingTerminalNames(): string[] {
    const allTerminals = vscode.window.terminals;
    const terminalNames = new Set(
        allTerminals.filter(t => t.exitStatus === undefined).map(t => t.name)
    );
    // Include PTY fleet terminals
    const fleetLiveness = this.getFleetLiveness();
    for (const entry of fleetLiveness) {
        if (entry && entry.status !== 'exited' && entry.friendlyName) {
            terminalNames.add(entry.friendlyName);
        }
    }
    const leads: string[] = [];
    const coders: string[] = [];
    for (const [name, info] of this._terminalAgentInfo.entries()) {
        if (!terminalNames.has(name)) {
            this._terminalAgentInfo.delete(name);
            continue;
        }
        const role = String(info.role || '').toLowerCase();
        if (role === 'lead') leads.push(name);
        else if (role === 'coder') coders.push(name);
    }
    leads.sort();
    coders.sort();
    return [...leads, ...coders];
}
```

**Edge Cases:** PTY fleet coder with no `_terminalAgentInfo` entry — invisible (same as today for `resolveCodingHeadFromGroups`). VS Code terminal that was closed but not pruned — pruned during iteration. Terminal with role `'intern'` — not included (interns are not queue dispatch targets for the Run button; complexity routing handles intern-column dispatch via `performKanbanDispatch`).

### `src/services/LocalApiServer.ts` — fallback to workspace-wide routing in `_runQueuePop`
**Context:** Lines 1718-1726: `resolveTeamMembers` returns null/empty → 400. This is the hard gate that blocks non-team dispatch. The 400 has an explicit safety comment: "never fall back to workspace-wide routing, which would let one team pull work 'as' another."

**Logic:**
1. When `resolveTeamMembers` returns null/empty (no team), do NOT 400. Instead, verify `from` is a live terminal via `getRegisteredTerminals`. If `from` is NOT a live terminal, 400 with a clear message ("from is not a live terminal"). If `from` IS a live terminal, set `roster = [from]` (the requesting terminal only) and proceed with a fallback path.
2. Mark the fallback path: `const isTeamDispatch = hasRosterResolver && roster && roster.length > 0 && roster.includes(from) && roster.length > 1`. When `isTeamDispatch` is false:
   a. Skip the in-flight check (lines 1755-1771) — same as seat-paced mode. The completion POST is the single trigger; there's no race to arbitrate.
   b. Use workspace-wide routing: call `performKanbanDispatch` with `{ originTerminal: from }` and NO `targetTerminalOverride` and NO `restrictToOriginTeam`. Complexity routing picks the column; `performKanbanDispatch`'s existing workspace-wide role resolution (line 1543: "fell back to workspace-wide") picks the terminal.
3. When `isTeamDispatch` is true, the existing team-scoped path runs unchanged.

**Implementation:** Replace the 400 `return fail(...)` at line 1724-1726 with:
```typescript
if (hasRosterResolver && (!roster || roster.length === 0)) {
    // No team — verify from is a live terminal before falling back.
    const liveTerminals = this._options.getRegisteredTerminals?.() ?? [];
    if (!liveTerminals.includes(from)) {
        return fail(400, `from '${from}' is not a live terminal. Open your agent terminal(s) so they re-register.`);
    }
    roster = [from];
}
const isTeamDispatch = hasRosterResolver && Array.isArray(roster) && roster.length > 1;
```
Then guard the in-flight check: `if (pacing !== 'seat' && isTeamDispatch) { ... }`.
And set dispatch options for the non-team path:
```typescript
const dispatchOpts = useSeatBranch
    ? { originTerminal: from, restrictToOriginTeam: true }
    : isTeamDispatch
        ? { originTerminal: from, targetTerminalOverride: from }
        : { originTerminal: from }; // non-team: workspace-wide routing
```

> **Superseded:** When `resolveTeamMembers` returns null/empty, set `roster = [from]` and proceed without verifying `from` is a live terminal.
> **Reason:** Without verifying `from` is a live terminal, an arbitrary string passed to the HTTP endpoint `POST /kanban/queue/next` would trigger workspace-wide routing. The 400's safety comment exists to prevent this: "never fall back to workspace-wide routing, which would let one team pull work 'as' another." The fallback should only activate for verified live terminals, not arbitrary strings.
> **Replaced with:** Verify `from` is a live terminal via `getRegisteredTerminals` before falling back. 400 only when `from` is not a live terminal at all.

**Edge Cases:** `from` is a live terminal not on any team → workspace-wide routing. `from` is a team head → team-scoped routing (unchanged). `from` is not a live terminal at all → 400 with a clear message. `from` is a live terminal on a team → `resolveTeamMembers` returns the roster, team-scoped path runs (unchanged).

### `src/services/LocalApiServer.ts` — fallback in `_runQueueDone` for non-team completion
**Context:** `_runQueueDone` (line 2050) uses the team roster to find the in-flight card. Without a team, it should find the card by `dispatchedTerminal === from` only.

**Logic:**
1. The existing card-finding logic (line 2077) already matches `dispatchedTerminal === from && dispatchedAt set` — this works for non-team dispatch. The roster is used for the in-flight check in `_runQueuePop`, not in `_runQueueDone`'s card finding.
2. The `clearWorkingState` call (line 2105) works by plan file, not by team — unchanged.
3. The terminal clear (line 2134-2143) works by terminal name — unchanged.
4. The pop after clear calls `_runQueuePop` (line 2287) — which now has the fallback path from the change above.

**Implementation:** No change needed in `_runQueueDone` itself — it already works by terminal name. The fallback in `_runQueuePop` handles the non-team pop.

### `src/services/KanbanProvider.ts` — fallback `from` resolution in `runQueue` handler
**Context:** Lines 12061-12064: `resolveCodingHeadFromGroups` only finds team heads. Falls back to error when null.

**Logic:**
1. When `resolveCodingHeadFromGroups` returns null, fall back to the new `getAliveCodingTerminalNames()` method on `TaskViewerProvider` — this reads from the in-memory `_terminalAgentInfo` cache (not the deprecated `state.json`) and includes PTY fleet terminals via `getFleetLiveness()`.
2. If a terminal is found, use it as `from` and proceed. If none, error with the existing message.
3. The pacing resolution (line 12074) should return `'head'` for non-team dispatch (no team = no pacing field = head pacing = the terminal receives the card). This is the existing default when `resolveTeamPacing` can't find a team group.

**Implementation:**
```typescript
const headTerminal = await this.resolveCodingHeadFromGroups(workspaceRoot) || '';
if (!headTerminal) {
    // Fallback: find any live coding terminal from the in-memory cache
    // (NOT getAliveRoleTerminalNames — that reads the deprecated state.json).
    const codingTerminals = this._taskViewerProvider?.getAliveCodingTerminalNames() ?? [];
    if (codingTerminals.length > 0) {
        headTerminal = codingTerminals[0];
    }
}
if (!headTerminal) {
    this.postMessage({ type: 'showStatusMessage', message: 'No coding terminal is live. Open a coder terminal (AGENT SETUP tab or your saved agent grid) before pressing Run.', isError: true });
    return { success: false, error: 'No coding terminal is live — open a coder terminal first' };
}
```

> **Superseded:** Fall back to `getAliveRoleTerminalNames('lead')` and then `getAliveRoleTerminalNames('coder')` — these read the terminal registry, not team groups, and find any live coding terminal.
> **Reason:** `getAliveRoleTerminalNames` reads from the deprecated `.switchboard/state.json` via `_readTerminalRegistryState`. Six separate code comments in the codebase explicitly warn against it (KanbanProvider.ts:1280-1284, 2604-2605, 5207-5209, 8182-8183, 12056-12060; TaskViewerProvider.ts:13222-13225). PTY fleet terminals are invisible to it (`allowPtyFleet: false`). Using it would silently fail for every PTY fleet user — the exact failure mode this plan exists to fix.
> **Replaced with:** Fall back to the new `getAliveCodingTerminalNames()` method on `TaskViewerProvider`, which reads from the in-memory `_terminalAgentInfo` cache (populated at terminal creation time, workspace-agnostic) and includes PTY fleet terminals via `getFleetLiveness()`.

**Edge Cases:** No coding terminals at all → same error message (updated: "No coding terminal is live" instead of "No coding head is live"). Team head live → team path (unchanged). Only standalone coders live → fallback finds them via `_terminalAgentInfo`.

### `src/webview/kanban.html` — enable "Run queue" button without a team head
**Context:** Line 7729: button disabled when `!lastCodingHeadLive`. `codingHeadLive` is derived from `resolveCodingRolesFromGroups` which only finds team heads.

**Logic:**
1. The `codingHeadLive` flag (KanbanProvider.ts:1288) is `leads.length > 0 || coders.length > 0` from `resolveCodingRolesFromGroups`. Add a second flag: `anyCodingTerminalLive` — true when `getAliveCodingTerminalNames()` returns any terminal. This reads the in-memory cache, not team groups.
2. Enable the button when `anyCodingTerminalLive` is true, not just when `codingHeadLive` is true.
3. Update the tooltip: when `codingHeadLive` is false but `anyCodingTerminalLive` is true, show "Run the queue: dispatch the first staged plan to a coding terminal, completion pulls the rest in order."

**Implementation:** Add `anyCodingTerminalLive` to the board state payload (KanbanProvider.ts:1316), read it in kanban.html, and use it in the button's disable condition and tooltip. In the `runQueue` handler's board state assembly (KanbanProvider.ts:1286-1288):
```typescript
const _codingRoles1 = await this.resolveCodingRolesFromGroups(root);
const coderTerminalCount = _codingRoles1.coders.length;
const codingHeadLive = _codingRoles1.leads.length > 0 || _codingRoles1.coders.length > 0;
const anyCodingTerminalLive = codingHeadLive || (this._taskViewerProvider?.getAliveCodingTerminalNames().length ?? 0) > 0;
```
In kanban.html, update the button disable condition (line 7729 and 8483):
```javascript
if (runBtn) runBtn.disabled = !(n > 0 && dispatchAnalyzeAvailable && (lastCodingHeadLive || lastAnyCodingTerminalLive));
```

> **Superseded:** Add `anyCodingTerminalLive` flag using `getAliveRoleTerminalNames('lead')` or `getAliveRoleTerminalNames('coder')` to check for any live coding terminal.
> **Reason:** Same as the `runQueue` handler correction — `getAliveRoleTerminalNames` reads from the deprecated `state.json` and is invisible to PTY fleet terminals.
> **Replaced with:** Use the new `getAliveCodingTerminalNames()` method, which reads from the in-memory `_terminalAgentInfo` cache and includes PTY fleet terminals via `getFleetLiveness()`.

**Edge Cases:** Team workspace with a live team head → `codingHeadLive` true → button enabled (unchanged). Workspace with only standalone coders → `codingHeadLive` false, `anyCodingTerminalLive` true → button enabled (new). No coding terminals at all → both false → button disabled (unchanged).

### `src/services/teamWiring.ts` — `global`-scoped completion standing order
**Context:** `SEAT_QUEUE_DONE_ORDER_BODY` (line 154) is installed per team via `applySeatPacingOrders`. A standalone agent not on any team never receives the order and never knows to POST `queue/done`.

> **Superseded:** Add a workspace-scoped standing order `WORKSPACE_QUEUE_DONE_ORDER_BODY` installed at `workspace` scope.
> **Reason:** The standing orders system (`standingOrders.ts:3`) defines `StandingOrderScope = 'global' | 'team' | 'pair' | 'team-head'` — there is NO `workspace` scope. The `selectOrders` function (standingOrders.ts:182-223) has no case for `workspace`, so an order with `scope: 'workspace'` would fall through to the `pair` default and be silently dropped for every terminal. The coder would never learn to POST `queue/done` and the queue would stall after the first card with no error.
> **Replaced with:** Use `global` scope, which applies to all terminals and has the same semantics the plan intended for `workspace` scope.

**Logic:**
1. Add a `global`-scoped standing order `GLOBAL_QUEUE_DONE_ORDER_BODY` — same text as `SEAT_QUEUE_DONE_ORDER_BODY` but with `<your terminal name>` instead of `<your seat name>`, installed at `global` scope instead of `team`/`team-head` scope.
2. Install it when the "Run queue" button is clicked and `from` does not resolve to a team (the non-team fallback path). The install happens in the `runQueue` handler (KanbanProvider.ts) or in `_runQueuePop` before the dispatch.
3. The order is idempotent — if it already exists, skip. Use a deterministic id prefix `global-queue-done:` so it can be found and removed if needed.
4. The order text: "When you finish the card you were dispatched, POST /kanban/queue/done with {"from":"<your terminal name>"} against the port in .switchboard/api-server-port.txt. Do not wait to be asked. If you cannot complete it, call the same endpoint with {"from":"<your terminal name>","outcome":"failed"} and a one-line reason. Do not attempt work above your tier and do not report success you cannot evidence. A response of {"dispatched":null,"reason":"queue empty"} means the run is over — say so and stop. Do not call POST /kanban/queue/next, and do not move cards."

**Implementation:** The order is installed via `mutateStandingOrders` at `global` scope. The `selectOrders` function resolves `global`-scoped orders for all terminals (standingOrders.ts:194-196: `if (scope === 'global') { return true; }`). Team-scoped orders take precedence in delivery ordering but both are rendered — team agents see both orders, which is redundant (same instruction) but not conflicting. The order persists across sessions — it is installed once when the first non-team queue dispatch happens, and stays until manually removed.

**Edge Cases:** Team agents receive both the `global`-scoped order and their team-scoped order — both say the same thing (with slightly different placeholder text: `<your terminal name>` vs `<your seat name>`), no conflict. A workspace with no teams never installs the order via the team path — the `global` order is installed on first non-team dispatch. A workspace that previously had teams but no longer does — the `global`-scoped order from a prior non-team dispatch still applies, which is correct. Non-coding terminals (planners, reviewers) receive the order but never act on it — they have no dispatched card to complete.

### `src/test/queue-pipeline-contract.test.js` — update the unresolvable `from` test
**Context:** Line 209-215: the test "an unresolvable `from` is a 400, never workspace-wide routing" explicitly asserts that `resolveTeamMembers` returning null → 400. The plan's fallback changes this contract.

**Logic:**
1. The test should be split into two cases:
   a. `from` is not a live terminal at all → 400 (unchanged contract).
   b. `from` is a live terminal not on any team → workspace-wide routing (new contract).
2. For case (a), the test should mock `getRegisteredTerminals` to NOT include `from`, and assert 400.
3. For case (b), the test should mock `getRegisteredTerminals` to include `from`, and assert 200 with a dispatch.

**Implementation:**
```javascript
await check("a `from` that is not a live terminal is a 400", async () => {
    const board = [card('next', 'DISPATCH', { queuePosition: 1 })];
    const { server, dispatched } = makeServer(board, {
        resolveTeamMembers: async () => null,
        getRegisteredTerminals: () => ['OtherTerminal'],
    });
    const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'Ghost' });
    assert.strictEqual(out.status, 400, 'a `from` that is not a live terminal must not dispatch');
    assert.deepStrictEqual(dispatched, []);
});

await check("a live `from` not on any team dispatches via workspace-wide routing", async () => {
    const board = [card('next', 'DISPATCH', { queuePosition: 1 })];
    const { server, dispatched } = makeServer(board, {
        resolveTeamMembers: async () => null,
        getRegisteredTerminals: () => ['StandaloneCoder'],
    });
    const out = await server.dispatchNextFromQueue({ workspaceRoot: WS, from: 'StandaloneCoder' });
    assert.strictEqual(out.status, 200, 'a live terminal not on a team should dispatch via workspace-wide routing');
    assert.deepStrictEqual(dispatched, ['next']);
});
```

## Verification Plan

> **Note:** Compilation and automated tests are NOT run in this improve pass (session directive). The checks below remain the plan's verification contract for the implementing coder.

### Automated Tests
1. `npm run compile` — clean.
2. Unit: `_runQueuePop` with `from` not on any team but live in `getRegisteredTerminals` → does NOT 400; dispatches via workspace-wide routing; skips in-flight check.
3. Unit: `_runQueuePop` with `from` not on any team and NOT live in `getRegisteredTerminals` → 400 with "not a live terminal" message.
4. Unit: `_runQueuePop` with `from` on a team → existing team-scoped path (unchanged).
5. Unit: `_runQueueDone` with `from` not on any team → finds in-flight card by `dispatchedTerminal === from`; clears terminal; pops next card via workspace-wide routing.
6. Unit: `runQueue` handler with no team head but a live standalone coder → resolves `from` via `getAliveCodingTerminalNames()`; dispatches.
7. Unit: `runQueue` handler with no coding terminals at all → error (unchanged).
8. Unit: `getAliveCodingTerminalNames()` returns leads first, then coders; prunes stale entries; includes PTY fleet terminals from `getFleetLiveness()`.
9. Unit: `global`-scoped standing order installed on first non-team dispatch; idempotent on repeat; rendered by `selectOrders` for all terminals.
10. Regression: existing team-scoped `queue/next` / `queue/done` tests pass unchanged (the team path is byte-for-byte unchanged).
11. Regression: seat-paced team tests pass unchanged.
12. Updated: the test at `queue-pipeline-contract.test.js:209-215` is split into two cases (not-live → 400, live-no-team → 200) and both pass.
13. Manual: workspace with only standalone coders (no team). Stage 3 plans in Dispatch. Click Run. First plan dispatches to a coder. Coder finishes, POSTs `queue/done`. System clears terminal, dispatches second plan. Repeat for third. No team required.
14. Manual: same workspace, complete the last plan → response is `{dispatched: null, reason: "queue empty"}`. Coder stops.
15. Manual: team workspace with a live team head. Click Run. Team-scoped path runs (unchanged). No regression.
16. Manual: workspace with a PTY fleet coder (no team). Click Run. Card dispatches to the PTY fleet coder. `getAliveCodingTerminalNames()` finds it via `getFleetLiveness()`.

## Completion Summary

Implemented the kanban queue dispatch fallback for standalone coders (no team required). Six files changed: (1) `TaskViewerProvider.ts` — added `getAliveCodingTerminalNames()` method that reads the in-memory `_terminalAgentInfo` cache + `getFleetLiveness()` for PTY fleet terminals, returning leads-first-then-coders; (2) `LocalApiServer.ts` — replaced the hard 400 in `_runQueuePop` with a fallback that verifies `from` is a live terminal via `getRegisteredTerminals` before using workspace-wide routing, skips the in-flight check for non-team dispatch, and installs a `global`-scoped `queue/done` standing order via the new `installGlobalQueueDoneOrder`; (3) `KanbanProvider.ts` — `runQueue` handler falls back to `getAliveCodingTerminalNames()` when no team head is found, and all four `updateBoard` payloads now include `anyCodingTerminalLive`; (4) `kanban.html` — Run-queue button enables on `lastCodingHeadLive || lastAnyCodingTerminalLive` with updated tooltip; (5) `teamWiring.ts` — added `GLOBAL_QUEUE_DONE_ORDER_BODY` and `installGlobalQueueDoneOrder` (idempotent, `global` scope); (6) `queue-pipeline-contract.test.js` — split the single "unresolvable from" test into two cases (not-live → 400, live-no-team → 200). Key deviation from plan: used `rosterFromResolver || !hasRosterResolver` for `isTeamDispatch` instead of `roster.length > 1` to preserve headless/test harness behavior and single-head team behavior. Fixed plan's `const headTerminal` reassignment bug (changed to `let`). Compilation and tests skipped per session directives.

## Review Findings

The reviewer changed `src/services/TaskViewerProvider.ts`, `src/services/LocalApiServer.ts`, and `src/test/queue-pipeline-contract.test.js` to restore PTY-only role discovery, write the global completion order through the latched fleet-orders database, and add regression coverage. `npm run compile-tests`, `npm run compile`, `npm run test:contract:queue-pipeline`, `npm run test:contract:external-headed-team`, and `npm run test:contract:standing-orders-fleet-root` passed; targeted ESLint completed with zero errors and pre-existing warnings. The queue contract is defined in `package.json` and invoked by `.github/workflows/integration-tests.yml`, as is compilation. Remaining risk is manual installed-VSIX validation of the full three-card standalone UI flow and transient PTY lifecycle timing.
