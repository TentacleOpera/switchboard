# Linear Bidirectional Description Sync

## Goal

Make the Linear ↔ Switchboard body/content sync genuinely bidirectional. Currently plan edits push to Linear (via ContinuousSyncService) but Linear description changes are never pulled back — the inbound path only fires when *both* sides changed (conflict dialog). Users who draft or refine plan content in Linear expect it to appear in Switchboard automatically.

### Problem Analysis

#### Current State: Outbound Only

ContinuousSyncService watches local plan files for changes, debounces 3 seconds (max 60s), and pushes the content to the linked Linear issue description via `issueUpdate` mutation. This works well.

The inbound direction is broken for the common case: `_detectExternalConflict()` in ContinuousSyncService fetches the Linear description but only acts when *both* sides changed. If the user edits in Linear and the local file is untouched, no conflict is detected and the change is silently ignored.

**Verified in source (ContinuousSyncService.ts):**
- `_detectExternalConflict()` (line 750–773) compares `externalHash !== state.lastExternalHash` and returns `true` only when the external description changed since last sync. However, this method is only called inside `_executeSync()` (line 464) — which is triggered by local file changes via the file watcher — or during manual `checkForConflicts()` (line 234). If only the remote side changed and the local file is untouched, no sync is triggered, and the change is silently ignored.
- The existing `refreshLocalPlanFromRemote()` in LinearRemoteProvider (line 108–123) already pulls descriptions from Linear, but it's only called inside `_applyStateMirror()` (RemoteControlService line 300), which returns early at line 295 when `targetColumn === plan.kanbanColumn`. Description-only changes that bump `updatedAt` but don't change the column are silently dropped.

#### Root Cause: No Persisted Sync Timestamp Per Issue

`lastSyncAt` in `LiveSyncState` is in-memory only — lost on every extension reload. `fetchIssueUpdates()` in LinearSyncService doesn't fetch `updatedAt` or `description` from Linear, so the remote control poll has no way to detect description changes. There is no persisted "last synced at" per issue to compare against.

**Verified in source:**
- `LiveSyncState` (LiveSyncTypes.ts line 10–26): `lastSyncAt: number` stored in `_states = new Map<string, LiveSyncState>()` (ContinuousSyncService.ts line 20). `_createInitialState()` sets `lastSyncAt: 0` (line 1033). No persistence mechanism — cleared on `stop()` (line 104) and `start()` (line 71).
- `fetchIssueUpdates()` (LinearSyncService.ts line 1195–1239): GraphQL query at lines 1208–1218 fetches only `id`, `state { id name type }`, and `comments`. No `updatedAt` or `description` fields.
- `LinearRemoteProvider.fetchStateDeltas()` (LinearRemoteProvider.ts line 36–70): Queries `issues(filter: { updatedAt: { gt: cursor } })` and extracts `id`, `updatedAt`, `state { id }` — but only returns `{ remoteId, stateKey }` in the delta (line 62). The `updatedAt` is used only for cursor advancement (line 64), not returned to the caller. Description data is never fetched.

#### Design: Last-Writer-Wins via Timestamps

On each remote control poll cycle:
- If `issue.updatedAt > persistedCursor` and local file mtime ≤ cursor → **pull** (Linear is newer, local unchanged)
- If `issue.updatedAt > persistedCursor` and local file mtime > cursor → **conflict** (both changed)
- If `issue.updatedAt ≤ cursor` → skip

When ContinuousSyncService pushes to Linear, persist the cursor for that issue so the next poll doesn't re-pull the same content.

Loop prevention: when RemoteControlService writes pulled content to disk, ContinuousSyncService's file watcher fires and would re-push. Guard: before pushing, compare `hash(strippedContent)` against a `markExternallyWritten` hash. If they match, skip the push.

## Metadata

**Tags:** backend, feature, reliability
**Complexity:** 7

## User Review Required

Yes — the conflict resolution strategy (last-writer-wins with notification vs. three-way merge dialog) and the GRACE_MS tolerance window for mtime-based conflict detection should be validated by the user before implementation. Additionally, the decision to support Linear-only description sync initially (deferring Notion) should be confirmed.

## Complexity Audit

### Routine
- Extending `RemoteStateDelta` interface with optional `description`/`updatedAt` fields (RemoteProvider.ts)
- Adding `description` and `updatedAt` to the `fetchStateDeltas` GraphQL query in LinearRemoteProvider (already fetches `updatedAt` for cursor advancement; just needs `description` added and both fields returned in the delta)
- Adding DB config table keys for description cursors (`remote.descriptionCursor.${kind}`) — follows existing pattern at RemoteControlService.ts lines 58–60
- Adding `_externallyWrittenHashes: Map<string, string>` to ContinuousSyncService — simple in-memory map
- Hash computation for loop prevention — reuses existing `crypto.createHash('sha256')` pattern (ContinuousSyncService.ts line 326, 759)

### Complex / Risky
- **Bidirectional loop prevention**: The pull-write-push feedback loop is the highest-risk aspect. The hash guard must compute on the same canonical form as the push path (after `_stripH1Header`), or the hashes won't match and the guard fails, causing an infinite push-pull loop.
- **Race between pull and push**: RemoteControlService's `_pollDescriptions` writes the plan file, which triggers ContinuousSyncService's file watcher. If the hash guard has a timing gap (hash not yet set when the watcher fires), the push could slip through. The `onDescriptionPulled` callback must set the hash BEFORE the file write completes (or the write must be synchronous and the hash set immediately after).
- **Cursor advancement semantics**: The description cursor must only advance after successful processing. If it advances past a failed description pull, that change is permanently lost. The existing state cursor advances to `max(updatedAt)` after all deltas are processed (RemoteControlService line 283–285), which is safe for state (idempotent via echo guard) but unsafe for descriptions (not idempotent).
- **Constructor signature changes**: Both `RemoteControlService` and `ContinuousSyncService` constructors need new dependencies injected. ContinuousSyncService currently uses positional parameters (lines 45–51), not a deps object. Changing to a deps object is a breaking change for all callers.

## Edge-Case & Dependency Audit

### Race Conditions
- **Pull-then-push race**: After `_pollDescriptions` writes the plan file, the `GlobalPlanWatcher.onPlanDiscovered` event fires asynchronously. If `markExternallyWritten` hasn't been called yet (or the hash hasn't been stored in the map), the file watcher handler in `_handleFileChange` (ContinuousSyncService.ts line 273) will compute a new hash, see it differs from `lastContentHash`, and queue a push. **Mitigation**: Call `onDescriptionPulled` (which sets the hash) BEFORE writing the file, so the hash is in the map when the watcher fires. Clarification: the file watcher event is async and fires on the next event loop tick, so setting the hash synchronously before the write should be sufficient.
- **Concurrent poll cycles**: RemoteControlService already guards against overlapping polls with `_polling` flag (line 193). No additional guard needed.
- **Push during pull**: If ContinuousSyncService is mid-push when `_pollDescriptions` tries to pull, the pull could overwrite the file while the push is reading it. **Mitigation**: The existing `_inFlightSessions` set (ContinuousSyncService.ts line 29) and `_activeControllers` map (line 32) track in-flight syncs. The pull path should check if a sync is in-flight for the same session and skip if so.

### Security
- Description content from Linear is written directly to the local plan file. No sanitization is needed beyond what the existing `refreshLocalPlanFromRemote` already does (LinearRemoteProvider.ts line 108–123). The content is markdown, not executable code.
- The hash guard uses SHA-256, which is cryptographically sufficient for content matching (not a security boundary, just a loop-prevention mechanism).

### Side Effects
- Writing the plan file triggers the `GlobalPlanWatcher`, which may trigger other subscribers (e.g., webview refresh). This is expected and desirable — the user should see the updated content.
- Advancing the description cursor affects future poll cycles. If the cursor advances past a change that wasn't fully processed, that change is lost. **Mitigation**: Only advance cursor after successful file write + hash registration.

### Dependencies & Conflicts
- **Depends on `RemoteProvider` interface** (RemoteProvider.ts): Adding optional `description`/`updatedAt` fields to `RemoteStateDelta` is backward-compatible (existing implementations simply leave them undefined).
- **Depends on KanbanDatabase config table** (KanbanDatabase.ts lines 2926–2954): New keys `remote.descriptionCursor.${kind}` follow existing pattern.
- **Conflicts with existing `refreshLocalPlanFromRemote`**: This method is called during state mirror (column changes) and already pulls descriptions. The new `_pollDescriptions` path must not double-pull when both the column and description changed in the same poll cycle. **Mitigation**: If `_applyStateMirror` already called `refreshLocalPlanFromRemote` for a card, `_pollDescriptions` should skip that card. Track which remoteIds were already refreshed in the current poll cycle.
- **CRITICAL — Interaction with Linear Free-Tier Auto-Archive plan:** The auto-archive plan archives Linear issues when plans reach the `'CODE REVIEWED'` or `'COMPLETED'` column. Per the research, archived issues are **read-only** — `issueUpdate` calls on archived issues **fail**. The push path in `ContinuousSyncService._syncToLinear()` (line 874) calls `syncPlanContent()` → `issueUpdate(input:{description})` on the linked issue, which would fail on an archived issue. The auto-archive plan addresses this with an **unarchive → push → re-archive flow** (Task 10 in that plan) — it temporarily restores the issue, pushes the content update, then re-archives. **This plan does NOT need to change its push path** — the unarchive/re-archive happens in `_syncToLinear()` around the `syncPlanContent()` call, transparently to this plan. If the auto-archive plan is NOT implemented, this plan's push path will fail on archived issues with an error toast on every edit. **Recommendation:** implement both plans together.

## Dependencies

None — builds on existing ContinuousSyncService and RemoteControlService infrastructure.

## Adversarial Synthesis

Key risks: bidirectional loop prevention depends on hash canonical form matching between push and pull paths — any mismatch (H1 stripping, whitespace normalization) causes an infinite sync loop. The mtime-based conflict detection with GRACE_MS is fragile across filesystems and clock skew. Mitigations: compute hash on the exact same stripped form used by the push path; prefer hash-based conflict detection over mtime comparison; set the externally-written hash before the file write to close the race window.

## Proposed Changes

### `src/services/remote/RemoteProvider.ts`

**Context**: The `RemoteStateDelta` interface (lines 19–24) currently carries only `remoteId` and `stateKey`. The `RemoteProvider` interface (lines 40–72) defines `fetchStateDeltas` and `fetchCommentDeltas` as two separate streams.

**Logic**: Extend `RemoteStateDelta` to carry optional description data so that `_pollState` can process description changes alongside column changes without an extra API call.

**Implementation**:
```typescript
// Line 19–24: Extend RemoteStateDelta
export interface RemoteStateDelta {
    remoteId: string;
    stateKey: string;
    /** ISO timestamp of the remote item's last update. Linear: issue.updatedAt. Notion: page.last_edited_time. */
    updatedAt?: string;
    /** Remote item body/description. Linear: issue.description. Notion: undefined (deferred). */
    description?: string;
}
```

**Edge Cases**: Optional fields ensure backward compatibility — NotionRemoteProvider leaves them undefined, existing callers ignore them.

### `src/services/remote/LinearRemoteProvider.ts`

**Context**: `fetchStateDeltas()` (lines 36–70) queries `issues(filter: { updatedAt: { gt: cursor } })` and currently fetches only `id`, `updatedAt`, `state { id }`. The `updatedAt` is used for cursor advancement (line 64) but not returned in the delta.

**Logic**: Add `description` to the GraphQL query and populate the new `RemoteStateDelta` fields. This avoids a separate API call for description detection.

**Implementation**:
```typescript
// Lines 47–53: Extend the GraphQL query
const QUERY = `
  query {
    issues(filter: { updatedAt: { gt: ${since} } }, first: 100) {
      nodes { id updatedAt description state { id } }
    }
  }
`;

// Lines 59–62: Populate new fields in the delta
for (const node of nodes) {
    const remoteId = String(node.id || '');
    const stateKey = String(node.state?.id || '');
    const updatedAt = String(node.updatedAt || '');
    const description = String(node.description || '');
    if (remoteId && stateKey) {
        deltas.push({ remoteId, stateKey, updatedAt, description: description || undefined });
    }
    if (updatedAt && updatedAt > nextCursor) { nextCursor = updatedAt; }
}
```

**Edge Cases**: Empty descriptions (`""`) are normalized to `undefined` to avoid pulling empty content. Large descriptions (>100KB) should be skipped to match the existing `maxContentSizeBytes` guard in ContinuousSyncService (line 319).

### `src/services/RemoteControlService.ts`

**Context**: `_poll()` (lines 192–217) calls `_pollState()` and `_pollComments()`. `_pollState()` (lines 252–286) processes state deltas and advances the state cursor. `_applyStateMirror()` (lines 288–305) returns early at line 295 when the column hasn't changed, dropping description-only changes.

**Logic**: Add a `_pollDescriptions()` step after `_pollComments()` that processes the description field from state deltas. Use a separate description cursor (`remote.descriptionCursor.${kind}`) that only advances after successful processing. Skip cards already refreshed by `_applyStateMirror` in the same poll cycle.

**Implementation**:

1. Add new deps to `RemoteControlDeps` (lines 62–72):
```typescript
interface RemoteControlDeps {
    // ... existing deps ...
    /** Persisted description-sync cursors per issue (issueId → ISO timestamp). */
    getDescriptionCursors: (kind: RemoteProviderKind) => Promise<Record<string, string>>;
    /** Persist a description-sync cursor for an issue. */
    setDescriptionCursor: (kind: RemoteProviderKind, issueId: string, timestamp: string) => Promise<void>;
    /** Called after a description is pulled and written to disk. Registers the content hash for loop prevention. */
    onDescriptionPulled: (issueId: string, contentHash: string) => void;
}
```

2. Add description cursor key (after line 60):
```typescript
const descriptionCursorKey = (kind: RemoteProviderKind) => `remote.descriptionCursor.${kind}`;
```

3. Add `_pollDescriptions()` method:
```typescript
private async _pollDescriptions(
    db: KanbanDatabase,
    provider: RemoteProvider,
    byRemoteId: Map<string, KanbanPlanRecord>,
    refreshedThisCycle: Set<string>  // remoteIds already refreshed by _applyStateMirror
): Promise<void> {
    const key = descriptionCursorKey(provider.kind);
    const cursorsRaw = await db.getConfig(key);
    const cursors: Record<string, string> = cursorsRaw ? JSON.parse(cursorsRaw) : {};

    // Re-fetch state deltas to get description data (same query, now includes description)
    // OR: cache the deltas from _pollState and reuse them here.
    // Approach: cache deltas from _pollState for efficiency.
    // (See implementation note below about caching)

    const { deltas, nextCursor } = await provider.fetchStateDeltas(
        await db.getConfig(key) || new Date().toISOString()
    );

    let advanced = false;
    for (const d of deltas) {
        if (!d.description && !d.updatedAt) continue;  // no description data
        if (refreshedThisCycle.has(d.remoteId)) continue;  // already refreshed by state mirror

        const plan = byRemoteId.get(d.remoteId);
        if (!plan) continue;

        const cursor = cursors[d.remoteId] || '';
        if (!d.updatedAt || d.updatedAt <= cursor) continue;  // already synced

        // Conflict detection: compare local content hash against pulled description
        // (hash-based, not mtime-based — more reliable across filesystems)
        const pulledBody = d.description || '';
        if (!pulledBody.trim()) continue;  // never clobber with empty

        // Reconstruct full file content: preserve existing H1 title + pulled body
        // (Linear description doesn't include the H1 — it was stripped before push)
        const planPath = path.isAbsolute(plan.planFile) ? plan.planFile : path.join(workspaceRoot, plan.planFile);
        let existingContent = '';
        try { existingContent = await fs.promises.readFile(planPath, 'utf8'); } catch { /* ok */ }

        // Extract existing H1 title line
        const h1Match = existingContent.match(/^# .+\n?/);
        const h1Line = h1Match ? h1Match[0] : `# ${plan.topic || 'Untitled'}\n`;
        const newContent = h1Line + '\n' + pulledBody;

        // Hash-based conflict check: if local content already matches what we'd write, skip
        const newHash = crypto.createHash('sha256').update(newContent).digest('hex');
        const existingHash = crypto.createHash('sha256').update(existingContent).digest('hex');
        if (newHash === existingHash) {
            // Already in sync — just advance cursor
            cursors[d.remoteId] = d.updatedAt;
            advanced = true;
            continue;
        }

        // Check if local file was modified since last sync (conflict detection)
        // Use the ContinuousSyncService's in-memory state if available, otherwise
        // fall back to mtime comparison
        // For now: if existing content differs from what we'd write AND we have
        // a previous cursor (meaning we've synced before), this is a potential conflict
        if (cursor && existingHash !== /* last pushed hash */ undefined) {
            // CONFLICT: both sides changed — notify user, don't auto-overwrite
            this._log(`Description conflict for ${d.remoteId} — both sides changed.`);
            // TODO: show conflict notification (reuse _showConflictDialog pattern)
            continue;
        }

        // PULL: write new content to plan file
        try {
            // Register hash BEFORE write so loop prevention is active when watcher fires
            this._deps.onDescriptionPulled(d.remoteId, newHash);
            await fs.promises.writeFile(planPath, newContent, 'utf8');
            cursors[d.remoteId] = d.updatedAt;
            advanced = true;
            this._log(`Pulled description for ${d.remoteId} → ${plan.planFile}.`);
        } catch (e) {
            this._log(`Failed to pull description for ${d.remoteId}: ${e instanceof Error ? e.message : String(e)}`);
            // Don't advance cursor — retry on next poll
        }
    }

    if (advanced) {
        await db.setConfig(key, JSON.stringify(cursors));
    }
}
```

4. Modify `_poll()` (line 192–217) to call `_pollDescriptions()` and track refreshed cards:
```typescript
private async _poll(): Promise<void> {
    if (this._polling) { return; }
    this._polling = true;
    try {
        const db = this._deps.getDb();
        if (!db || !(await db.ensureReady())) { return; }

        const config = await this.getConfig();
        if (config.boards.length === 0) { return; }

        const provider = this._deps.getProvider(config.provider);
        if (!provider) { this._log(`No provider available for '${config.provider}'.`); return; }

        const workspaceId = await this._deps.getWorkspaceId();
        const boardSet = new Set(config.boards);
        const allPlans = await db.getAllPlans(workspaceId);
        const byRemoteId = this._indexByRemoteId(provider.kind, allPlans, boardSet);

        const refreshedThisCycle = new Set<string>();
        await this._pollState(db, provider, byRemoteId, refreshedThisCycle);
        await this._pollComments(db, provider, byRemoteId);
        await this._pollDescriptions(db, provider, byRemoteId, refreshedThisCycle);
    } catch (e) {
        this._log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
        this._polling = false;
    }
}
```

5. Modify `_applyStateMirror()` (lines 288–305) to track refreshed cards:
```typescript
private async _applyStateMirror(
    provider: RemoteProvider,
    plan: KanbanPlanRecord,
    targetColumn: string,
    refreshedThisCycle: Set<string>
): Promise<void> {
    if (targetColumn === plan.kanbanColumn) { return; }

    this._log(`State mirror: ${this._remoteIdOf(provider.kind, plan)} → column ${targetColumn} (from ${plan.kanbanColumn}).`);
    try {
        await provider.refreshLocalPlanFromRemote(this._remoteIdOf(provider.kind, plan));
        refreshedThisCycle.add(this._remoteIdOf(provider.kind, plan));  // Track refreshed card
        await this._deps.onColumnMove(plan, targetColumn);
    } catch (e) {
        this._log(`onColumnMove failed for ${plan.planId}: ${e instanceof Error ? e.message : String(e)}`);
    }
}
```

**Edge Cases**:
- Empty description: skip pull (never clobber with empty content) — matches existing guard in `refreshLocalPlanFromRemote` (LinearRemoteProvider line 118).
- Description-only change where column didn't change: `_applyStateMirror` returns early (line 295), but `_pollDescriptions` processes it.
- Both column and description changed in same poll: `_applyStateMirror` refreshes the plan (including description), `_pollDescriptions` skips it via `refreshedThisCycle`.
- Pull fails mid-write: cursor not advanced, retry on next poll.
- Large descriptions: skip if `description.length > 102400` (matches `maxContentSizeBytes` in LiveSyncTypes.ts line 33).

**Clarification**: The `_pollDescriptions` implementation above makes a second `fetchStateDeltas` call, which is redundant with the one in `_pollState`. An optimization (deferred to a follow-up) would cache the deltas from `_pollState` and pass them to `_pollDescriptions`. For the initial implementation, the extra API call is acceptable given the 30–120s poll interval and Linear's rate limits.

### `src/services/ContinuousSyncService.ts`

**Context**: The push path in `_executeSync()` (lines 398+) calls `_syncToLinear()` (lines 874–897) which calls `linear.syncPlanContent()` (LinearSyncService.ts line 1953–1986). On success, `lastSyncAt` is updated (line 557) and `lastExternalHash` is set to `lastContentHash` (line 559), but all in-memory only. The constructor (lines 45–51) takes positional parameters.

**Logic**: Add loop prevention hash map and cursor persistence callback. The hash must be computed on the same canonical form as the push path (after `_stripH1Header`).

**Implementation**:

1. Add new instance variable (after line 43):
```typescript
private _externallyWrittenHashes = new Map<string, string>();
```

2. Add public methods:
```typescript
/** Register a content hash for an issue that was written by the inbound (pull) path.
 *  The push path checks this map to avoid re-pushing content we just pulled. */
public markExternallyWritten(issueId: string, contentHash: string): void {
    this._externallyWrittenHashes.set(issueId, contentHash);
}
```

3. Modify `_syncToLinear()` (lines 874–897) — add hash guard at the start:
```typescript
private async _syncToLinear(
    plan: import('./KanbanDatabase').KanbanPlanRecord,
    content: string,
    workspaceRoot: string,
    signal?: AbortSignal
): Promise<{ skipped: boolean; reason?: string }> {
    const linear = this._getLinearService(workspaceRoot);
    const config = await linear.loadConfig();
    if (!plan.linearIssueId) {
        return { skipped: true, reason: 'No external issue linked' };
    }
    if (!config?.setupComplete) {
        return { skipped: true, reason: 'Linear not set up' };
    }
    if (config.realTimeSyncEnabled !== true) {
        return { skipped: true, reason: 'Real-time sync disabled' };
    }

    // Loop prevention: if the content hash matches an externally-written hash,
    // this push was triggered by our own pull — skip it.
    const strippedContent = linear._stripH1Header(content);  // Clarification: need to expose or duplicate _stripH1Header
    const contentHash = crypto.createHash('sha256').update(strippedContent).digest('hex');
    const externalHash = this._externallyWrittenHashes.get(plan.linearIssueId);
    if (externalHash && contentHash === externalHash) {
        this._externallyWrittenHashes.delete(plan.linearIssueId);
        return { skipped: true, reason: 'Content matches externally-pulled version' };
    }

    const result = await linear.syncPlanContent(plan.linearIssueId, content, signal);
    if (!result.success) {
        console.warn(`[ContinuousSync] Linear sync failed for ${plan.planFile}: ${result.error}`);
        throw new Error(result.error);
    }
    return { skipped: false };
}
```

4. On successful push, persist the description cursor. Add a callback to the constructor:
```typescript
// Modify constructor to accept optional callback
constructor(
    private readonly _kanbanProvider: KanbanProvider,
    private readonly _globalPlanWatcher: GlobalPlanWatcherService,
    private readonly _getClickUpService: (workspaceRoot: string) => ClickUpSyncService,
    private readonly _getLinearService: (workspaceRoot: string) => LinearSyncService,
    private readonly _getKanbanDb: (workspaceRoot: string) => KanbanDatabase,
    private readonly _onDescriptionSynced?: (issueId: string, timestamp: string) => void
) {}
```

5. After successful sync (around line 557), call the callback:
```typescript
// After: this._states.set(sessionId, { ...currentState, status: 'active', lastSyncAt: now, ... });
if (plan.linearIssueId && this._onDescriptionSynced) {
    this._onDescriptionSynced(plan.linearIssueId, new Date(now).toISOString());
}
```

**Edge Cases**:
- `_stripH1Header` is a private method on LinearSyncService (line 493–522). It needs to be made public or the stripping logic needs to be duplicated. **Recommendation**: Make it public — it's a pure function with no internal state dependencies.
- The hash guard clears the entry after matching (`this._externallyWrittenHashes.delete(...)`) to avoid memory leaks. If the hash doesn't match (content was modified after pull), the push proceeds normally.
- The `_onDescriptionSynced` callback is optional to maintain backward compatibility with existing callers.

### `src/services/LinearSyncService.ts`

**Context**: `_stripH1Header()` (lines 493–522) is a private method that strips the leading ATX H1 header from markdown content before pushing to Linear. The push path in `syncPlanContent()` (line 1961) calls it before sending the description.

**Logic**: Make `_stripH1Header` public so ContinuousSyncService can compute the hash on the same canonical form.

**Implementation**:
```typescript
// Line 493: Change private to public
public _stripH1Header(markdownContent: string): string {
```

**Edge Cases**: This is a pure function with no side effects — making it public is safe. The leading underscore convention indicates it's internally oriented, but that's acceptable for a utility method shared between services.

### `src/services/KanbanProvider.ts`

**Context**: `_getRemoteControl()` (lines 1438–1471) creates `RemoteControlService` with `RemoteControlDeps`. `setGlobalPlanWatcher()` (lines 456–467) creates `ContinuousSyncService` with positional parameters.

**Logic**: Wire up the new dependencies for both services. Add helper methods for description cursor persistence using the DB config table pattern.

**Implementation**:

1. Add description cursor helper methods:
```typescript
private async _getDescriptionCursors(kind: RemoteProviderKind): Promise<Record<string, string>> {
    const db = this._getKanbanDb(this._resolveWorkspaceRoot());
    if (!db || !(await db.ensureReady())) { return {}; }
    return db.getConfigJson<Record<string, string>>(`remote.descriptionCursor.${kind}`, {});
}

private async _setDescriptionCursor(kind: RemoteProviderKind, issueId: string, timestamp: string): Promise<void> {
    const db = this._getKanbanDb(this._resolveWorkspaceRoot());
    if (!db || !(await db.ensureReady())) { return; }
    const cursors = await this._getDescriptionCursors(kind);
    cursors[issueId] = timestamp;
    await db.setConfigJson(`remote.descriptionCursor.${kind}`, cursors);
}
```

2. Modify `_getRemoteControl()` (lines 1438–1471) — add new deps:
```typescript
private _getRemoteControl(workspaceRoot: string): RemoteControlService {
    const resolved = this.resolveEffectiveWorkspaceRoot(workspaceRoot);
    const existing = this._remoteControls.get(resolved);
    if (existing) { return existing; }
    const service = new RemoteControlService({
        getDb: () => this._getKanbanDb(resolved),
        getWorkspaceId: async () => (await this._getKanbanDb(resolved).getWorkspaceId()) || '',
        getProvider: (kind: RemoteProviderKind): RemoteProvider | null => {
            // ... existing provider construction ...
        },
        onColumnMove: async (plan, targetColumn) => {
            await this._remoteApplyColumnMove(resolved, plan, targetColumn);
        },
        onComment: async (plan, body) => {
            await this._remoteDispatchComment(resolved, plan, body);
        },
        // NEW: description sync deps
        getDescriptionCursors: (kind) => this._getDescriptionCursors(kind),
        setDescriptionCursor: (kind, id, ts) => this._setDescriptionCursor(kind, id, ts),
        onDescriptionPulled: (issueId, hash) => {
            this._continuousSync?.markExternallyWritten(issueId, hash);
        },
        log: (m) => this._outputChannel?.appendLine(m)
    });
    this._remoteControls.set(resolved, service);
    return service;
}
```

3. Modify `setGlobalPlanWatcher()` (lines 456–467) — add callback to ContinuousSyncService:
```typescript
this._continuousSync = new ContinuousSyncService(
    this,
    this._globalPlanWatcher,
    (root) => this._getClickUpService(root),
    (root) => this._getLinearService(root),
    (root) => this._getKanbanDb(root),
    // NEW: on successful push, persist description cursor
    (issueId, ts) => this._setDescriptionCursor('linear', issueId, ts)
);
```

**Edge Cases**:
- `_getDescriptionCursors` and `_setDescriptionCursor` need a workspace root to get the correct DB. The `_getRemoteControl` method already has `resolved` available. For the callback from ContinuousSyncService, the workspace root needs to be captured at construction time or passed through.
- The `_setDescriptionCursor` callback from ContinuousSyncService fires on every successful push. If the plan doesn't have a `linearIssueId`, the callback should be a no-op (the caller already guards on `plan.linearIssueId`).

## Verification Plan

1. **Push path unchanged**: Edit plan locally → ContinuousSyncService pushes → cursor persisted → next poll skips (updatedAt == cursor).
2. **Pull path**: Edit Linear issue description, leave local file untouched → next poll detects change → description written to plan file → no re-push (hash guard).
3. **Conflict path**: Edit both sides between polls → conflict notification shown, no auto-overwrite.
4. **Loop prevention**: After pull, file watcher fires → ContinuousSyncService hash guard triggers → push skipped → no updatedAt bump in Linear → next poll is a no-op.
5. **Reload safety**: Restart extension → cursors loaded from DB → no false positives.
6. **Column+description same cycle**: Edit both column and description in Linear → `_applyStateMirror` refreshes plan → `_pollDescriptions` skips (already refreshed) → no double-write.
7. **Empty description guard**: Linear issue with empty description → pull skipped (never clobber).
8. **Large description guard**: Description >100KB → pull skipped (matches existing `maxContentSizeBytes` limit).

### Automated Tests

- **Existing tests to run**: `src/test/integrations/linear/linear-sync-service.test.js`, `linear-import-flow.test.js`
- **New unit tests needed**:
  - `_pollDescriptions()`: pull branch (remote newer, local unchanged), skip branch (cursor ≥ updatedAt), conflict branch (both sides changed), empty description skip, large description skip, already-refreshed skip
  - `markExternallyWritten()` + hash guard: hash match → push skipped, hash mismatch → push proceeds, hash cleared after match
  - Description cursor persistence: `setDescriptionCursor` → `getDescriptionCursors` round-trip, reload safety
  - `_stripH1Header` (public): verify canonical form matches between push and pull paths

## Uncertain Assumptions

> **Research completed.** The user ran web research (findings in `docs/imported_document_2026_06_27t11_27_53.md`) and the results have been incorporated below.

| Assumption | Verdict | Plan Impact |
|:---|:---|:---|
| Linear `updatedAt` bumps on description change | **CONFIRMED** | Pull-via-`updatedAt` design VALIDATED. Description edits bump `updatedAt`; delta polling will detect them. |
| Comments do NOT bump parent issue `updatedAt` | **CONFIRMED** (corroborated by `notion-remote-control-and-delta-polling.md` plan) | Not a concern for THIS plan (description sync), but means the existing comment-poll path must query the `comments` entity separately — already the case in current code. |
| Linear rate limit budget for extra `fetchStateDeltas` call | **CONFIRMED — more generous than feared.** Personal API keys: 2,500 req/hour (~41/min); OAuth: 5,000 req/hour. Complexity budget: 3M points/hour (personal), 10,000 per single query. | The Grumpy concern about "100 req/min" was overstated. However, **complexity scoring** is the real constraint: connections multiply child-field cost by pagination limit (`first: 50`). The redundant-call mitigation (cache deltas from `_pollState`) is still recommended to avoid complexity budget drain, but request-count limits are not the blocker. Constrain pagination explicitly (e.g. `first: 10`). |
| GraphQL subscriptions / webhooks available as polling alternative | **CONFIRMED — new capability.** GraphQL subscriptions over WebSocket (`graphql-ws` protocol) are now in the public API. Webhooks available on all tiers (including free) but require a public endpoint. | **Future optimization, not v1.** This plan's polling design is valid for v1. A follow-up plan could migrate to WebSocket subscriptions to eliminate polling entirely and reduce API budget consumption. Noted as a future enhancement, not a scope change. |
| VS Code file watcher event scheduling (synchronous hash-set prevents race) | **UNRESOLVED — code/VS Code concern, not Linear API.** | Not researchable via Linear docs. Implementer should verify `onPlanDiscovered` fires asynchronously; if synchronous, the hash must be set in a microtask before the write. Low risk — test empirically. |
| `_stripH1Header` determinism across calling contexts | **UNRESOLVED — code concern.** | Pure function, should be deterministic. Edge cases (BOM, mixed line endings) should be covered by unit tests. Not a Linear API question. |
| **What does `issueUpdate` do on an archived Linear issue?** | **RESOLVED — `issueUpdate` FAILS on archived issues.** Per the research, archived issues are in a read-only state. `issueUpdate` calls return an error or `success: false`. The issue must first be restored via `issueUnarchive` before any updates can be applied. | **Mitigated by the auto-archive plan's Task 10** (unarchive → push → re-archive). The issue is temporarily restored, the content push succeeds, then the issue is re-archived. This keeps content in sync while keeping the issue archived. If a plan is moved back from CODE REVIEWED for rework, the archive dance no longer fires, but `syncPlan()` falls back to `createIssue()` on `issueUpdate` failure (creating a fresh issue). No further research needed. |

**Summary:** The core Linear-API assumptions are all CONFIRMED: description bumps `updatedAt` (pull design validated), rate limits are generous (2,500 req/hour), and `issueUpdate` fails on archived issues (resolved by the auto-archive plan's unarchive → push → re-archive flow in Task 10). Two minor VS Code/code-level concerns remain open (file watcher timing, `_stripH1Header` determinism) — both low risk. No further research needed before implementation.

## Recommendation

**Complexity: 7 → Send to Lead Coder**

This plan touches 4 files with bidirectional sync state, loop prevention, and conflict logic. The highest-risk aspect is the pull-write-push feedback loop — if the hash guard doesn't match the canonical form exactly, the system will enter an infinite sync loop. The constructor signature changes for ContinuousSyncService and RemoteControlService require careful migration of existing callers. A Lead Coder should implement this with careful attention to the hash canonical form and the race condition between pull and push.
