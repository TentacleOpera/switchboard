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

### 4. Fire the acknowledgment in `RemoteControlService._applyStateMirror`

**File:** `src/services/RemoteControlService.ts`, around line 301

After the successful `onColumnMove` call, fire-and-forget the ack comment:

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
        await this._deps.onColumnMove(plan, targetColumn);
        // Fire-and-forget: post acknowledgment back to the remote card.
        provider.postComment(
            remoteId,
            `Switchboard received this status change and dispatched the local agent for the **${targetColumn}** column. Check back in a few minutes.`
        ).catch(e => this._log(`Dispatch ack comment failed for ${plan.planId}: ${e instanceof Error ? e.message : String(e)}`));
    } catch (e) {
        this._log(`onColumnMove failed for ${plan.planId}: ${e instanceof Error ? e.message : String(e)}`);
    }
}
```

The `.catch()` pattern (rather than try/catch around an await) keeps the dispatch itself unblocked — the ack is best-effort.

---

## Edge Cases

**Echo guard:** `postManagedComment` stamps `<!-- switchboard -->` (Linear/ClickUp) or sets `From = "Switchboard"` (Notion) on outbound comments. The `authoredBySelf` flag on the resulting `RemoteCommentDelta` is `true` → the comment stream skips it → no feedback loop.

**Agentless columns:** The message says "dispatched the local agent for the **X** column." If no agent is configured for that column, `_remoteDispatchColumnAgent` silently no-ops — the card moved but nothing ran. The ack still fires, which is slightly inaccurate. Acceptable for now: the card movement itself is meaningful state, and if no agent ran, the comment is the only signal the remote side receives. A follow-up could thread a `dispatched: boolean` return from `onColumnMove` to gate the message wording.

**Comment post failure:** Logged, swallowed. Dispatch already succeeded; the ack is best-effort.

**No remote ID:** `_remoteIdOf` returns `''` for untracked cards. The `postComment` call with an empty remoteId will fail at the API layer — caught by the `.catch()` handler and logged.

---

## Files Changed

| File | Change |
|---|---|
| `src/services/remote/RemoteProvider.ts` | Add `postComment` method to interface |
| `src/services/remote/LinearRemoteProvider.ts` | Implement `postComment` |
| `src/services/remote/NotionRemoteProvider.ts` | Implement `postComment` |
| `src/services/RemoteControlService.ts` | Fire ack after `onColumnMove` in `_applyStateMirror` |

---

## Metadata

**Complexity:** 2
**Tags:** backend, reliability, feature
