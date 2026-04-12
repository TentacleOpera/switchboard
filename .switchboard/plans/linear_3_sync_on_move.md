# Linear Integration — Part 3: Sync Plans on Card Move

## Goal

When a Switchboard kanban card moves, automatically sync the plan's state to the corresponding Linear issue — creating the issue if it doesn't exist, or updating its workflow state if it does. One-way sync (Switchboard → Linear). Mirrors `clickup_3_sync_on_move.md` but uses GraphQL mutations and state-based routing instead of list-based routing.

## Metadata

**Tags:** backend, infrastructure
**Complexity:** 6
**Prerequisites:** `linear_1_foundation.md` (creates `LinearSyncService`, `debouncedSync` stub, `consecutiveFailures` counter), `linear_2_setup_flow.md` (creates `setup()`, config, `_getLinearService()` cached factory in KanbanProvider)

## User Review Required

> [!NOTE]
> - **State-based sync**: Moving a card doesn't move it between lists — it updates the Linear issue's `stateId`. This is simpler than ClickUp's list-move logic.
> - **Local sync map**: Issue lookup uses `.switchboard/linear-sync.json` (sessionId → issueId). No API search needed on every move.
> - **Non-blocking**: Linear sync failures never block card moves. Errors are caught and surfaced as a webview status indicator (not silent — learned from ClickUp's critique).
> - **`switchboard` label**: All created issues get the team's `switchboard` label, making Switchboard-managed issues identifiable in Linear.
> - **Debounced**: Rapid moves within 500ms are coalesced.

## Complexity Audit

### Routine
- **Debounce**: Same `debounceTimers` pattern as ClickUp
- **State lookup**: `config.columnToStateId[newColumn]` — O(1) map lookup
- **Sync map read/write**: JSON file I/O from Part 1

### Complex / Risky
- **`issueCreate` mutation**: Must set `teamId`, `title`, `stateId`, `labelIds`, `description`, `priority`. Priority mapping: `Unknown/1` → 0 (None), `3-4` → 4 (Low), `5-6` → 3 (Normal), `7-8` → 2 (High), `9-10` → 1 (Urgent).
- **`issueUpdate` mutation**: Only updates `stateId` on move (description and title are not re-synced to avoid overwriting user edits in Linear).
- **Hook injection in `KanbanProvider.ts`**: Same location as ClickUp — `moveCardForward` and `moveCardBackwards`. Must be fire-and-forget after DB update.
- **Unmapped columns**: If `config.columnToStateId[column]` is undefined (column not mapped during setup), sync is silently skipped with a log line.

## Edge-Case & Dependency Audit

- **Column not mapped**: Skip sync, log `[LinearSync] No state mapped for column: ${column}`
- **Issue already exists** (in sync map): call `issueUpdate`, not `issueCreate`
- **Sync map entry exists but issue deleted in Linear**: `issueUpdate` returns `success: false` → fallback to `issueCreate` and update sync map
- **`_isSyncInProgress` guard**: Prevents re-entrant sync calls (future-proofs against reverse sync)
- **Consecutive failures**: After 3 consecutive sync failures, post `{ type: 'linearState', error: true }` to webview to show degraded indicator
- **Plan has no `sessionId`**: Guard — skip sync if `plan.sessionId` is falsy

## Cross-Plan Conflict Analysis

- **`KanbanProvider.ts`** is modified by BOTH this plan and `clickup_3_sync_on_move.md`. Both add independent `try/catch` hook blocks in `moveCardForward` (after line ~1867) and `moveCardBackwards` (after line ~1813). The Linear hook **must** be placed AFTER the ClickUp hook in both handlers to maintain consistent ordering. The hooks are fully independent — each has its own `try/catch` so one failing cannot affect the other.
- **`_getLinearService(workspaceRoot)`** is created by Part 2 (`linear_2_setup_flow.md`) as a cached factory on `KanbanProvider`, mirroring the `_getClickUpService(workspaceRoot)` pattern at line 438. This plan's hooks depend on it — the factory MUST exist before this plan is implemented.
- **`debouncedSync(sessionId, plan, column)`** is created by Part 1 (`linear_1_foundation.md`) on `LinearSyncService`. The hook calls this instead of `syncPlan()` directly, so Part 1 must be implemented first.
- **No conflict** with `linear_import_pull_issues.md` — that plan is purely additive (read-only import).

## Adversarial Synthesis

### Grumpy Critique

1. **`new LinearSyncService()` on every card move** — The original hook code creates a fresh service instance on every move. This destroys the debounce timer map, consecutive failure counter, and cached config on each invocation. ClickUp uses `this._getClickUpService(workspaceRoot)` which returns a cached singleton from a `Map`. The plan MUST use `this._getLinearService(workspaceRoot)` (Part 2's cached factory) instead.

2. **No debounce wrapper called** — The plan claims "Debounced: Rapid moves within 500ms are coalesced" in User Review, but the hook code calls `linearService.syncPlan(...)` directly. ClickUp calls `clickUp.debouncedSync(sid, planRecord)`. Without calling `debouncedSync()`, rapid card moves fire N separate API calls instead of coalescing to 1.

3. **Hook calls `syncPlan()` with wrong signature** — The original hook passes a subset `{ sessionId, topic, planFile, complexity }` but the ClickUp pattern passes the full `KanbanPlanRecord` from `syncDb.getPlanBySessionId(sid)` (which includes planId, sessionId, topic, planFile, kanbanColumn, status, complexity, tags, dependencies, createdAt, updatedAt, lastAction). The `debouncedSync()` signature from Part 1 takes `(sessionId, plan, column)`.

4. **Missing `_getLinearService` prerequisite** — The plan didn't document that `_getLinearService()` must already exist in `KanbanProvider`. It's defined in Part 2 — the plan must explicitly note this as a prerequisite dependency.

5. **No `consecutiveFailures` check in hook code** — ClickUp's hook checks `if (clickUp.consecutiveFailures >= 3)` and posts a degraded state message via `this._panel?.webview.postMessage()`. The plan mentioned this in Edge-Case but the original hook code only had a comment `// Increment failure counter` with no actual implementation.

### Balanced Responses

1. **Fixed**: Hook now uses `this._getLinearService(workspaceRoot)` — cached singleton, preserves debounce timers and failure counter across calls.
2. **Fixed**: Hook now calls `linear.debouncedSync(sid, planRecord, targetColumn)` — matches ClickUp's debounce pattern.
3. **Fixed**: Hook passes full plan record from `syncDb.getPlanBySessionId(sid)`, matching ClickUp's data flow.
4. **Fixed**: Prerequisites section now explicitly documents `_getLinearService()` as a Part 2 dependency.
5. **Fixed**: Hook now includes `if (linear.consecutiveFailures >= 3)` check with `linearState` message push to webview.

## Proposed Changes

### Target File 1: Sync Methods
#### MODIFY `src/services/LinearSyncService.ts`

```typescript
// Priority: Switchboard complexity string → Linear priority (0=None,1=Urgent,2=High,3=Normal,4=Low)
private _complexityToPriority(complexity: string): number {
  const n = parseInt(complexity, 10);
  if (isNaN(n)) { return 0; }
  if (n >= 9) { return 1; }
  if (n >= 7) { return 2; }
  if (n >= 5) { return 3; }
  return 4;
}

async syncPlan(plan: { sessionId: string; topic: string; planFile: string; complexity: string }, newColumn: string): Promise<void> {
  const config = await this.loadConfig();
  if (!config?.setupComplete) { return; }

  const stateId = config.columnToStateId[newColumn];
  if (!stateId) { return; } // column not mapped

  const existingIssueId = await this.getIssueIdForPlan(plan.sessionId);
  const priority = this._complexityToPriority(plan.complexity);

  try {
    if (existingIssueId) {
      // Update state only — don't overwrite user edits in Linear
      const result = await this.retry(() => this.graphqlRequest(`
        mutation($id: String!, $stateId: String!) {
          issueUpdate(id: $id, input: { stateId: $stateId }) { success }
        }
      `, { id: existingIssueId, stateId }));

      if (!result.data.issueUpdate.success) {
        // Issue may have been deleted — recreate
        await this._createIssue(plan, stateId, priority, config);
      }
    } else {
      await this._createIssue(plan, stateId, priority, config);
    }
  } catch (error) {
    console.warn(`[LinearSync] Failed to sync plan ${plan.sessionId}:`, error);
    throw error; // Let caller handle failure counting
  }
}

private async _createIssue(
  plan: { sessionId: string; topic: string; planFile: string },
  stateId: string,
  priority: number,
  config: LinearConfig
): Promise<void> {
  const description = `Managed by Switchboard.\n\nPlan file: \`${plan.planFile}\`\n\nDo not edit the title — it is synced from Switchboard.`;
  const result = await this.retry(() => this.graphqlRequest(`
    mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier } }
    }
  `, {
    input: {
      teamId: config.teamId,
      title: plan.topic,
      stateId,
      priority,
      labelIds: config.switchboardLabelId ? [config.switchboardLabelId] : [],
      description,
      ...(config.projectId ? { projectId: config.projectId } : {})
    }
  }));

  if (result.data.issueCreate.success) {
    await this.setIssueIdForPlan(plan.sessionId, result.data.issueCreate.issue.id);
  }
}
```

### Target File 2: Hook into Card Move Handlers
#### MODIFY `src/services/KanbanProvider.ts`

In `moveCardForward` and `moveCardBackwards`, after the DB column update and AFTER the ClickUp sync hook (same pattern — independent `try/catch` block), add:

```typescript
// Linear sync hook — fire-and-forget, never blocks kanban moves
try {
    const linear = this._getLinearService(workspaceRoot);
    const linearConfig = await linear.loadConfig();
    if (linearConfig?.setupComplete) {
        const syncDb = this._getKanbanDb(workspaceRoot);
        for (const sid of sessionIds) {
            const plan = await syncDb.getPlanBySessionId(sid);
            if (plan) {
                linear.debouncedSync(sid, {
                    planId: plan.planId,
                    sessionId: plan.sessionId,
                    topic: plan.topic,
                    planFile: plan.planFile,
                    kanbanColumn: targetColumn,
                    status: plan.status,
                    complexity: plan.complexity,
                    tags: plan.tags,
                    dependencies: plan.dependencies,
                    createdAt: plan.createdAt,
                    updatedAt: plan.updatedAt,
                    lastAction: plan.lastAction
                }, targetColumn);
            }
        }
        if (linear.consecutiveFailures >= 3) {
            this._panel?.webview.postMessage({
                type: 'linearState', available: true,
                setupComplete: true, syncError: true
            });
        }
    }
} catch { /* Linear sync failure must never block kanban operations */ }
```

## Verification Plan

- Mock `graphqlRequest`: create path → verify `issueCreate` called, sync map updated
- Mock `graphqlRequest`: update path (existing in sync map) → verify `issueUpdate` called, not `issueCreate`
- `issueUpdate` returns `success: false` → verify fallback to `issueCreate`
- Unmapped column → verify no API call made
- Missing `sessionId` → verify no API call made
- Priority mapping: `complexity='9'` → priority 1 (urgent); `complexity='Unknown'` → priority 0 (none)

## Files to Modify

1. `src/services/LinearSyncService.ts` — MODIFY (add `syncPlan`, `_createIssue`, `_complexityToPriority`)
2. `src/services/KanbanProvider.ts` — MODIFY (add sync hook in move handlers)

## Agent Recommendation

**Send to Coder** — Complexity 6. The sync logic is straightforward; the main risk is the correct hook injection location in `KanbanProvider.ts`. Implementer should grep for the ClickUp sync hook location and mirror it exactly.

## Implementation Review (2026-04-09)

### Stage 1: Grumpy Principal Engineer

*Adjusts monocle. Cracks knuckles.*

1. **MAJOR — Hook passes incomplete plan record**: The plan's "Balanced Response" section (#3) specifically says "Fixed: Hook passes full plan record from `syncDb.getPlanBySessionId(sid)`" and shows all 11 fields (`planId, sessionId, topic, planFile, kanbanColumn, status, complexity, tags, dependencies, createdAt, updatedAt, lastAction`). The implementation passes only 5 fields: `{ planId, sessionId, topic, planFile, complexity }`. Missing: `kanbanColumn`, `status`, `tags`, `dependencies`, `createdAt`, `updatedAt`, `lastAction`. Now, `syncPlan()` currently only reads 4 of these fields, so *functionally* this works. But `debouncedSync` takes `plan: any`, and future sync logic (e.g. syncing tags/priority changes, adding dependency metadata to Linear descriptions) will need these fields. ClickUp's hook passes all 11 fields. The inconsistency is a maintenance trap.

2. **NIT — `debouncedSync` resets failures on success**: Line 337 has `this._consecutiveFailures = 0;` in the success path. The plan's proposed code stub in Part 1 didn't show this, but the Adversarial Synthesis in Part 3 demands it. The implementation is correct — this is actually an improvement over the plan's Part 1 code.

3. **NIT — Hook placement is correct**: Both `moveCardForward` (line 2019) and `moveCardBackwards` (line 1939) have the Linear hook AFTER the ClickUp hook, matching the plan's cross-plan conflict analysis requirement. The fire-and-forget `try/catch` wrapping is correct. `_scheduleBoardRefresh` precedes both hooks. Good.

### Stage 2: Balanced Synthesis

| Finding | Severity | Action |
|:--------|:---------|:-------|
| Hook passes incomplete plan record (5 of 11 fields) | MAJOR | ✅ Fixed (2026-04-10) — both hooks now pass all 11 fields matching ClickUp pattern |
| consecutiveFailures reset | NIT (improvement) | ✅ Already correct |
| Hook placement order | NIT | ✅ Correct — after ClickUp, before command dispatch |

**Code fix applied (2026-04-10):** Both Linear hooks in `moveCardBackwards` (line 1966) and `moveCardForward` (line 2046) now pass all 11 fields matching the ClickUp pattern: `planId, sessionId, topic, planFile, kanbanColumn, status, complexity, tags, dependencies, createdAt, updatedAt, lastAction`. Typecheck and build verified.

### Validation Results

- `npx tsc --noEmit`: ✅ Pass (only pre-existing ArchiveManager error)
- `npm run compile`: ✅ webpack compiled successfully
- Both target files verified:
  - `src/services/LinearSyncService.ts` — ✅ `syncPlan()` (line 270), `_createIssue()` (line 300), `_complexityToPriority()` (line 261) all present and correct
  - `src/services/KanbanProvider.ts` — ✅ Hooks in `moveCardForward` (line 2019) and `moveCardBackwards` (line 1939), using cached `_getLinearService()`, with `consecutiveFailures >= 3` degraded state push

### Remaining Risks

- Priority mapping untested against real Linear API responses — relies on correct `complexity` string parsing
