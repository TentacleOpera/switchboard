# Remote Control Dispatch Acknowledgment Write-Back

## Goal

When Switchboard detects a remote status change (Linear or Notion) and dispatches a local agent, it should immediately post a comment back to the remote card confirming receipt and dispatch. This closes the feedback loop for remote agents — e.g. a mobile app using Google AI Studio + Notion MCP — that need to answer "did Switchboard pick this up?" without the user having to guess.

**Core problem:** The remote agent posts a work order (status change in Notion/Linear). Switchboard picks it up within ~60s and dispatches the local agent. But the remote side gets no acknowledgment — the user's external agent can't confirm dispatch happened until the local agent's own completion comment arrives later. The gap between "I sent the work order" and "I know it was received" is invisible.

**Root cause:** `_applyStateMirror` in `RemoteControlService` (line 288) calls `onColumnMove` (which dispatches the agent) but discards the result. There is no signal back to the remote card at dispatch time. The `RemoteProvider` interface (line 40) has no `postComment` method — only the downstream `postManagedComment` primitives exist on `LinearSyncService` (line 1182) and `NotionFetchService` (line 232), used by agents via the LocalApiServer `/comment` route. The plumbing to post a comment from the orchestrator layer does not exist.

Local agents already post completion comments to Notion/Linear via `postManagedComment`. The same plumbing just needs to fire at dispatch time, attributed to Switchboard itself rather than to an agent.

---

## Metadata

**Tags:** backend, reliability, feature
**Complexity:** 4

## User Review Required

Yes — review the ack comment wording (currently hardcoded) and confirm the fire-and-forget pattern is acceptable (dispatch is never blocked by ack failure).

## Complexity Audit

### Routine
- Adding one method to the `RemoteProvider` interface and implementing it in two existing provider classes — delegates to already-existing `postManagedComment` primitives.
- Changing `onColumnMove` return type from `Promise<void>` to `Promise<{ dispatched: boolean }>` — a single call site in `_applyStateMirror`.
- Threading a `boolean` return through `_remoteDispatchColumnAgent` (changing `return;` to `return false;` and adding `return true;` at the end).
- Updating the `onColumnMove` callback registration in `KanbanProvider` (line 1461) to `return` the result instead of `await`-discarding it.
- Updating test mocks to match the new interface contract.

### Complex / Risky
- **Silent failure swallowing:** `postManagedComment` on both providers returns `{ success: boolean; error?: string }` — it does NOT always throw on failure. Linear's `addIssueComment` returns `{ success: false }` when the API accepts the request but the mutation fails (line 1147, 1151). Notion's `postManagedComment` returns `{ success: false, notConfigured: true }` when the Comments database isn't set up (line 247). The `postComment` wrapper MUST check the return value and throw on `{ success: false }`, otherwise the `.catch()` handler in `_applyStateMirror` never fires and the failure is silently lost.
- **Test mock contract breakage:** The existing `remote-control-service.test.js` mock `onColumnMove` (line 47) returns `undefined`. The new `_applyStateMirror` destructures `{ dispatched }` from the return value — destructuring `undefined` throws `TypeError`. Mock providers (lines 70-76, 93-99, 121-127, 144-152, 165-171, 186-193) lack `postComment`. Both must be updated.

## Edge-Case & Dependency Audit

**Race Conditions:**
- The ack comment is posted fire-and-forget AFTER dispatch succeeds. If the ack comment bumps the remote timestamp, it could re-surface as a state delta on the next poll. However, this is safe: Linear comments do NOT bump the issue's `updatedAt` (research-confirmed; see `LinearRemoteProvider` doc comment), and Notion comments live in a separate Comments DB that does NOT bump the page's `last_edited_time` (research-confirmed; see `NotionRemoteProvider` doc comment). The ack comment WILL appear as a comment delta, but `authoredBySelf = true` (Linear marker / Notion `created_by === botId`) skips it on ingest. No feedback loop.

**Security:**
- The ack comment body is hardcoded — no user input is injected into the remote API. No injection risk.
- The `postManagedComment` primitives stamp the self-marker (Linear) or set `From = "Switchboard"` + auto-populate `created_by` with the bot id (Notion) host-side. The agent never touches the marker, so the feedback-loop guard cannot be broken by the ack path.

**Side Effects:**
- The ack comment is visible to the remote agent/user in the remote card's comment stream. This is the intended behavior.
- If `postComment` throws synchronously (e.g., provider doesn't implement it), the throw is caught by the outer try/catch in `_applyStateMirror` and logged. Dispatch already succeeded; the ack is best-effort.

**Dependencies & Conflicts:**
- No dependency on other plans. This is a self-contained change to the Remote Control subsystem.
- The `onColumnMove` return type change is a breaking interface change — all consumers (only `KanbanProvider` line 1461 and the test mock) must be updated in the same change.

## Dependencies

None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) `postManagedComment` returns `{ success: false }` without throwing, so the `postComment` wrapper must check the return value or ack failures are silently swallowed; (2) the test mock `onColumnMove` returns `undefined`, which will throw `TypeError` on destructuring — mock must return `{ dispatched: boolean }`; (3) mock providers lack `postComment` — must be added. Mitigations: harden `postComment` to throw on `{ success: false }`, update all test mocks in the same change, add the test file to "Files Changed."

---

## Implementation

### 1. Add `postComment` to the `RemoteProvider` interface

**File:** `src/services/remote/RemoteProvider.ts`

Add one method to the `RemoteProvider` interface (after `importRemotePlan`, line 71):

```typescript
/**
 * Post a comment on the remote card. Used to acknowledge dispatch back to the
 * remote agent. Implementations delegate to the provider's postManagedComment —
 * the stamp marker is applied there, ensuring authoredBySelf = true on ingest
 * (no feedback loop).
 */
postComment(remoteId: string, body: string): Promise<void>;
```

### 2. Implement in `LinearRemoteProvider`

**File:** `src/services/remote/LinearRemoteProvider.ts`

Add to the class body. **Clarification:** `postManagedComment` returns `{ success: boolean; error?: string }` — it does NOT always throw on failure (Linear's `addIssueComment` returns `{ success: false }` when the mutation is rejected, lines 1147/1151). The wrapper MUST check the return value and throw so the `.catch()` handler in `_applyStateMirror` fires:

```typescript
public async postComment(remoteId: string, body: string): Promise<void> {
    const result = await this._linear.postManagedComment(remoteId, body);
    if (!result.success) {
        throw new Error(`Linear postComment failed for ${remoteId}: ${result.error || 'unknown error'}`);
    }
}
```

### 3. Implement in `NotionRemoteProvider`

**File:** `src/services/remote/NotionRemoteProvider.ts`

Add to the class body. Same return-value check — Notion's `postManagedComment` returns `{ success: false, notConfigured?: true }` without throwing when the Comments database isn't configured (line 247):

```typescript
public async postComment(remoteId: string, body: string): Promise<void> {
    const result = await this._deps.notion.postManagedComment(remoteId, body);
    if (!result.success) {
        throw new Error(`Notion postComment failed for ${remoteId}: ${result.error || 'unknown error'}`);
    }
}
```

### 4. Change `onColumnMove` return type in `RemoteControlServiceDeps`

**File:** `src/services/RemoteControlService.ts`, line 68

```typescript
// Before
onColumnMove: (plan: KanbanPlanRecord, targetColumn: string) => Promise<void>;

// After
onColumnMove: (plan: KanbanPlanRecord, targetColumn: string) => Promise<{ dispatched: boolean }>;
```

### 5. Return `dispatched` from `_remoteDispatchColumnAgent` in `KanbanProvider`

**File:** `src/services/KanbanProvider.ts`

Change `_remoteDispatchColumnAgent` (line 1532) to return `Promise<boolean>` — `true` if an agent was actually dispatched, `false` for every early-return (no sessionId, agentless column, canDispatch check failed):

```typescript
private async _remoteDispatchColumnAgent(workspaceRoot: string, sessionId: string, column: string): Promise<boolean> {
    if (!sessionId) { return false; }
    const spec = await this._resolveKanbanDispatchSpec(workspaceRoot, column);
    const role = spec?.role || this._columnToRole(column);
    if (!role) { return false; }
    const canDispatch = await this._canAssignRole(workspaceRoot, role);
    if (!canDispatch) { return false; }
    const instruction = role === 'planner' ? 'improve-plan' : undefined;
    await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sessionId, instruction, workspaceRoot);
    return true;
}
```

Update `_remoteApplyColumnMove` (line 1507) to propagate this:

```typescript
private async _remoteApplyColumnMove(workspaceRoot: string, plan: KanbanPlanRecord, targetColumn: string): Promise<{ dispatched: boolean }> {
    await this.moveCardToColumnByPlanFile(workspaceRoot, plan.planFile, targetColumn);
    const sessionId = plan.sessionId || (await this._getKanbanDb(workspaceRoot).getPlanByPlanFile(plan.planFile, await this._getKanbanDb(workspaceRoot).getWorkspaceId() || ''))?.sessionId || '';
    const dispatched = await this._remoteDispatchColumnAgent(workspaceRoot, sessionId, targetColumn);
    return { dispatched };
}
```

Update the `onColumnMove` callback registration (line 1461) to match:

```typescript
onColumnMove: async (plan, targetColumn) => {
    return this._remoteApplyColumnMove(resolved, plan, targetColumn);
},
```

Note: `_remoteDispatchComment` (line 1528) also calls `_remoteDispatchColumnAgent` but discards the return value — changing `void` to `boolean` is backward compatible for that caller (it just ignores the boolean).

### 6. Gate the ack on `dispatched` in `RemoteControlService._applyStateMirror`

**File:** `src/services/RemoteControlService.ts`, around line 288

```typescript
private async _applyStateMirror(
    provider: RemoteProvider,
    plan: KanbanPlanRecord,
    targetColumn: string
): Promise<void> {
    if (targetColumn === plan.kanbanColumn) { return; }

    const remoteId = this._remoteIdOf(provider.kind, plan);
    this._log(`State mirror: ${remoteId} → column ${targetColumn} (from ${plan.kanbanColumn}).`);
    try {
        await provider.refreshLocalPlanFromRemote(remoteId);
        const { dispatched } = await this._deps.onColumnMove(plan, targetColumn);
        if (dispatched) {
            provider.postComment(
                remoteId,
                `Switchboard received this status change and dispatched the local agent for the **${targetColumn}** column. Check back in a few minutes.`
            ).catch(e => this._log(`Dispatch ack comment failed for ${plan.planId}: ${e instanceof Error ? e.message : String(e)}`));
        }
    } catch (e) {
        this._log(`onColumnMove failed for ${plan.planId}: ${e instanceof Error ? e.message : String(e)}`);
    }
}
```

The `.catch()` pattern keeps dispatch unblocked — the ack is best-effort. If `postComment` throws synchronously (e.g., not a function), the outer try/catch catches it and logs it.

### 7. Update test mocks in `remote-control-service.test.js`

**File:** `src/test/integrations/shared/remote-control-service.test.js`

**Clarification:** The existing test mocks must be updated to match the new interface contract. Two changes:

**a) Mock `onColumnMove` (line 47) must return `{ dispatched: boolean }`:**

```javascript
// Before
onColumnMove: async (plan, col) => {
    sinks.moves.push({ planId: plan.planId, col });
    if (sinks.order) { sinks.order.push('move:' + col); }
    plan.kanbanColumn = col;
},

// After
onColumnMove: async (plan, col) => {
    sinks.moves.push({ planId: plan.planId, col });
    if (sinks.order) { sinks.order.push('move:' + col); }
    plan.kanbanColumn = col;
    return { dispatched: true };
},
```

**b) All mock provider objects need a `postComment` stub** (lines 70-76, 93-99, 121-127, 144-152, 165-171, 186-193). Add to each:

```javascript
postComment: async () => {},
```

The ack is fire-and-forget with `.catch()`, so a no-op stub is sufficient — the tests don't assert on ack comments.

---

## Edge Cases

**Echo guard:** `postManagedComment` stamps `<!-- switchboard -->` (Linear, via `stampMarker` in `commentMarker.ts`) on outbound comments. On Notion, the bot authors the comment → `created_by` is auto-populated with the bot id. The `authoredBySelf` flag on the resulting `RemoteCommentDelta` is `true` → the comment stream skips it → no feedback loop. (Note: the Notion `From = "Switchboard"` field is a display label, NOT the echo guard mechanism — the guard is `created_by === botId`, checked at `NotionRemoteProvider.ts` line 132.)

**Agentless columns:** `_remoteDispatchColumnAgent` now returns `false` for agentless columns (no role, or `canDispatch` failed). `_applyStateMirror` only fires the ack when `dispatched === true`, so a card move onto an agentless column produces no comment. The card's status change in Notion/Linear is the only visible signal in that case, which is correct.

**Comment post failure:** The `postComment` wrapper throws on `{ success: false }` returns from `postManagedComment`. The `.catch()` handler in `_applyStateMirror` logs the error. Dispatch already succeeded; the ack is best-effort. This covers both thrown errors (network failures, not configured) and non-throwing failures (mutation rejected, Notion Comments DB not set up).

**No remote ID:** `_remoteIdOf` returns `''` for untracked cards. `postComment('')` → `postManagedComment('', body)` → Linear throws (empty issueId, line 1106) / Notion returns `{ success: false }` (empty pageId, line 235) → wrapper throws → caught by `.catch()` and logged.

**Notion not configured:** If the Notion Comments database hasn't been set up, `postManagedComment` returns `{ success: false, notConfigured: true }` without throwing. The hardened `postComment` wrapper checks `result.success` and throws, so the `.catch()` handler fires and logs the error. Without this check, the ack would be silently lost.

---

## Files Changed

| File | Change |
|---|---|
| `src/services/remote/RemoteProvider.ts` | Add `postComment` method to interface |
| `src/services/remote/LinearRemoteProvider.ts` | Implement `postComment` with return-value check |
| `src/services/remote/NotionRemoteProvider.ts` | Implement `postComment` with return-value check |
| `src/services/RemoteControlService.ts` | Change `onColumnMove` return type (line 68); gate ack on `dispatched` in `_applyStateMirror` (line 288) |
| `src/services/KanbanProvider.ts` | `_remoteDispatchColumnAgent` returns `boolean` (line 1532); `_remoteApplyColumnMove` returns `{ dispatched }` (line 1507); update callback registration (line 1461) |
| `src/test/integrations/shared/remote-control-service.test.js` | Update mock `onColumnMove` to return `{ dispatched: true }`; add `postComment` stub to all mock providers |

---

## Verification Plan

### Automated Tests
- **`src/test/integrations/shared/remote-control-service.test.js`** — Existing tests must still pass after mock updates. Specifically: Test B (state mirror + echo guard) must still assert one move and refresh-before-move ordering. The mock `onColumnMove` now returns `{ dispatched: true }`, so `_applyStateMirror` will call `provider.postComment(...)` — the no-op stub prevents a TypeError.
- **`src/test/integrations/linear/linear-remote-provider.test.js`** — Must still pass (no changes needed; doesn't test `postComment`).
- **`src/test/integrations/notion/notion-remote-provider.test.js`** — Must still pass (no changes needed; doesn't test `postComment`).
- **New test coverage (recommended):** Add a test case to `remote-control-service.test.js` that verifies the ack is only posted when `dispatched === true` (e.g., mock `onColumnMove` returns `{ dispatched: false }` and assert `postComment` was NOT called).

### Manual Verification
- Trigger a remote status change (Linear or Notion) on a tracked card → confirm the ack comment appears on the remote card within one poll cycle.
- Move a card to an agentless column remotely → confirm NO ack comment is posted.
- Disable the Notion Comments database setup → trigger a status change → confirm the ack failure is logged (not silently swallowed).

---

**Recommendation:** Complexity is 4 → **Send to Coder.**

---

## Reviewer Pass (In-Place)

### Stage 1 — Grumpy Principal Engineer

*Cracks knuckles. Reads the diff. Reads it again. Squints.*

Alright, listen up. I went through every file this plan touches and traced every call site. Here's what I found.

**NIT-1 — Recommended test for `dispatched === false` was NOT added.** The plan's Verification Plan (line 264) explicitly recommends — "New test coverage (recommended)" — a test case asserting the ack is NOT posted when `onColumnMove` returns `{ dispatched: false }`. The test file (`remote-control-service.test.js`) has tests A–F, all with `return { dispatched: true }`. There is zero coverage for the `dispatched === false` branch of the `if (dispatched)` gate in `_applyStateMirror` (line 303). The plan said "recommended," not "required," so I'm not calling this a MAJOR — but the one branch that actually distinguishes this feature from "always post a comment" is completely untested. The gate is three lines of code and the whole point of the `dispatched` return-type change. Test it. <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/RemoteControlService.ts" lines="302-308" />

**That's it.** No CRITICAL. No MAJOR. I looked hard.

- `postComment` wrappers in both providers check `result.success` and throw on failure — the silent-swallow trap the plan flagged is closed. <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/remote/LinearRemoteProvider.ts" lines="148-153" /> <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/remote/NotionRemoteProvider.ts" lines="168-173" />
- `onColumnMove` return type is `Promise<{ dispatched: boolean }>` — interface, implementation, callback registration, and test mock all consistent. <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/RemoteControlService.ts" lines="68-68" /> <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts" lines="1461-1463" />
- `_remoteDispatchColumnAgent` returns `boolean` — all three early returns are `return false`, the success path is `return true`. The `_remoteDispatchComment` caller (line 1529) discards the boolean, which is backward compatible. <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts" lines="1533-1547" />
- All 6 mock providers in the test file have `postComment: async () => {}` stubs. The mock `onColumnMove` returns `{ dispatched: true }`. No `TypeError` from destructuring `undefined`. <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/test/integrations/shared/remote-control-service.test.js" lines="47-54" />
- The ack is fire-and-forget: `provider.postComment(...).catch(...)` is NOT awaited. Dispatch is never blocked by ack failure. Synchronous throws (e.g., `postComment` not a function) are caught by the outer try/catch; async rejections are caught by `.catch()`. <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/RemoteControlService.ts" lines="299-311" />
- Echo guard is intact: `stampMarker` is applied inside `postManagedComment` (Linear) and `created_by` is auto-populated with the bot id (Notion). The ack comment will be `authoredBySelf = true` on ingest → skipped. No feedback loop.

The implementation is clean. The plan was thorough, the code matches it, and the one gap is a missing recommended test. I've seen worse. Much worse.

### Stage 2 — Balanced Synthesis

**Keep as-is:**
- All 6 files in the "Files Changed" table are correctly modified and match the plan spec.
- The `postComment` return-value hardening (throw on `{ success: false }`) is the load-bearing safety fix — it's in place.
- The fire-and-forget `.catch()` pattern is correct and intentional.
- The `dispatched` gate correctly suppresses ack comments for agentless columns.

**Fix now:** None required. No CRITICAL or MAJOR findings.

**Defer (optional):**
- NIT-1: Add a test case for `dispatched === false` to `remote-control-service.test.js`. This is the only gap between the plan's Verification Plan and the actual test file. It's a 10-line test that asserts `postComment` was NOT called. Low effort, high value for the one branch that defines the feature's gating behavior. Deferring is acceptable since the plan marked it "recommended," but it should be picked up before the next release.

### Code Fixes Applied

None — no CRITICAL or MAJOR findings required code changes.

### Validation Results

- **Typecheck/compile:** Skipped per session instructions (SKIP COMPILATION).
- **Automated tests:** Skipped per session instructions (SKIP TESTS). The user will run the suite separately.
- **Static verification (manual trace):** All 6 files in "Files Changed" verified against the plan spec. All call sites of `onColumnMove`, `_remoteDispatchColumnAgent`, and `_remoteApplyColumnMove` traced — no missed consumers. `postManagedComment` return signatures on both `LinearSyncService` (line 1182) and `NotionFetchService` (line 232) confirmed to return `{ success: boolean; error?: string }` without always throwing — the `postComment` wrappers correctly check `result.success`. Echo guard primitives (`stampMarker`/`hasMarker` in `commentMarker.ts`, Notion `created_by === botId` check at `NotionRemoteProvider.ts` line 132) confirmed present.

### Remaining Risks

1. **NIT-1 (deferred):** The `dispatched === false` branch in `_applyStateMirror` (line 303) has no test coverage. The plan recommended it; it was not added. Risk is low (the branch is a simple `if` gate), but the feature's distinguishing behavior is untested.
2. **Manual verification not yet run:** The plan's Manual Verification steps (trigger a real remote status change, confirm ack appears; move to agentless column, confirm no ack; disable Notion Comments DB, confirm failure is logged) require a live Linear/Notion integration and were not executed in this review.
3. **Ack comment wording is hardcoded:** The plan flagged this under "User Review Required" — the wording (`Switchboard received this status change and dispatched the local agent for the **${targetColumn}** column. Check back in a few minutes.`) is not configurable. Acceptable per the plan's fire-and-forget design, but the user should confirm the wording is acceptable before release.

### Files Changed (Verified)

| File | Change | Status |
|---|---|---|
| `src/services/remote/RemoteProvider.ts` | Add `postComment` method to interface (lines 73-79) | ✓ Verified |
| `src/services/remote/LinearRemoteProvider.ts` | Implement `postComment` with return-value check (lines 148-153) | ✓ Verified |
| `src/services/remote/NotionRemoteProvider.ts` | Implement `postComment` with return-value check (lines 168-173) | ✓ Verified |
| `src/services/RemoteControlService.ts` | `onColumnMove` return type (line 68); gate ack on `dispatched` in `_applyStateMirror` (lines 302-308) | ✓ Verified |
| `src/services/KanbanProvider.ts` | `_remoteDispatchColumnAgent` returns `boolean` (lines 1533-1547); `_remoteApplyColumnMove` returns `{ dispatched }` (lines 1507-1512); callback registration (lines 1461-1463) | ✓ Verified |
| `src/test/integrations/shared/remote-control-service.test.js` | Mock `onColumnMove` returns `{ dispatched: true }` (line 53); `postComment` stubs on all 6 mock providers (lines 77, 101, 130, 156, 176, 199) | ✓ Verified |

### Summary

| Severity | Finding | File:Line | Fix |
|---|---|---|---|
| NIT | Recommended `dispatched === false` test not added | `src/test/integrations/shared/remote-control-service.test.js` | Deferred (plan marked "recommended") |

**Fixes applied:** None (no CRITICAL/MAJOR findings).
**Remaining risks:** NIT-1 (untested `dispatched === false` branch); manual verification pending; hardcoded ack wording pending user confirmation.
