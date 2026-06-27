# Remote Control Dispatch Acknowledgment Write-Back

## Goal

When Switchboard detects a remote status change (Linear or Notion) and dispatches a local agent, it should immediately post a comment back to the remote card confirming receipt and dispatch. This closes the feedback loop for remote agents — e.g. a mobile app using Google AI Studio + Notion MCP — that need to answer "did Switchboard pick this up?" without the user having to guess.

**Core problem:** The remote agent posts a work order (status change in Notion/Linear). Switchboard picks it up within ~60s and dispatches the local agent. But the remote side gets no acknowledgment — the user's external agent can't confirm dispatch happened until the local agent's own completion comment arrives later. The gap between "I sent the work order" and "I know it was received" is invisible.

Local agents already post completion comments to Notion/Linear via `postManagedComment`. The same plumbing just needs to fire at dispatch time, attributed to Switchboard itself rather than to an agent.

---

## Implementation

### 1. Add `postComment` to the `RemoteProvider` interface

**File:** `src/services/remote/RemoteProvider.ts`

Add one method to the `RemoteProvider` interface:

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

Add to the class body:

```typescript
public async postComment(remoteId: string, body: string): Promise<void> {
    await this._linear.postManagedComment(remoteId, body);
}
```

### 3. Implement in `NotionRemoteProvider`

**File:** `src/services/remote/NotionRemoteProvider.ts`

Add to the class body:

```typescript
public async postComment(remoteId: string, body: string): Promise<void> {
    await this._deps.notion.postManagedComment(remoteId, body);
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

Change `_remoteDispatchColumnAgent` to return `Promise<boolean>` — `true` if an agent was actually dispatched, `false` for every early-return (no sessionId, agentless column, canDispatch check failed):

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

Update `_remoteApplyColumnMove` to propagate this:

```typescript
private async _remoteApplyColumnMove(workspaceRoot: string, plan: KanbanPlanRecord, targetColumn: string): Promise<{ dispatched: boolean }> {
    await this.moveCardToColumnByPlanFile(workspaceRoot, plan.planFile, targetColumn);
    const sessionId = plan.sessionId || (await this._getKanbanDb(workspaceRoot).getPlanByPlanFile(plan.planFile, await this._getKanbanDb(workspaceRoot).getWorkspaceId() || ''))?.sessionId || '';
    const dispatched = await this._remoteDispatchColumnAgent(workspaceRoot, sessionId, targetColumn);
    return { dispatched };
}
```

Update the `onColumnMove` callback registration to match:

```typescript
onColumnMove: async (plan, targetColumn) => {
    return this._remoteApplyColumnMove(resolved, plan, targetColumn);
},
```

### 6. Gate the ack on `dispatched` in `RemoteControlService._applyStateMirror`

**File:** `src/services/RemoteControlService.ts`, around line 301

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

The `.catch()` pattern keeps dispatch unblocked — the ack is best-effort.

---

## Edge Cases

**Echo guard:** `postManagedComment` stamps `<!-- switchboard -->` (Linear/ClickUp) or sets `From = "Switchboard"` (Notion) on outbound comments. The `authoredBySelf` flag on the resulting `RemoteCommentDelta` is `true` → the comment stream skips it → no feedback loop.

**Agentless columns:** `_remoteDispatchColumnAgent` now returns `false` for agentless columns. `_applyStateMirror` only fires the ack when `dispatched === true`, so a card move onto an agentless column produces no comment. The card's status change in Notion/Linear is the only visible signal in that case, which is correct.

**Comment post failure:** Logged, swallowed. Dispatch already succeeded; the ack is best-effort.

**No remote ID:** `_remoteIdOf` returns `''` for untracked cards. The `postComment` call with an empty remoteId will fail at the API layer — caught by the `.catch()` handler and logged.

---

## Files Changed

| File | Change |
|---|---|
| `src/services/remote/RemoteProvider.ts` | Add `postComment` method to interface |
| `src/services/remote/LinearRemoteProvider.ts` | Implement `postComment` |
| `src/services/remote/NotionRemoteProvider.ts` | Implement `postComment` |
| `src/services/RemoteControlService.ts` | Change `onColumnMove` return type; gate ack on `dispatched` in `_applyStateMirror` |
| `src/services/KanbanProvider.ts` | `_remoteDispatchColumnAgent` returns `boolean`; `_remoteApplyColumnMove` returns `{ dispatched }`; update callback registration |

---

## Metadata

**Complexity:** 3
**Tags:** backend, reliability, feature
