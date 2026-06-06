# Fix Backend sessionId-Only Card Lookup for Sessionless Plans

## Goal

Switch all backend card lookups from `sessionId`-only matching to `planId`-primary matching (with `sessionId` as legacy fallback), so that every button, column move, batch action, prompt copy, and dispatch works correctly for plans without an active session.

**Core Problem:** After the frontend fix (plan `brain_41f718e0...`) switched DOM selectors to `planId`-primary, the frontend now sends `planId` values in `sessionIds` arrays for sessionless cards. The backend uses `msg.sessionIds.includes(card.sessionId)`, `c.sessionId === sid`, and `card.sessionId` as map keys throughout `KanbanProvider` and `TaskViewerProvider`. For sessionless plans, `card.sessionId` is empty, so these lookups always fail — causing: (1) no prompt is generated or copied to clipboard, (2) no column advancement is persisted, (3) cards "bounce back" to their origin after the next board refresh, (4) batch actions silently skip sessionless cards, (5) dispatch and pair-programming checks miss sessionless cards.

**Background:** The database layer (`KanbanDatabase.getPlanBySessionId`) already has a fallback: if the `session_id` column lookup fails, it tries `plan_id`. This is why `moveCardToColumn` works for sessionless plans when given a planId in the `sessionId` parameter. However, the in-memory `_lastCards` filtering used by prompt generation handlers has no such fallback — it matches directly against `card.sessionId`, which is empty for new plans. The `KanbanCard` interface (KanbanProvider.ts line 81) and `KanbanPlanRecord` interface (KanbanDatabase.ts line 19) both guarantee that `planId` is always present.

**Root Cause:** The frontend previously sent empty strings in `sessionIds` for sessionless cards, so the backend never matched them. Now the frontend sends `planId` values, but the backend's `_lastCards` filters and `KanbanDispatchCard` lookups still only check `card.sessionId` — they never check `card.planId`.

**Antigravity Prefix Mismatch:** This bug also affects preexisting Antigravity (brain-sourced) plans. In the DB, Antigravity plans store `session_id` with an `antigravity_` prefix (e.g., `antigravity_563b5c1c...`) while `plan_id` stores the raw hash (e.g., `563b5c1c...`). The frontend now sends the raw `planId` hash for all cards. The backend's `msg.sessionIds.includes(card.sessionId)` check fails because the incoming raw hash doesn't match `card.sessionId` (which is `antigravity_563b5c1c...`). The `_cardMatchesIds` helper fixes this by checking `card.planId` first — the raw hash matches `card.planId` (which is `563b5c1c...`). No data migration is needed; the existing DB data is correct. The plan's changes only affect in-memory matching and map keying, not the DB schema or stored data.

**DB Write Method Gaps:** The deprecated DB write methods that already route through `getPlanBySessionId()` (`updateColumn`, `updateStatus`, `updateTopic`) work correctly when given a planId value because `getPlanBySessionId` has the planId fallback. However, several other deprecated DB write methods (`deletePlan`, `updatePlanWorktree`, `updatePlanWorktreeStatus`, `hasPlan`, `getPlanFilePath`, `updatePlanFile`, `updateSessionId`, `reviveDeletedPlans`, `updateMetadataBatch`, `completeMultiple`) use direct `WHERE session_id = ?` SQL without any fallback. If called with a raw planId hash (e.g., from `_cardId(card)` or from the plan registry), these methods silently fail — the SQL matches zero rows. This plan adds the same `getPlanBySessionId`-then-resolve pattern to all of these methods, consistent with how `updateColumn`/`updateStatus`/`updateTopic` already work.

## Metadata

**Tags:** backend, bugfix
**Complexity:** 5

## User Review Required

> [!NOTE]
> This is the backend counterpart to the frontend planId-primary selector fix. Without this fix, the frontend optimistic move works but the backend silently fails to generate prompts or advance cards for sessionless plans. The `moveCardToColumn` path already works via the DB fallback — this fix addresses the remaining `_lastCards` filter/find paths, `KanbanDispatchCard` lookups, map keying, and DB write method fallbacks.

No open questions.

## Complexity Audit

### Routine
- Replacing `msg.sessionIds.includes(card.sessionId)` with `_cardMatchesIds` helper at 6 sites in KanbanProvider
- Replacing `c.sessionId === sid` with `(c.planId || c.sessionId) === sid` at 4 sites in KanbanProvider
- Replacing `sessionIdToCard.set(card.sessionId, card)` with dual-keyed map in `_calculateBlockingDependencies`
- Replacing `sourceCards.map(card => card.sessionId)` with `card.planId || card.sessionId` at 5 sites
- Replacing `repoScopeMap.get(card.sessionId)` with `card.planId || card.sessionId` key in `_cardsToPromptPlans` and `_buildRepoScopeMap`
- Adding `planId` field to `KanbanDispatchCard` type and updating `_collectKanbanCardsInColumns` and `_getAutobanStateFromDb` to populate it
- Updating `_activeDispatchSessions` map keying in TaskViewerProvider to use planId-primary keys
- Updating `_getKanbanRecordForSession` to check both `planId` and `sessionId` on DB board rows
- Updating MERGE column handler to use planId-primary IDs instead of `.filter(Boolean)` on empty sessionIds
- Adding `getPlanBySessionId` fallback to 10 deprecated DB write methods in KanbanDatabase.ts — same pattern as existing `updateColumn`/`updateStatus`/`updateTopic`
- All changes follow the same planId-primary identity model established in the frontend fix

### Complex / Risky
- The `KanbanDispatchCard` type change and `_activeDispatchSessions` map keying in TaskViewerProvider touch the Autoban dispatch system — need to ensure the dispatch lock/release cycle still works correctly when keyed by planId
- The `_getAutobanStateFromDb` method is a parallel path to `_collectKanbanCardsInColumns` — both must use consistent planId-primary keying or `_releaseSettledDispatchLocks` will fail to match keys across the two map sources
- Antigravity (brain-sourced) plans have `antigravity_`-prefixed `session_id` in the DB but raw-hash `plan_id` — the `_cardId`/`_dispatchCardId` helpers return the raw hash, which must still work with DB operations that route through `getPlanBySessionId` (which has the planId fallback). No data migration needed.
- The `updatePlanFile` and `updateSessionId` methods have debug logging and verification queries that also use `WHERE session_id = ?` — these must be updated alongside the main SQL to avoid confusing log output
- The `updateMetadataBatch` and `completeMultiple` methods use transactional SQL with per-row `WHERE session_id = ?` — each row's ID must be resolved via `getPlanBySessionId` before the UPDATE, or the SQL must be changed to use `plan_id`

## Edge-Case & Dependency Audit

- **Race Conditions:** No new race conditions. The `_lastCards` array is populated by `_refreshBoard` before any handler runs, and the filter/find operations are synchronous. The DB method fallbacks add an extra read (`getPlanBySessionId`) before each write, but this is a point read on an indexed column and does not introduce contention.
- **Security:** No security implications. The IDs being matched are the same values already sent by the frontend — just now correctly resolved.
- **Side Effects:** Handlers that previously silently failed for sessionless cards will now correctly find and process those cards. This is the intended behavior change. DB write methods that previously silently no-op'd when given a planId will now correctly resolve and write.
- **Dependencies & Conflicts:** Depends on the frontend fix being in place (the frontend must send `planId` values in `sessionIds` arrays). If the frontend still sends empty strings, the backend fallback won't help.

## Dependencies

- Frontend planId-primary selector fix (plan `brain_41f718e0...`) — must be implemented first so the frontend sends planId values in `sessionIds` arrays.

## Adversarial Synthesis

Key risks: (1) The `_getAutobanStateFromDb` method was initially missed — it builds the same `currentColumnBySession` map and `cardsInColumn` array as `_collectKanbanCardsInColumns` but using sessionId-only keys. If only one is fixed, `_releaseSettledDispatchLocks` will have inconsistent keys and dispatch locks will never release for sessionless cards. (2) The `_getKanbanRecordForSession` method uses `.find(entry => entry.sessionId === sessionId)` on the DB board array, which fails for sessionless cards. (3) The MERGE column handler silently drops sessionless cards via `.filter(Boolean)`. (4) Antigravity (brain-sourced) plans have `antigravity_`-prefixed `session_id` in the DB but raw-hash `plan_id` — the frontend sends the raw hash, so the `sessionId`-only lookups fail for these cards too. No data migration is needed; the `_cardMatchesIds` helper resolves this by checking `card.planId` first. (5) Ten deprecated DB write methods use direct `WHERE session_id = ?` without the planId fallback — if called with a planId value (from `_cardId(card)`, the plan registry, or any future planId-primary caller), they silently no-op. Mitigations: All in-memory gaps have been identified and added as fixes #24-30; all DB method gaps are addressed in fixes #31-40 using the same `getPlanBySessionId`-then-resolve pattern already proven in `updateColumn`/`updateStatus`/`updateTopic`; the `_cardMatchesIds` and `_cardId`/`_dispatchCardId` helpers centralize the matching logic.

## Proposed Changes

### A. KanbanProvider.ts

#### 1. Add helper methods for planId-primary ID matching

**Context:** Multiple handlers filter `_lastCards` using `msg.sessionIds.includes(card.sessionId)`. This fails when the frontend sends a `planId` value for a sessionless card. A shared helper centralizes the matching logic.

**Implementation:** Add two private methods to `KanbanProvider`:

```ts
/** Check if a card matches any ID in the given array (planId-primary, sessionId-legacy). */
private _cardMatchesIds(card: KanbanCard, ids: string[]): boolean {
    const cardKey = card.planId || card.sessionId;
    return ids.includes(cardKey) || (card.sessionId && ids.includes(card.sessionId));
}

/** Get the primary identifier for a card (planId-first, sessionId-legacy). */
private _cardId(card: KanbanCard): string {
    return card.planId || card.sessionId;
}
```

#### 2. `promptOnDrop` handler — card matching (line 4915)

**Context:** Filters `_lastCards` by `sessionIds.includes(card.sessionId)`. Sessionless cards are never found, so no prompt is generated and `promptOnDropResult` returns `{ success: false }`.

**Implementation:**
```ts
// BEFORE (line 4914-4915):
const sourceCards = this._lastCards.filter(card =>
    card.workspaceRoot === workspaceRoot && sessionIds.includes(card.sessionId)
);

// AFTER:
const sourceCards = this._lastCards.filter(card =>
    card.workspaceRoot === workspaceRoot && this._cardMatchesIds(card, sessionIds)
);
```

#### 3. `moveSelected` handler — lead card pair-programming filter (line 5112)

**Context:** After dispatching to a custom column in lead role, filters `_lastCards` to find high-complexity lead cards for pair programming. Sessionless cards are missed.

**Implementation:**
```ts
// BEFORE (line 5111-5112):
const leadCards = this._lastCards.filter(card =>
    card.workspaceRoot === workspaceRoot && msg.sessionIds.includes(card.sessionId)
).filter(card => !this._isLowComplexity(card) && card.complexity !== 'Unknown');

// AFTER:
const leadCards = this._lastCards.filter(card =>
    card.workspaceRoot === workspaceRoot && this._cardMatchesIds(card, msg.sessionIds)
).filter(card => !this._isLowComplexity(card) && card.complexity !== 'Unknown');
```

#### 4. `chatWorkflow` handler — selected card matching (line 5239)

**Context:** Filters `_lastCards` to build chat prompt plans. Sessionless cards are excluded from the chat prompt.

**Implementation:**
```ts
// BEFORE (line 5238-5239):
const selectedCards = this._lastCards.filter(card =>
    card.workspaceRoot === workspaceRoot && msg.sessionIds.includes(card.sessionId)
);

// AFTER:
const selectedCards = this._lastCards.filter(card =>
    card.workspaceRoot === workspaceRoot && this._cardMatchesIds(card, msg.sessionIds)
);
```

Also update the `chatPlans` mapping on line 5244 to use planId-primary:
```ts
// BEFORE:
chatPlans = selectedCards.map(card => ({
    topic: card.topic,
    absolutePath: this._resolvePlanFilePath(workspaceRoot, card.planFile),
    sessionId: card.sessionId,
}));

// AFTER:
chatPlans = selectedCards.map(card => ({
    topic: card.topic,
    absolutePath: this._resolvePlanFilePath(workspaceRoot, card.planFile),
    sessionId: this._cardId(card),
}));
```

#### 5. `promptSelected` handler — card matching (line 5272)

**Context:** The primary "Copy Prompt" handler. Filters `_lastCards` by `msg.sessionIds.includes(card.sessionId)`. When this returns empty, the backend shows "No matching plans found" and does NOT copy the prompt to clipboard or advance the card. This is the most user-visible failure.

**Implementation:**
```ts
// BEFORE (line 5272):
const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && msg.sessionIds.includes(card.sessionId));

// AFTER:
const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && this._cardMatchesIds(card, msg.sessionIds));
```

#### 6. `testingFailureReport` handler — card matching (line 5809)

**Context:** Filters `_lastCards` for testing failure reports. Sessionless cards are excluded from the failure report prompt.

**Implementation:**
```ts
// BEFORE (line 5808-5809):
const sourceCards = this._lastCards.filter(card =>
    card.workspaceRoot === workspaceRoot && msg.sessionIds.includes(card.sessionId)
);

// AFTER:
const sourceCards = this._lastCards.filter(card =>
    card.workspaceRoot === workspaceRoot && this._cardMatchesIds(card, msg.sessionIds)
);
```

#### 7. `triggerAction` / CLI dispatch — `_lastCards.find` by sessionId (lines 4545, 4560, 4583)

**Context:** Three `_lastCards.find(c => c.sessionId === sessionId ...)` calls in the `triggerAction` handler for pair-programming, IDE lead mode, and pair-programming dispatch. Sessionless cards are never found, so pair-programming is never triggered for them.

**Implementation:** Replace all 3 occurrences with planId-primary matching:
```ts
// Line 4545:
const card = this._lastCards.find(c => (c.planId || c.sessionId) === sessionId && c.workspaceRoot === workspaceRoot);

// Line 4560:
const card = this._lastCards.find(c => (c.planId || c.sessionId) === sessionId && c.workspaceRoot === workspaceRoot);

// Line 4583:
const card = this._lastCards.find(c => (c.planId || c.sessionId) === sessionId && c.workspaceRoot === workspaceRoot);
```

#### 8. `pairProgramCard` handler — `_lastCards.find` (line 5675)

**Context:** Finds a card by `c.sessionId === resolvedSessionId` for pair-programming. Sessionless cards are never found.

**Implementation:**
```ts
// BEFORE (line 5675):
const card = this._lastCards.find(c => c.sessionId === resolvedSessionId);

// AFTER:
const card = this._lastCards.find(c => (c.planId || c.sessionId) === resolvedSessionId);
```

Also update the `repoScopeMap` keying on lines 5685-5687:
```ts
// BEFORE:
const plan = await db.getPlanBySessionId(card.sessionId);
if (plan?.repoScope) {
    repoScopeMap.set(card.sessionId, plan.repoScope);
}

// AFTER:
const cardKey = this._cardId(card);
const plan = await db.getPlanBySessionId(cardKey);
if (plan?.repoScope) {
    repoScopeMap.set(cardKey, plan.repoScope);
}
```

#### 9. `copyGatherPrompt` handler — `_lastCards.find` (line 6086)

**Context:** Finds a card by `c.sessionId === resolvedSessionId` for gather prompt copy. Sessionless cards are never found, so no prompt is copied.

**Implementation:**
```ts
// BEFORE (line 6086):
const card = this._lastCards.find(c => c.sessionId === resolvedSessionId);

// AFTER:
const card = this._lastCards.find(c => (c.planId || c.sessionId) === resolvedSessionId);
```

#### 10. `copyExecutePrompt` handler — `_lastCards.find` (line 6102)

**Context:** Finds a card by `c.sessionId === msg.sessionId` for execute prompt copy. Sessionless cards are never found.

**Implementation:**
```ts
// BEFORE (line 6102):
const card = this._lastCards.find(c => c.sessionId === msg.sessionId);

// AFTER:
const card = this._lastCards.find(c => (c.planId || c.sessionId) === msg.sessionId);
```

#### 11. `_filterUnknownComplexitySessions` — `_lastCards.find` (line 4099)

**Context:** Filters session IDs by complexity score for PLAN REVIEWED routing. Uses `c.sessionId === sid` which fails for sessionless cards, causing them to be skipped from complexity routing.

**Implementation:**
```ts
// BEFORE (line 4099):
const card = this._lastCards.find(c => c.sessionId === sid);

// AFTER:
const card = this._lastCards.find(c => (c.planId || c.sessionId) === sid);
```

#### 12. `completeAll` handler — `card.sessionId` in DB operations (lines 5538-5546)

**Context:** Completes all cards in CODE REVIEWED column. Uses `card.sessionId` for `db.updateColumn`, `_schedulePlanStateWrite`, `db.updateStatus`, and `completePlanFromKanban`. For sessionless cards, `card.sessionId` is empty, so these DB operations fail silently.

**Implementation:**
```ts
// BEFORE (lines 5537-5546):
for (const card of reviewedCards) {
    await dbAll.updateColumn(card.sessionId, 'COMPLETED');
    _schedulePlanStateWrite(dbAll, workspaceRoot, card.sessionId, 'COMPLETED',
        'completed').catch(() => { /* fire-and-forget */ });
    await dbAll.updateStatus(card.sessionId, 'completed');
}
let successCount = 0;
for (const card of reviewedCards) {
    const ok = await vscode.commands.executeCommand<boolean>('switchboard.completePlanFromKanban', card.sessionId, workspaceRoot);

// AFTER:
for (const card of reviewedCards) {
    const cardKey = this._cardId(card);
    await dbAll.updateColumn(cardKey, 'COMPLETED');
    _schedulePlanStateWrite(dbAll, workspaceRoot, cardKey, 'COMPLETED',
        'completed').catch(() => { /* fire-and-forget */ });
    await dbAll.updateStatus(cardKey, 'completed');
}
let successCount = 0;
for (const card of reviewedCards) {
    const cardKey = this._cardId(card);
    const ok = await vscode.commands.executeCommand<boolean>('switchboard.completePlanFromKanban', cardKey, workspaceRoot);
```

#### 13. `moveAll` handler — `sourceCards.map(card => card.sessionId)` (line 5156)

**Context:** Extracts session IDs from all cards in a column for batch move. Sessionless cards produce empty strings, which `moveCardToColumn` handles via the DB fallback, but downstream `sessionIds` arrays passed to `postMessage` and dispatch commands contain empty strings.

**Implementation:**
```ts
// BEFORE (line 5156):
const sessionIds = sourceCards.map(card => card.sessionId);

// AFTER:
const sessionIds = sourceCards.map(card => this._cardId(card));
```

#### 14. `promptAll` handler — `sourceCards.map(card => card.sessionId)` (line 5369)

**Context:** Extracts session IDs from all cards in a column for batch prompt. Same issue as #13.

**Implementation:**
```ts
// BEFORE (line 5369):
const sessionIds = sourceCards.map(card => card.sessionId);

// AFTER:
const sessionIds = sourceCards.map(card => this._cardId(card));
```

#### 15. `batchPlannerPrompt` handler — `sourceCards.map(card => card.sessionId)` (line 4998)

**Context:** Batch planner prompt advancement. Sessionless cards produce empty strings in the `sessionIds` array passed to `_advanceSessionsInColumn`.

**Implementation:**
```ts
// BEFORE (line 4998):
const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => card.sessionId), 'CREATED', 'improve-plan', workspaceRoot);

// AFTER:
const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => this._cardId(card)), 'CREATED', 'improve-plan', workspaceRoot);
```

#### 16. `batchLowCoderPrompt` handler — `sourceCards.map(card => card.sessionId)` (line 5027)

**Context:** Batch low-complexity coder prompt advancement. Same issue.

**Implementation:**
```ts
// BEFORE (line 5027):
const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => card.sessionId), 'PLAN REVIEWED', undefined, workspaceRoot);

// AFTER:
const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => this._cardId(card)), 'PLAN REVIEWED', undefined, workspaceRoot);
```

#### 17. `dispatchJules` handler — `sourceCards.map(card => card.sessionId)` (line 5048)

**Context:** Jules dispatch eligibility check. Sessionless cards produce empty strings.

**Implementation:**
```ts
// BEFORE (line 5048):
const eligibleSessionIds = await this._getEligibleSessionIds(sourceCards.map(card => card.sessionId), 'PLAN REVIEWED', workspaceRoot);

// AFTER:
const eligibleSessionIds = await this._getEligibleSessionIds(sourceCards.map(card => this._cardId(card)), 'PLAN REVIEWED', workspaceRoot);
```

#### 18. `customColumnTrigger` handler — `_lastCards.filter` by sessionId (line 6010)

**Context:** Custom column trigger filters `_lastCards` by `sessionIds.includes(c.sessionId)`. Sessionless cards are excluded.

**Implementation:**
```ts
// BEFORE (line 6009-6010):
const cards = this._lastCards.filter(c =>
    c.workspaceRoot === workspaceRoot && sessionIds.includes(c.sessionId)
);

// AFTER:
const cards = this._lastCards.filter(c =>
    c.workspaceRoot === workspaceRoot && this._cardMatchesIds(c, sessionIds)
);
```

#### 19. `_calculateBlockingDependencies` — map keying (line 1738)

**Context:** Builds a `sessionIdToCard` map keyed by `card.sessionId`. When dependency strings use `planId` format (as the frontend now sends), the `sessionIdToCard.get(dep)` lookup fails and dependencies are not resolved.

**Implementation:** Build a dual-keyed map — register each card under both its `planId` and `sessionId` so that lookups by either ID format succeed:

```ts
// BEFORE (lines 1736-1739):
private _calculateBlockingDependencies(cards: KanbanCard[]): void {
    const sessionIdToCard = new Map<string, KanbanCard>();
    for (const card of cards) {
        sessionIdToCard.set(card.sessionId, card);
    }

// AFTER:
private _calculateBlockingDependencies(cards: KanbanCard[]): void {
    const idToCard = new Map<string, KanbanCard>();
    for (const card of cards) {
        if (card.planId) { idToCard.set(card.planId, card); }
        if (card.sessionId) { idToCard.set(card.sessionId, card); }
    }
```

Then update the lookup on line 1748:
```ts
// BEFORE:
const depCard = sessionIdToCard.get(dep);

// AFTER:
const depCard = idToCard.get(dep);
```

#### 20. `_resolveSessionIds` — planId fallback when card has no sessionId (lines 298-299)

**Context:** This helper resolves `planIds` to `sessionIds` by looking up cards. When a card has no `sessionId`, the planId is currently dropped. It should fall back to using the `planId` as the identifier.

**Implementation:**
```ts
// BEFORE (lines 296-300):
if (planIds && this._lastCards) {
    for (const pid of planIds) {
        if (!pid) { continue; }
        const card = this._lastCards.find(c => c.planId === pid);
        if (card?.sessionId) { resolved.add(card.sessionId); }
    }
}

// AFTER:
if (planIds && this._lastCards) {
    for (const pid of planIds) {
        if (!pid) { continue; }
        const card = this._lastCards.find(c => c.planId === pid);
        if (card) { resolved.add(card.sessionId || card.planId); }
    }
}
```

#### 21. `_cardsToPromptPlans` — `repoScopeMap` keying and `sessionId` field (lines 2218, 2225, 2239)

**Context:** This method looks up `repoScope` by `card.sessionId` key, and sets `sessionId: card.sessionId` on the returned prompt plan. For sessionless cards, the `repoScopeMap.get(card.sessionId)` returns `undefined` (wrong key), and the `sessionId` field is empty.

**Implementation:**
```ts
// BEFORE (line 2218):
const repoScope = repoScopeMap?.get(card.sessionId) || '';

// AFTER:
const repoScope = repoScopeMap?.get(this._cardId(card)) || '';
```

```ts
// BEFORE (line 2225):
const plan = await db.getPlanBySessionId(card.sessionId);

// AFTER:
const plan = await db.getPlanBySessionId(this._cardId(card));
```

```ts
// BEFORE (line 2239):
sessionId: card.sessionId,

// AFTER:
sessionId: this._cardId(card),
```

#### 22. `_buildRepoScopeMap` — map keying (lines 2300-2302, 2964-2966, 3165-3167)

**Context:** Three copies of the same pattern: `repoScopeMap.set(card.sessionId, plan.repoScope)`. For sessionless cards, the key is empty, so subsequent lookups by `this._cardId(card)` (after fix #21) won't find the entry.

**Implementation:** All 3 sites use the same fix:
```ts
// BEFORE:
const plan = await db.getPlanBySessionId(card.sessionId);
if (plan?.repoScope) {
    repoScopeMap.set(card.sessionId, plan.repoScope);
}

// AFTER:
const cardKey = this._cardId(card);
const plan = await db.getPlanBySessionId(cardKey);
if (plan?.repoScope) {
    repoScopeMap.set(cardKey, plan.repoScope);
}
```

Applied at lines 2300-2302, 2964-2966, and 3165-3167.

#### 23. MERGE column handler — `dbRows.map(row => row.sessionId).filter(Boolean)` (line 6506)

**Context:** Extracts session IDs from MERGE column rows. The `.filter(Boolean)` silently drops sessionless cards (empty `sessionId`), so they are never merged or completed from the MERGE column. This is a data loss bug for sessionless plans that reach the MERGE state.

**Implementation:**
```ts
// BEFORE (line 6506):
const sessionIds = dbRows.filter(row => row.kanbanColumn === 'MERGE').map(row => row.sessionId).filter(Boolean);

// AFTER:
const sessionIds = dbRows.filter(row => row.kanbanColumn === 'MERGE').map(row => row.planId || row.sessionId).filter(Boolean);
```

### B. TaskViewerProvider.ts

#### 24. Add `planId` field to `KanbanDispatchCard` type (lines 93-98)

**Context:** The `KanbanDispatchCard` type only has `sessionId`. The Autoban dispatch system uses `card.sessionId` as the key for `_activeDispatchSessions` map and for building `sessionIds` arrays. For sessionless plans, `sessionId` is empty, so dispatch locks and session ID arrays are broken.

**Implementation:**
```ts
// BEFORE (lines 93-98):
type KanbanDispatchCard = {
    sessionId: string;
    lastActivity: string;
    planFile?: string;
    sourceColumn: string;
};

// AFTER:
type KanbanDispatchCard = {
    sessionId: string;
    planId: string;
    lastActivity: string;
    planFile?: string;
    sourceColumn: string;
};
```

#### 25. `_collectKanbanCardsInColumns` — populate `planId` (line 6542)

**Context:** Constructs `KanbanDispatchCard` from DB rows. Currently only sets `sessionId: row.sessionId`. Must also set `planId`.

**Implementation:**
```ts
// BEFORE (line 6542):
cardsInColumn.push({ sessionId: row.sessionId, lastActivity: row.updatedAt || row.createdAt, planFile: resolvedPlanPath, sourceColumn: row.kanbanColumn });

// AFTER:
cardsInColumn.push({ sessionId: row.sessionId, planId: row.planId, lastActivity: row.updatedAt || row.createdAt, planFile: resolvedPlanPath, sourceColumn: row.kanbanColumn });
```

Also update `currentColumnBySession` map keying on line 6531 to be planId-primary:
```ts
// BEFORE:
currentColumnBySession.set(row.sessionId, row.kanbanColumn);

// AFTER:
currentColumnBySession.set(row.planId || row.sessionId, row.kanbanColumn);
```

#### 26. `_getAutobanStateFromDb` — populate `planId` and planId-primary map keying (lines 2198-2234)

**Context:** This method is a parallel path to `_collectKanbanCardsInColumns` that builds the same `currentColumnBySession` map and `cardsInColumn` array from DB rows. It currently uses `row.sessionId` for both map keying and card construction. If only `_collectKanbanCardsInColumns` is fixed, the `_releaseSettledDispatchLocks` method will receive inconsistent keys — `_activeDispatchSessions` will have planId-primary keys but `currentColumnBySession` from this path will have sessionId-only keys, causing dispatch locks to never release for sessionless cards.

**Implementation:**
```ts
// BEFORE (line 2214):
currentColumnBySession.set(row.sessionId, row.kanbanColumn);

// AFTER:
currentColumnBySession.set(row.planId || row.sessionId, row.kanbanColumn);
```

```ts
// BEFORE (lines 2226-2230):
cardsInColumn.push({
    sessionId: row.sessionId,
    lastActivity: row.updatedAt || row.createdAt || '',
    planFile: resolvedPlanPath
});

// AFTER:
cardsInColumn.push({
    sessionId: row.sessionId,
    planId: row.planId,
    lastActivity: row.updatedAt || row.createdAt || '',
    planFile: resolvedPlanPath
});
```

Note: The return type of `_getAutobanStateFromDb` declares `cardsInColumn` as `{ sessionId: string; lastActivity: string; planFile?: string }[]`. After adding `planId`, this type annotation must be updated to include `planId: string`. Alternatively, the method could return `KanbanDispatchCard[]` for type consistency with `_collectKanbanCardsInColumns`.

#### 27. `_activeDispatchSessions` map keying — planId-primary (lines 5712, 5738, 7358-7360, 7409, 7473, 7480, 7490)

**Context:** The `_activeDispatchSessions` map tracks which cards have been dispatched to prevent re-dispatch. It's keyed by `card.sessionId`. For sessionless cards, the key is empty, so the lock never takes effect and cards can be re-dispatched. The `_releaseSettledDispatchLocks` method (line 6555) also looks up by `sessionId` key.

**Implementation:** Add a helper to get the primary ID for a dispatch card, then use it consistently:

```ts
/** Get the primary identifier for a dispatch card (planId-first, sessionId-legacy). */
private _dispatchCardId(card: KanbanDispatchCard): string {
    return card.planId || card.sessionId;
}
```

Then update all sites:

Line 5712 — eligibility filter:
```ts
// BEFORE:
.filter(card => this._activeDispatchSessions.get(card.sessionId) !== card.sourceColumn);

// AFTER:
.filter(card => this._activeDispatchSessions.get(this._dispatchCardId(card)) !== card.sourceColumn);
```

Line 5738 — selected card push:
```ts
// BEFORE:
selectedCards.push({ sessionId: card.sessionId, complexity, sourceColumn: card.sourceColumn });

// AFTER:
selectedCards.push({ sessionId: this._dispatchCardId(card), complexity, sourceColumn: card.sourceColumn });
```

Lines 7358-7360 — dispatch session tracking:
```ts
// BEFORE:
const sessionIds = cards.map(card => card.sessionId);
cards.forEach(card => this._activeDispatchSessions.set(card.sessionId, card.sourceColumn));

// AFTER:
const sessionIds = cards.map(card => this._dispatchCardId(card));
cards.forEach(card => this._activeDispatchSessions.set(this._dispatchCardId(card), card.sourceColumn));
```

Line 7409 — routed sessions push:
```ts
// BEFORE:
routedSessions[targetRole].push({ sessionId: card.sessionId, sourceColumn: card.sourceColumn });

// AFTER:
routedSessions[targetRole].push({ sessionId: this._dispatchCardId(card), sourceColumn: card.sourceColumn });
```

Line 7473 — batch dispatch low eligibility:
```ts
// BEFORE:
.filter(card => this._activeDispatchSessions.get(card.sessionId) !== sourceColumn);

// AFTER:
.filter(card => this._activeDispatchSessions.get(this._dispatchCardId(card)) !== sourceColumn);
```

Line 7480 — available low sessions:
```ts
// BEFORE:
availableLowSessions.push(card.sessionId);

// AFTER:
availableLowSessions.push(this._dispatchCardId(card));
```

Line 7490 — dispatch lock:
```ts
// BEFORE:
sessionIds.forEach(id => this._activeDispatchSessions.set(id, sourceColumn));

// AFTER: (no change needed — sessionIds already contains planId-primary IDs from line 7489)
```

#### 28. `_releaseSettledDispatchLocks` — map key consistency (lines 6555-6560)

**Context:** This method iterates `_activeDispatchSessions` and checks if the card has moved by looking up in `currentColumnBySession`. Both maps must use the same key scheme (planId-primary) for the lookup to work.

**Implementation:** The `currentColumnBySession` map was updated in fixes #25 and #26 to use `row.planId || row.sessionId` keys. The `_activeDispatchSessions` map was updated in fix #27 to use `_dispatchCardId(card)` keys. Both now use planId-primary keys, so the existing `_releaseSettledDispatchLocks` logic works without changes — the keys are consistent.

#### 29. `_getKanbanRecordForSession` — planId-or-sessionId lookup (line 1913)

**Context:** This method finds a kanban record by `.find(entry => entry.sessionId === sessionId)` on the DB board array. For sessionless cards, `entry.sessionId` is empty, so the find always returns `undefined`. This method is called from dispatch and metadata refresh flows, causing those operations to silently fail for sessionless plans.

**Implementation:**
```ts
// BEFORE (line 1913):
return (await db.getBoard(workspaceId)).find(entry => entry.sessionId === sessionId);

// AFTER:
return (await db.getBoard(workspaceId)).find(entry => entry.sessionId === sessionId || entry.planId === sessionId);
```

### C. KanbanDatabase.ts — Add planId fallback to deprecated write methods

All methods below currently use `WHERE session_id = ?` directly. The fix adds the same `getPlanBySessionId`-then-resolve pattern already used by `updateColumn`, `updateStatus`, and `updateTopic`: resolve the input ID to a plan record via `getPlanBySessionId` (which tries `session_id` first, then `plan_id`), then use the resolved plan's `planId` for the actual SQL operation. This ensures the methods work correctly whether called with a `sessionId` (e.g., `antigravity_563b5c1c...`) or a raw `planId` hash (e.g., `563b5c1c...`).

#### 30. `deletePlan(sessionId)` — add fallback (line 1757)

**Context:** Uses `DELETE FROM plans WHERE session_id = ?`. If called with a raw planId hash, no rows match and the delete silently fails. Called from plan deletion flows (TaskViewerProvider lines 9508, 10118, 10124, 11471, 12103, 13581, 14045). Line 9508 already passes `planId` instead of `sessionId` — a preexisting bug that this fix resolves.

**Implementation:**
```ts
// BEFORE (line 1757):
public async deletePlan(sessionId: string): Promise<boolean> {
    return this._persistedUpdate(
        'DELETE FROM plans WHERE session_id = ?',
        [sessionId]
    );
}

// AFTER:
/** @deprecated session_id is no longer the unique key; use deletePlanByPlanFile instead. */
public async deletePlan(sessionId: string): Promise<boolean> {
    const plan = await this.getPlanBySessionId(sessionId);
    if (!plan) return false;
    return this._persistedUpdate(
        'DELETE FROM plans WHERE plan_id = ?',
        [plan.planId]
    );
}
```

#### 31. `updatePlanWorktree(sessionId, worktreeId)` — add fallback (line 1470)

**Context:** Uses `UPDATE plans SET worktree_id = ? WHERE session_id = ?`. If called with a raw planId hash, the UPDATE silently no-ops. Called from worktree management flows (KanbanProvider lines 6371, 6791, 6995, 7042).

**Implementation:**
```ts
// BEFORE (line 1470):
public async updatePlanWorktree(sessionId: string, worktreeId: number | null): Promise<void> {
    if (!this._db) return;
    this._db.run(
        'UPDATE plans SET worktree_id = ? WHERE session_id = ?',
        [worktreeId, sessionId]
    );
    await this._persist();
}

// AFTER:
public async updatePlanWorktree(sessionId: string, worktreeId: number | null): Promise<void> {
    if (!this._db) return;
    const plan = await this.getPlanBySessionId(sessionId);
    if (!plan) return;
    this._db.run(
        'UPDATE plans SET worktree_id = ? WHERE plan_id = ?',
        [worktreeId, plan.planId]
    );
    await this._persist();
}
```

#### 32. `updatePlanWorktreeStatus(sessionId, status)` — add fallback (line 1479)

**Context:** Uses `UPDATE plans SET worktree_status = ? WHERE session_id = ?`. Same issue as #31. Called from worktree management flows (KanbanProvider lines 6371, 6792, 7039; TaskViewerProvider line 6996).

**Implementation:**
```ts
// BEFORE (line 1479):
public async updatePlanWorktreeStatus(sessionId: string, status: 'none' | 'active' | 'merged' | 'deleted'): Promise<void> {
    if (!this._db) return;
    this._db.run(
        'UPDATE plans SET worktree_status = ? WHERE session_id = ?',
        [status, sessionId]
    );
    await this._persist();
}

// AFTER:
public async updatePlanWorktreeStatus(sessionId: string, status: 'none' | 'active' | 'merged' | 'deleted'): Promise<void> {
    if (!this._db) return;
    const plan = await this.getPlanBySessionId(sessionId);
    if (!plan) return;
    this._db.run(
        'UPDATE plans SET worktree_status = ? WHERE plan_id = ?',
        [status, plan.planId]
    );
    await this._persist();
}
```

#### 33. `hasPlan(sessionId)` — add fallback (line 1207)

**Context:** Uses `SELECT 1 FROM plans WHERE session_id = ? LIMIT 1`. Returns `false` for sessionless cards or when called with a planId. Called from orphan detection and brain plan flows (TaskViewerProvider lines 10249, 11450, 12111).

**Implementation:**
```ts
// BEFORE (line 1207):
public async hasPlan(sessionId: string): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
    const stmt = this._db.prepare('SELECT 1 FROM plans WHERE session_id = ? LIMIT 1', [sessionId]);
    try {
        return stmt.step();
    } finally {
        stmt.free();
    }
}

// AFTER:
/** @deprecated session_id is no longer the unique key; use hasPlanByPlanFile instead. */
public async hasPlan(sessionId: string): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
    // Try session_id first
    const stmt = this._db.prepare('SELECT 1 FROM plans WHERE session_id = ? LIMIT 1', [sessionId]);
    try {
        if (stmt.step()) return true;
    } finally {
        stmt.free();
    }
    // Fallback: sessionId might actually be a planId
    const stmt2 = this._db.prepare('SELECT 1 FROM plans WHERE plan_id = ? LIMIT 1', [sessionId]);
    try {
        return stmt2.step();
    } finally {
        stmt2.free();
    }
}
```

#### 34. `getPlanFilePath(sessionId)` — add fallback (line 1321)

**Context:** Uses `SELECT plan_file FROM plans WHERE session_id = ?`. Returns `null` for sessionless cards or when called with a planId. Called from plan file resolution flows.

**Implementation:**
```ts
// BEFORE (line 1321):
async getPlanFilePath(sessionId: string): Promise<string | null> {
    if (!(await this.ensureReady()) || !this._db) {
        return null;
    }
    const stmt = this._db.prepare('SELECT plan_file FROM plans WHERE session_id = ?', [sessionId]);
    try {
        if (stmt.step()) {
            const row = stmt.getAsObject();
            return (row.plan_file as string) || null;
        }
        return null;
    } finally {
        stmt.free();
    }
}

// AFTER:
/** @deprecated session_id is no longer the unique key; use getPlanFilePathByPlanFile instead. */
async getPlanFilePath(sessionId: string): Promise<string | null> {
    if (!(await this.ensureReady()) || !this._db) {
        return null;
    }
    // Try session_id first
    const stmt = this._db.prepare('SELECT plan_file FROM plans WHERE session_id = ?', [sessionId]);
    try {
        if (stmt.step()) {
            const row = stmt.getAsObject();
            return (row.plan_file as string) || null;
        }
    } finally {
        stmt.free();
    }
    // Fallback: sessionId might actually be a planId
    const stmt2 = this._db.prepare('SELECT plan_file FROM plans WHERE plan_id = ?', [sessionId]);
    try {
        if (stmt2.step()) {
            const row = stmt2.getAsObject();
            return (row.plan_file as string) || null;
        }
        return null;
    } finally {
        stmt2.free();
    }
}
```

#### 35. `updatePlanFile(sessionId, planFile)` — add fallback (line 1649)

**Context:** Uses `UPDATE plans SET plan_file = ? WHERE session_id = ?`. If called with a raw planId hash, the UPDATE silently no-ops. Also has a verification query that uses `WHERE session_id = ?` — this must be updated too. Called from plan file update flows (TaskViewerProvider lines 2559, 10922, 10948, 12991).

**Implementation:**
```ts
// BEFORE (line 1649):
public async updatePlanFile(sessionId: string, planFile: string, skipTimestampUpdate?: boolean): Promise<boolean> {
    console.log(`[KanbanDatabase] updatePlanFile: sessionId=${sessionId}, planFile=${planFile}, skipTimestampUpdate=${skipTimestampUpdate}`);
    const sql = skipTimestampUpdate
        ? 'UPDATE plans SET plan_file = ? WHERE session_id = ?'
        : 'UPDATE plans SET plan_file = ?, updated_at = ? WHERE session_id = ?';
    const params = skipTimestampUpdate
        ? [this._ensureRelativePlanFile(planFile), sessionId]
        : [this._ensureRelativePlanFile(planFile), new Date().toISOString(), sessionId];
    const result = this._persistedUpdate(sql, params);
    if (this._db) {
        try {
            const stmt = this._db.prepare('SELECT plan_file FROM plans WHERE session_id = ?', [sessionId]);
            if (stmt.step()) {
                const row = stmt.getAsObject();
                console.log(`[KanbanDatabase] updatePlanFile VERIFY: sessionId=${sessionId}, plan_file now=${row.plan_file}`);
            }
            stmt.free();
        } catch (e) {
            console.error(`[KanbanDatabase] updatePlanFile VERIFY failed:`, e);
        }
    }
    return result;
}

// AFTER:
/** @deprecated session_id is no longer the unique key; plan_file is now the unique key. */
public async updatePlanFile(sessionId: string, planFile: string, skipTimestampUpdate?: boolean): Promise<boolean> {
    console.log(`[KanbanDatabase] updatePlanFile: sessionId=${sessionId}, planFile=${planFile}, skipTimestampUpdate=${skipTimestampUpdate}`);
    const plan = await this.getPlanBySessionId(sessionId);
    if (!plan) return false;
    const sql = skipTimestampUpdate
        ? 'UPDATE plans SET plan_file = ? WHERE plan_id = ?'
        : 'UPDATE plans SET plan_file = ?, updated_at = ? WHERE plan_id = ?';
    const params = skipTimestampUpdate
        ? [this._ensureRelativePlanFile(planFile), plan.planId]
        : [this._ensureRelativePlanFile(planFile), new Date().toISOString(), plan.planId];
    const result = this._persistedUpdate(sql, params);
    if (this._db) {
        try {
            const stmt = this._db.prepare('SELECT plan_file FROM plans WHERE plan_id = ?', [plan.planId]);
            if (stmt.step()) {
                const row = stmt.getAsObject();
                console.log(`[KanbanDatabase] updatePlanFile VERIFY: planId=${plan.planId}, plan_file now=${row.plan_file}`);
            }
            stmt.free();
        } catch (e) {
            console.error(`[KanbanDatabase] updatePlanFile VERIFY failed:`, e);
        }
    }
    return result;
}
```

#### 36. `updateSessionId(oldSessionId, newSessionId)` — add fallback (line 1673)

**Context:** Uses `UPDATE plans SET session_id = ? WHERE session_id = ?`. This is a rename operation. If `oldSessionId` is actually a planId, the WHERE clause fails. Called from plan move/rename flows (TaskViewerProvider line 12992).

**Implementation:**
```ts
// BEFORE (line 1673):
public async updateSessionId(oldSessionId: string, newSessionId: string): Promise<boolean> {
    console.log(`[KanbanDatabase] updateSessionId: oldSessionId=${oldSessionId}, newSessionId=${newSessionId}`);
    const sql = 'UPDATE plans SET session_id = ?, updated_at = ? WHERE session_id = ?';
    const params = [newSessionId, new Date().toISOString(), oldSessionId];
    const result = this._persistedUpdate(sql, params);
    return result;
}

// AFTER:
public async updateSessionId(oldSessionId: string, newSessionId: string): Promise<boolean> {
    console.log(`[KanbanDatabase] updateSessionId: oldSessionId=${oldSessionId}, newSessionId=${newSessionId}`);
    const plan = await this.getPlanBySessionId(oldSessionId);
    if (!plan) return false;
    const sql = 'UPDATE plans SET session_id = ?, updated_at = ? WHERE plan_id = ?';
    const params = [newSessionId, new Date().toISOString(), plan.planId];
    const result = this._persistedUpdate(sql, params);
    return result;
}
```

#### 37. `reviveDeletedPlans(sessionIds)` — add fallback (line 1591)

**Context:** Uses `UPDATE plans SET status = 'active' WHERE session_id = ? AND status = 'deleted'` for each ID. If an ID is a planId, the UPDATE silently no-ops. Called from plan revival flows (TaskViewerProvider line 10950).

**Implementation:**
```ts
// BEFORE (line 1591):
public async reviveDeletedPlans(sessionIds: string[]): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
    const uniqueSessionIds = [...new Set(
        sessionIds
            .map((sessionId) => String(sessionId || '').trim())
            .filter((sessionId) => sessionId.length > 0)
    )];
    if (uniqueSessionIds.length === 0) return true;

    const now = new Date().toISOString();
    this._db.run('BEGIN');
    try {
        for (const sessionId of uniqueSessionIds) {
            this._db.run(
                "UPDATE plans SET status = 'active', updated_at = ? WHERE session_id = ? AND status = 'deleted'",
                [now, sessionId]
            );
        }
        this._db.run('COMMIT');
    } catch (error) {
        try { this._db.run('ROLLBACK'); } catch { }
        console.error('[KanbanDatabase] Failed to revive deleted plans:', error);
        return false;
    }
    return this._persist();
}

// AFTER:
/** @deprecated session_id is no longer the unique key; use reviveDeletedPlansByPlanFile instead. */
public async reviveDeletedPlans(sessionIds: string[]): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
    const uniqueSessionIds = [...new Set(
        sessionIds
            .map((sessionId) => String(sessionId || '').trim())
            .filter((sessionId) => sessionId.length > 0)
    )];
    if (uniqueSessionIds.length === 0) return true;

    const now = new Date().toISOString();
    this._db.run('BEGIN');
    try {
        for (const sessionId of uniqueSessionIds) {
            // Try session_id first; if no rows affected, try plan_id fallback
            this._db.run(
                "UPDATE plans SET status = 'active', updated_at = ? WHERE session_id = ? AND status = 'deleted'",
                [now, sessionId]
            );
            if (this._db.changes === 0) {
                this._db.run(
                    "UPDATE plans SET status = 'active', updated_at = ? WHERE plan_id = ? AND status = 'deleted'",
                    [now, sessionId]
                );
            }
        }
        this._db.run('COMMIT');
    } catch (error) {
        try { this._db.run('ROLLBACK'); } catch { }
        console.error('[KanbanDatabase] Failed to revive deleted plans:', error);
        return false;
    }
    return this._persist();
}
```

Note: This method uses `this._db.changes` to check if the first UPDATE affected any rows. If not, it retries with `plan_id`. This is more efficient than calling `getPlanBySessionId` for each ID in a batch, and avoids an extra SELECT per row.

#### 38. `updateMetadataBatch(updates)` — add fallback (line 2567)

**Context:** Uses `UPDATE plans SET ... WHERE session_id = ?` for each update entry. If `u.sessionId` is a planId, the UPDATE silently no-ops. Called from plan metadata sync flows (TaskViewerProvider line 14165).

**Implementation:** Resolve each `u.sessionId` to a `planId` before the UPDATE:
```ts
// BEFORE (line 2567, key inner loop):
for (const u of updates) {
    const setClauses = ['topic = ?', 'plan_file = ?'];
    const params: unknown[] = [u.topic, this._ensureRelativePlanFile(u.planFile)];
    // ... build setClauses and params ...
    params.push(u.sessionId);
    this._db.run(
        `UPDATE plans SET ${setClauses.join(', ')} WHERE session_id = ?`,
        params
    );
}

// AFTER:
for (const u of updates) {
    const plan = await this.getPlanBySessionId(u.sessionId);
    if (!plan) continue;
    const setClauses = ['topic = ?', 'plan_file = ?'];
    const params: unknown[] = [u.topic, this._ensureRelativePlanFile(u.planFile)];
    // ... build setClauses and params (unchanged) ...
    params.push(plan.planId);
    this._db.run(
        `UPDATE plans SET ${setClauses.join(', ')} WHERE plan_id = ?`,
        params
    );
}
```

Note: The `getPlanBySessionId` call inside the transaction loop adds an extra SELECT per row. This is acceptable because `getPlanBySessionId` is a point read on indexed columns and batch sizes are typically small (< 20 plans).

#### 39. `completeMultiple(sessionIds)` — add fallback (line 2648)

**Context:** Uses `UPDATE plans SET status = ?, kanban_column = ?, updated_at = ? WHERE session_id = ?` for each ID. If an ID is a planId, the UPDATE silently no-ops.

**Implementation:** Resolve each sessionId to a planId before the UPDATE:
```ts
// BEFORE (line 2648, key inner loop):
for (const sessionId of sessionIds) {
    this._db.run(
        'UPDATE plans SET status = ?, kanban_column = ?, updated_at = ? WHERE session_id = ?',
        ['completed', 'COMPLETED', now, sessionId]
    );
}

// AFTER:
for (const sessionId of sessionIds) {
    const plan = await this.getPlanBySessionId(sessionId);
    if (!plan) continue;
    this._db.run(
        'UPDATE plans SET status = ?, kanban_column = ?, updated_at = ? WHERE plan_id = ?',
        ['completed', 'COMPLETED', now, plan.planId]
    );
}
```

## Verification Plan

### Automated Tests

- N/A — the backend handlers are tightly coupled to VS Code APIs and webview messaging. No unit test infrastructure exists for these message handlers.

### Manual Verification

- Create a new plan in the `CREATED` column (no `sessionId`).
- Click **Copy Prompt** — verify the prompt is actually copied to the clipboard and the card advances to the next column.
- Verify the card does NOT bounce back to CREATED after the board refreshes.
- Drag a sessionless card from CREATED to PLAN REVIEWED — verify the card stays in PLAN REVIEWED after refresh.
- Click **Pair Program** on a high-complexity sessionless card in PLAN REVIEWED — verify pair-programming dispatches correctly.
- Click **Complete** on a sessionless card in CODE REVIEWED — verify it moves to COMPLETED.
- Use **Move All** on a column containing sessionless cards — verify all cards advance.
- Use **Batch Planner Prompt** on CREATED cards — verify prompts are generated and cards advance.
- Use **Batch Low-Complexity Prompt** on PLAN REVIEWED cards — verify sessionless low-complexity cards are included.
- Create a plan with dependencies in CREATED — verify the dependency blocking indicator renders correctly.
- Test Autoban dispatch with sessionless cards in PLAN REVIEWED — verify they are dispatched and not re-dispatched.
- Test Autoban dispatch lock release — after a dispatched sessionless card moves to the next column, verify the lock is released (card can be re-dispatched from the new column if applicable).
- Move a sessionless card to the MERGE column — verify it is picked up for merge processing and advanced to COMPLETED.
- Verify that cards with active sessions (in CODED/REVIEW columns) still generate prompts and advance correctly — no regression.
- Test with a preexisting Antigravity (brain-sourced) plan in PLAN REVIEWED — verify Copy Prompt, column moves, and dispatch all work correctly despite the `antigravity_`-prefixed sessionId in the DB.
- Test Autoban dispatch with an Antigravity plan — verify the dispatch lock is set and released correctly when keyed by planId (raw hash) rather than the prefixed sessionId.
- Delete a sessionless plan — verify it is actually removed from the DB (tests `deletePlan` fallback).
- Delete an Antigravity plan — verify it is removed from the DB when the delete command receives a raw planId hash (tests `deletePlan` fallback for Antigravity prefix).
- Create a worktree for a sessionless plan — verify `updatePlanWorktree` and `updatePlanWorktreeStatus` correctly update the DB row.
- Move a plan file for a sessionless plan — verify `updatePlanFile` and `updateSessionId` correctly update the DB row.

---

Complexity 5 → **Send to Coder**
