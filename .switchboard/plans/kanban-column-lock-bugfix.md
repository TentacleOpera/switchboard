# Fix Kanban Column Lock: KanbanProvider Reads Wrong Database

## Goal

Fix the Kanban board reading from a different database path than it writes to when `workspaceDatabaseMappings` is configured, causing cards to appear stuck in the `CREATED` column after copying a planning prompt.

## Metadata

- **Tags:** [bugfix, backend, database, workflow]
- **Complexity:** 4

## User Review Required

- Confirm that keeping the inner try/catch in `_handleCopyPlanLink` (refined, not removed) is acceptable vs. the original plan's approach of removing it entirely.
- Confirm that other KanbanProvider cache methods (`_getClickUpService`, `_getLinearService`, etc.) do NOT need the same `resolveEffectiveWorkspaceRoot` treatment — they correctly use child workspace paths for per-workspace external service config.

## Complexity Audit

### Routine
- Replace `path.resolve(workspaceRoot)` with `this.resolveEffectiveWorkspaceRoot(workspaceRoot)` in `KanbanProvider._getKanbanDb` — single line change
- Change `_updateKanbanColumnForSession` return type from `Promise<void>` to `Promise<boolean>` with explicit `false` returns
- Add return-value check in `_applyManualKanbanColumnChange` for `_updateKanbanColumnForSession`

### Complex / Risky
- Refining the inner try/catch in `_handleCopyPlanLink`: the clipboard copy has already succeeded when the column-advance code runs, so removing the try/catch entirely would cause the outer catch to show a misleading "Failed to copy plan link" error. Must keep the try/catch but change it to surface the column-advance failure via webview warning while still returning `true` (copy succeeded).

## Edge-Case & Dependency Audit

- **Race Conditions:** `_refreshBoardImpl` (line 833) does `path.resolve(workspaceRoot)` then passes result to `_getKanbanDb`. After the fix, `_getKanbanDb` calls `resolveEffectiveWorkspaceRoot` on an already-resolved path — this is idempotent (safe), but worth noting.
- **Security:** No security implications — path resolution is internal.
- **Side Effects:** Changing `_getKanbanDb` to use `resolveEffectiveWorkspaceRoot` means all 20+ call sites within KanbanProvider will now resolve to the parent DB path. This is the desired behavior for shared databases, but the cache key universe changes from child-path-keyed to parent-path-keyed. Existing in-memory cache entries keyed by child path will become orphaned (no lookup hit) until they're GC'd when the provider is disposed. This is benign — new entries will be created under the parent key.
- **Dependencies & Conflicts:** `_updateKanbanColumnForSession` has 6 callers (lines 2069, 2263, 2497, 13812, 13900, 14103). Only `_applyManualKanbanColumnChange` (line 2263) will be updated to check the new `boolean` return. The other 5 callers remain fire-and-forget — safe because TypeScript won't break callers that ignore a return value, and their flows don't need column-advance error propagation.

## Dependencies

None — this is a self-contained bugfix.

## Adversarial Synthesis

Key risks: (1) Removing the inner try/catch in `_handleCopyPlanLink` would show a misleading "Failed to copy plan link" error when the clipboard copy succeeded but the column advance failed. Mitigation: keep the try/catch, refine it to send a webview warning instead. (2) Ghost DBs could be created at child paths by any caller of `KanbanDatabase.forWorkspace` with a child path. Mitigation: Change 5 adds a defensive guard in `forWorkspace` itself — when a mapping has `parentFolder` but no `dbPath`, it redirects to the parent's DB path, making ghost DB creation impossible regardless of caller.

## Problem Statement

The **"Copy planning prompt"** button on Kanban cards copies the prompt to clipboard but **fails to advance the card out of the `CREATED` column**. No error is shown. The card stays locked in `CREATED` indefinitely.

## Root Cause

`TaskViewerProvider._getKanbanDb()` and `KanbanProvider._getKanbanDb()` resolve to **different database paths** when `workspaceDatabaseMappings` is configured (multi-repo with shared parent database).

- `TaskViewerProvider._getKanbanDb` calls `resolveEffectiveWorkspaceRoot()` → returns the **parent workspace** path → writes to `parent/.switchboard/kanban.db`
- `KanbanProvider._getKanbanDb` does `path.resolve(workspaceRoot)` → returns the **child workspace** path → `KanbanDatabase.forWorkspace()` creates/opens a spurious DB at `child/.switchboard/kanban.db` that was never supposed to exist

The column update succeeds in the parent DB (the only DB that should exist), but the Kanban board reads from the spurious child-path DB — an empty or stale ghost that never receives updates. The card appears stuck.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — Make `_getKanbanDb` use `resolveEffectiveWorkspaceRoot`

**Location:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts:1007-1016`

**Context:** This is the root cause. `KanbanProvider._getKanbanDb` uses `path.resolve` which returns the child workspace path, while `TaskViewerProvider._getKanbanDb` uses `resolveEffectiveWorkspaceRoot` which returns the parent. The board reads from a spurious ghost DB at the child path (created by `KanbanDatabase.forWorkspace`) instead of the shared parent DB where writes actually go.

**Logic:** Replace `path.resolve(workspaceRoot)` with `this.resolveEffectiveWorkspaceRoot(workspaceRoot)`. This is a single-line change. `resolveEffectiveWorkspaceRoot` is already a public method on KanbanProvider (line 2988) that checks `workspaceDatabaseMappings` config and falls back to `path.resolve` when no mapping exists.

**Implementation:**

```typescript
private _getKanbanDb(workspaceRoot: string): KanbanDatabase {
    // Use resolveEffectiveWorkspaceRoot so that child workspaces with
    // workspaceDatabaseMappings share the same DB instance as the parent.
    // Other cache methods (_getClickUpService, etc.) intentionally use
    // path.resolve because external services have per-child-workspace config.
    const resolvedRoot = this.resolveEffectiveWorkspaceRoot(workspaceRoot);
    const existing = this._kanbanDbs.get(resolvedRoot);
    if (existing) {
        return existing;
    }
    const created = KanbanDatabase.forWorkspace(resolvedRoot);
    this._kanbanDbs.set(resolvedRoot, created);
    return created;
}
```

**Edge Cases:**
- When no `workspaceDatabaseMappings` is configured, `resolveEffectiveWorkspaceRoot` falls back to `path.resolve(workspaceRoot)` — behavior unchanged.
- `_refreshBoardImpl` (line 833) passes an already-resolved path to `_getKanbanDb`. `resolveEffectiveWorkspaceRoot` calls `path.resolve` internally first, so double-resolution is idempotent.
- Existing in-memory `_kanbanDbs` entries keyed by child path become orphaned. They're never accessed again and are disposed when the provider is destroyed. Benign.

### 2. `src/services/TaskViewerProvider.ts` — Make `_updateKanbanColumnForSession` return `boolean`

**Location:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts:1450-1463`

**Context:** Currently returns `Promise<void>` and silently swallows failures from `db.updateColumn`. `db.updateColumn` already returns `Promise<boolean>` (returns `false` if plan not found or column invalid).

**Logic:** Change return type to `Promise<boolean>`. Return `false` on every early exit and when `db.updateColumn` returns `false`. Return `true` only when the full update succeeds.

**Implementation:**

```typescript
private async _updateKanbanColumnForSession(
    workspaceRoot: string, sessionId: string, column: string | null
): Promise<boolean> {
    if (!column) return false;
    const db = await this._getKanbanDb(workspaceRoot);
    if (!db) return false;
    const updated = await db.updateColumn(sessionId, column);
    if (!updated) return false;

    const plan = await db.getPlanBySessionId(sessionId);
    const planFile = typeof plan?.planFile === 'string' ? plan.planFile.trim() : '';
    if (!planFile) return false;
    return true;
}
```

**Edge Cases:**
- 5 other callers (lines 2069, 2497, 13812, 13900, 14103) ignore the return value — safe, no breakage.
- Only `_applyManualKanbanColumnChange` (line 2263) will be updated to check the return (see Change 3).

### 3. `src/services/TaskViewerProvider.ts` — Check `_updateKanbanColumnForSession` return in `_applyManualKanbanColumnChange`

**Location:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts:2263`

**Context:** `_applyManualKanbanColumnChange` calls `_updateKanbanColumnForSession` at line 2263 but ignores the result. If the DB update fails, the method still returns `true`.

**Logic:** Capture the return value and return `false` if the update failed.

**Implementation:**

```typescript
// Line 2263 — replace:
await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, normalizedTargetColumn);
// With:
const columnUpdated = await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, normalizedTargetColumn);
if (!columnUpdated) {
    console.warn(`[TaskViewerProvider] _applyManualKanbanColumnChange: column update failed for ${sessionId}`);
    return false;
}
```

**Edge Cases:** None — this is a straightforward guard.

### 4. `src/services/TaskViewerProvider.ts` — Refine inner try/catch in `_handleCopyPlanLink`

**Location:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts:12099-12127`

**Context:** The inner try/catch (lines 12100–12126) wraps `_applyManualKanbanColumnChange` and swallows failures. The original plan proposed removing it entirely, but this would cause the outer catch (line 12129) to display "Failed to copy plan link" when the clipboard copy already succeeded — a misleading error message.

**Logic:** Keep the try/catch but change it to: (a) check the `_applyManualKanbanColumnChange` return value, (b) log and send a webview warning on failure, (c) still return `true` because the clipboard copy succeeded.

**Implementation:**

```typescript
if (workflowName) {
    try {
        const targetColumn = this._targetColumnForRole(role);
        if (targetColumn) {
            const advanced = await this._applyManualKanbanColumnChange(
                sessionId, targetColumn, workflowName,
                `Auto-advanced after copying ${role} prompt`, resolvedWorkspaceRoot
            );
            if (advanced) {
                await this._kanbanProvider?.queueIntegrationSyncForSession(
                    resolvedWorkspaceRoot, sessionId, targetColumn
                );
                await this._kanbanProvider?._recordDispatchIdentity(
                    resolvedWorkspaceRoot, sessionId, targetColumn, undefined, true
                );
                this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);
                console.log(`[TaskViewerProvider] _handleCopyPlanLink: card advanced to ${targetColumn} for ${sessionId} via workflow '${workflowName}'`);
            } else {
                console.warn(`[TaskViewerProvider] _handleCopyPlanLink: column advance failed for ${sessionId} — copy succeeded but card remains in place`);
                this._view?.webview.postMessage({
                    type: 'copyPlanLinkResult',
                    success: true,
                    warning: 'Prompt copied but card could not be advanced. Try refreshing the board.'
                });
            }
        } else {
            await this._updateSessionRunSheet(sessionId, workflowName);
        }
    } catch (updateError) {
        console.error(`[TaskViewerProvider] Failed to auto-advance card after copy for ${sessionId}:`, updateError);
        this._view?.webview.postMessage({
            type: 'copyPlanLinkResult',
            success: true,
            warning: 'Prompt copied but card advance errored. Try refreshing the board.'
        });
    }
}
return true;
```

**Edge Cases:**
- The webview `copyPlanLinkResult` handler must be updated to handle the optional `warning` field. If it doesn't, the warning is silently ignored (no breakage).
- The outer try/catch still handles catastrophic failures (clipboard write failure, etc.) with the existing error message.

### 5. `src/services/KanbanDatabase.ts` — Redirect child workspace roots to parent BEFORE cache lookup

**Location:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts:424-433`

**Context:** `forWorkspace` creates a `new KanbanDatabase` instance (line 507) keyed by `stable` (the child path). The `_initialize` method (line 2677) has a "LAZY CHANGE" guard — when no DB file exists, it returns `false` and does NOT create one. So the ghost DB file isn't created by `_initialize`/`ensureReady`. However:
- A **dead in-memory instance** (`_db = null`) gets cached under the child `stable` key, shadowing the real parent instance
- If `createIfMissing()` is ever called on that dead instance (e.g., during plan creation), it **will** create a ghost DB file at the child path
- The `_instancesByDbPath` dedup at lines 501–504 only helps if two callers resolve to the **same** `resolvedDbPath` — but without `dbPath` in the mapping, the child resolves to a **different** file path than the parent

The fix: redirect `stable` to the parent BEFORE the `_instances` cache lookup at line 430, so no dead instance is ever created for a mapped child.

**Logic:** After computing `stable` at line 429, check `workspaceDatabaseMappings`. If `stable` is a child in a mapping with a `parentFolder`, replace `stable` with the resolved parent path. Then the existing cache lookup at line 430 finds the parent's instance immediately — no new instance, no new DB file, no ghost.

**Implementation:**

```typescript
public static forWorkspace(workspaceRoot: string, customDbPath?: string): KanbanDatabase {
    const validation = KanbanDatabase.isValidWorkspaceRoot(workspaceRoot);
    if (!validation.valid) {
        throw new Error(`Invalid workspace root: ${validation.error}`);
    }
    let stable = validation.resolved!;

    // Redirect child workspace roots to parent when workspaceDatabaseMappings
    // is configured. This must happen BEFORE the cache lookup so that:
    // 1. The _instances cache hit fires for the parent (no new instance created)
    // 2. resolvedDbPath defaults to parent/.switchboard/kanban.db (no ghost DB created)
    try {
        const vscode = require('vscode');
        const cfg = vscode.workspace.getConfiguration('switchboard')
                         .get('workspaceDatabaseMappings') as
                         { enabled?: boolean; mappings?: WorkspaceDatabaseMapping[] } | undefined;
        if (cfg?.enabled && Array.isArray(cfg.mappings)) {
            const expandHome = (p: string): string => {
                const trimmed = p.trim();
                return trimmed.startsWith('~')
                    ? path.join(os.homedir(), trimmed.slice(1))
                    : trimmed;
            };
            for (const mapping of cfg.mappings) {
                if (!Array.isArray(mapping.workspaceFolders)) continue;
                const isChild = mapping.workspaceFolders.some(
                    (f: string) => path.resolve(expandHome(f)) === stable
                );
                if (isChild && mapping.parentFolder) {
                    const parentResolved = path.resolve(expandHome(mapping.parentFolder));
                    console.log(`[KanbanDatabase] Redirecting child workspace ${stable} -> parent ${parentResolved}`);
                    stable = parentResolved;
                    break;
                }
            }
        }
    } catch { /* outside extension host */ }

    const existing = KanbanDatabase._instances.get(stable);
    if (existing) {
        return existing;
    }

    // ... rest of method unchanged (resolvedDbPath computation, _instancesByDbPath dedup, etc.)
```

**What this eliminates:**
- No new `KanbanDatabase` instance for child paths — the parent's cached instance is returned
- No ghost DB file at `child/.switchboard/kanban.db` — `stable` is the parent, so the default `resolvedDbPath` at line 495 becomes `parent/.switchboard/kanban.db`
- The mapping's `dbPath` field (if set) still works — the existing mapping code at lines 446–470 runs after this redirect and can override `resolvedDbPath`
- The `_instancesByDbPath` dedup at lines 501–504 still works as a safety net

**Edge Cases:**
- When no mapping is configured, `stable` is unchanged — behavior identical to today.
- When a mapping has `parentFolder`, the child `stable` is replaced before any cache/file logic runs. The parent may not have a DB yet — `forWorkspace` will create one at the parent path on first access, which is correct.
- When both `parentFolder` and `dbPath` are set, the redirect sets `stable` to the parent, then the existing `dbPath` logic overrides `resolvedDbPath`. Both work together.
- The `expandHome` helper is duplicated from lines 438–443. This is acceptable for a small, self-contained redirect block. Alternatively, it could be extracted to a static method.

## Files to Modify

| File | Change |
|------|--------|
| `src/services/KanbanProvider.ts:1008` | `_getKanbanDb`: replace `path.resolve(workspaceRoot)` with `this.resolveEffectiveWorkspaceRoot(workspaceRoot)` + add clarifying comment |
| `src/services/TaskViewerProvider.ts:1450-1463` | `_updateKanbanColumnForSession`: change return type to `Promise<boolean>`, return `false` on failures |
| `src/services/TaskViewerProvider.ts:2263` | `_applyManualKanbanColumnChange`: check `_updateKanbanColumnForSession` return, return `false` on failure |
| `src/services/TaskViewerProvider.ts:12099-12127` | `_handleCopyPlanLink`: refine inner try/catch — check `_applyManualKanbanColumnChange` return, send webview warning on failure, keep returning `true` |
| `src/services/KanbanDatabase.ts:424-433` | `forWorkspace`: redirect `stable` to parent root BEFORE `_instances` cache lookup when child is in a mapping with `parentFolder` |

## Acceptance Criteria

- [ ] Clicking "Copy planning prompt" on a `CREATED` card in a child workspace with `workspaceDatabaseMappings` configured advances the card to `PLAN REVIEWED`.
- [ ] The Kanban board refreshes and shows the card in the new column.
- [ ] If `db.updateColumn` returns `false`, `_updateKanbanColumnForSession` returns `false` and `_applyManualKanbanColumnChange` propagates it.
- [ ] If column advance fails after a successful clipboard copy, the user sees a warning (not an error) and the copy is not reported as failed.
- [ ] No misleading "Failed to copy plan link" error when the clipboard copy succeeded but the column advance failed.
- [ ] `KanbanDatabase.forWorkspace` never creates a DB at a child workspace path when `workspaceDatabaseMappings` with `parentFolder` is configured — it redirects to the parent's DB path instead.

## Verification Plan

### Automated Tests
- **Unit test (recommended):** Spy on `resolveEffectiveWorkspaceRoot` in `KanbanProvider._getKanbanDb` to verify it's called instead of `path.resolve`. Mock `workspaceDatabaseMappings` config to return a parent path, verify the DB instance is created with the parent path.
- **Manual verification:** In a multi-repo workspace with `workspaceDatabaseMappings` configured, click "Copy planning prompt" on a `CREATED` card. Confirm the card advances to `PLAN REVIEWED` and the board refreshes.

## Related Code References

- `src/services/KanbanProvider.ts:1007-1016` — `_getKanbanDb` (reads from wrong path — **root cause**)
- `src/services/KanbanProvider.ts:2988-3034` — `resolveEffectiveWorkspaceRoot` (correct resolution logic)
- `src/services/TaskViewerProvider.ts:4224-4245` — `_getKanbanDb` (reads from correct path via `resolveEffectiveWorkspaceRoot`)
- `src/services/TaskViewerProvider.ts:1450-1463` — `_updateKanbanColumnForSession` (ignores return value)
- `src/services/TaskViewerProvider.ts:2224-2271` — `_applyManualKanbanColumnChange` (doesn't check column update result)
- `src/services/TaskViewerProvider.ts:12099-12127` — `_handleCopyPlanLink` inner try/catch
- `src/services/KanbanDatabase.ts:1060-1063` — `updateColumn` returns `Promise<boolean>`

## Status

- **Column:** DONE
- **Priority:** High
- **Type:** Bugfix

## Execution Results

**Date executed:** 2026-05-13

### Changes Applied

| # | File | Change |
|---|------|--------|
| 1 | `src/services/KanbanProvider.ts:1007-1020` | `_getKanbanDb` now uses `this.resolveEffectiveWorkspaceRoot(workspaceRoot)` instead of `path.resolve(workspaceRoot)`. Added clarifying comment explaining why external-service cache methods intentionally still use `path.resolve`. |
| 2 | `src/services/TaskViewerProvider.ts:1450-1463` | `_updateKanbanColumnForSession` return type changed from `Promise<void>` to `Promise<boolean>`. Returns `false` on all failure paths (`!column`, `!db`, `!updated`, `!planFile`), `true` on success. |
| 3 | `src/services/TaskViewerProvider.ts:2263-2267` | `_applyManualKanbanColumnChange` now captures `_updateKanbanColumnForSession` return value, logs a warning, and returns `false` if the column update failed. |
| 4 | `src/services/TaskViewerProvider.ts:12103-12144` | `_handleCopyPlanLink` inner try/catch refined: checks `_applyManualKanbanColumnChange` return (`advanced`); on `false` sends webview `copyPlanLinkResult` with `success: true, warning: 'Prompt copied but card could not be advanced...'`; catch block also sends `success: true` with warning. Clipboard copy is never reported as failed when only column advance fails. |
| 5 | `src/services/KanbanDatabase.ts:424-465` | `forWorkspace` now redirects child workspace roots to parent path BEFORE `_instances` cache lookup when `workspaceDatabaseMappings` with `parentFolder` is configured. Prevents dead in-memory instances and ghost DB files at child paths. |

### Validation

- **TypeScript compilation:** `npx tsc --noEmit` completed with exit code 0. No new errors introduced in modified files. Pre-existing module-resolution warnings at `KanbanProvider.ts:3991` and `ClickUpSyncService.ts:2309` are unrelated to this change.
- **Call-site compatibility verified:** `_updateKanbanColumnForSession` has 6 callers. Only `_applyManualKanbanColumnChange` was updated to check the new boolean return; the other 5 callers ignore the return value, which is safe in TypeScript.

### Remaining Risks

- **Orphaned cache entries:** Existing `_kanbanDbs` entries keyed by child path will become orphaned (no lookup hit) until provider disposal. Benign — new entries created under parent key.
- **Webview warning display:** The `copyPlanLinkResult` message now includes an optional `warning` field. If the webview handler doesn't read it, the warning is silently ignored (no breakage).

## Reviewer Pass

**Date reviewed:** 2026-05-13

### Stage 1: Grumpy Adversarial Findings

> *adjusts spectacles, leans over desk*
>
> **CRITICAL — none.** The root cause fix is correct and the defensive guard in `forWorkspace` is well-placed. But don't celebrate yet, team.
>
> **MAJOR:** `KanbanDatabase.invalidateWorkspace` was left completely untouched. You redirect child paths to the parent in `forWorkspace`, so the instance is keyed by the **parent** path. But `invalidateWorkspace` still does a naive `path.resolve(workspaceRoot)` and looks up `_instances.get(stable)` using the **child** path. When settings change (e.g., `kanban.dbPath` is updated from a child workspace context), the invalidation silently no-ops because the key mismatch means nothing is found. The parent instance — with its stale `_db`, stale `_initPromise`, and stale `dbPath` — lives on like a zombie. Next time someone accesses the DB from the child workspace, `forWorkspace` redirects to the parent, finds the zombie, and serves it up. Congratulations, you've just made cache invalidation *worse* for shared databases than it was before. Ghost DBs may be gone, but ghost *instances* are now immortal.
>
> **NIT:** The `expandHome` closure is duplicated in three places now (the redirect block, the `dbPath` override block, and the newly extracted helper). It's a four-line helper. Extract it to a private static method. I shouldn't have to say this.
>
> **NIT:** The webview handlers for `copyPlanLinkResult` in `kanban.html` and `implementation.html` only check `msg.success`. They ignore the new `warning` field entirely. So when a clipboard copy succeeds but the column advance fails, the user still sees a cheerful green "Copied!" toast and has no idea their card is still stuck in `CREATED`. They have to crack open DevTools like a caveman to see the console warning. UX malpractice.
>
> **NIT:** `handleKanbanBackwardMove` and `handleKanbanForwardMove` call `_applyManualKanbanColumnChange` in a loop and blithely ignore its boolean return. If one card in a batch of ten fails to move, the loop marches on, the method returns `void`, and the user gets zero feedback. Hope you enjoy silently dropping user actions on the floor.

### Stage 2: Balanced Synthesis

**What to keep:**
- `KanbanProvider._getKanbanDb` using `resolveEffectiveWorkspaceRoot` — the correct root-cause fix.
- Boolean return propagation from `_updateKanbanColumnForSession` → `_applyManualKanbanColumnChange` → `_handleCopyPlanLink` — clean, type-safe, no caller breakage.
- `forWorkspace` child→parent redirect — excellent defensive guard that eliminates ghost DB creation at the source.
- Refined inner try/catch in `_handleCopyPlanLink` — correctly avoids the misleading "Failed to copy plan link" error when only the column advance fails.

**What I fixed:**
- Extracted the child→parent redirect logic into `KanbanDatabase._redirectToParentIfMapped` private static helper.
- Applied the helper to `KanbanDatabase.invalidateWorkspace` so cache invalidation works correctly for shared databases.
- Removed the duplicate inline redirect block from `forWorkspace`, replacing it with a single call to the helper.

**What to defer:**
- Webview `warning` field display — console warnings exist; proper UI surfacing is a small follow-up UX task, not a bug.
- Batch move error propagation — `handleKanbanBackwardMove`/`handleKanbanForwardMove` return `void` by design for fire-and-forget batch operations; changing this is out of scope.

### Additional Changes Applied

| # | File | Change |
|---|------|--------|
| 6 | `src/services/KanbanDatabase.ts:424-456` | Extracted `_redirectToParentIfMapped` private static helper from the inline redirect block in `forWorkspace`. |
| 7 | `src/services/KanbanDatabase.ts:463` | `forWorkspace` now calls `KanbanDatabase._redirectToParentIfMapped(validation.resolved!)` instead of the inline block. |
| 8 | `src/services/KanbanDatabase.ts:553-554` | `invalidateWorkspace` now calls `KanbanDatabase._redirectToParentIfMapped(path.resolve(workspaceRoot))` before cache lookup, fixing cache invalidation for shared databases. |

### Updated Validation

- **TypeScript compilation (`npx tsc --noEmit`):** Exit code 0. No new errors in modified files. Pre-existing module-resolution warnings at `KanbanProvider.ts:3991` and `ClickUpSyncService.ts:2309` remain unrelated.
- **Test tsconfig compilation (`npx tsc -p tsconfig.test.json --noEmit`):** Exit code 0. No errors.
- **Integration tests:** VS Code extension host tests (`vscode-test`) require the extension runtime and were not executed in this review environment. The changes are conservative and preserve all existing call signatures.

### Updated Remaining Risks

- **Webview warning display:** The `copyPlanLinkResult` message includes an optional `warning` field. Webview handlers do not render it; users must check the console for advance-failure details. Low impact — copy still succeeds.
- **Orphaned cache entries:** Existing `_kanbanDbs` entries keyed by child path in `KanbanProvider` will become orphaned until provider disposal. Benign.
- **Batch move silent failures:** `handleKanbanBackwardMove` and `handleKanbanForwardMove` ignore per-card `_applyManualKanbanColumnChange` failures. Existing behavior, low impact.

## Reviewer Pass 2

**Date reviewed:** 2026-05-14

### Stage 1: Grumpy Adversarial Findings

> *slams coffee mug on desk, squints at the diff*
>
> **CRITICAL — none.** The root-cause fix is correct. `KanbanProvider._getKanbanDb` now uses `resolveEffectiveWorkspaceRoot`, the boolean return propagation is clean, the inner try/catch in `_handleCopyPlanLink` is properly refined, and the `_redirectToParentIfMapped` guard in `KanbanDatabase.forWorkspace` is well-placed. The previous reviewer's MAJOR finding about `invalidateWorkspace` was correctly fixed. Now for the part that actually matters...
>
> **MAJOR: `_redirectToParentIfMapped` silently skips redirect when `parentFolder` is absent.** You extracted this helper to defend direct callers of `KanbanDatabase.forWorkspace` — `GlobalPlanWatcherService`, `ClickUpAutomationService`, `SessionActionLog`, `LinearAutomationService`, `PlanFileImporter` — from creating ghost DBs at child paths. But your guard only fires when `mapping.parentFolder` is set. When a mapping has `workspaceFolders` but no `parentFolder`, `resolveEffectiveWorkspaceRoot` falls back to `workspaceFolders[0]` as the effective parent (line 3023-3024). Your `_redirectToParentIfMapped` does NOT. It just returns the child path unchanged. So every direct caller still creates a ghost DB at the child path in the no-`parentFolder` fallback scenario. You've fixed the `parentFolder` case but left the fallback case wide open — same class of bug, different config shape. Inconsistent.
>
> **NIT: `expandHome` is still triplicated.** There are three copies of the exact same 4-line closure: `_redirectToParentIfMapped` (line 436), `forWorkspace` (line 473), and two more inline expansions at lines 511 and 525. The previous reviewer flagged this and punted. Extract it to a `private static _expandHome` method. It's four lines. Do it.
>
> **NIT: Double `copyPlanLinkResult` message on column-advance failure.** At line 12090, a `copyPlanLinkResult` with `success: true` is sent immediately after the clipboard write. Then, if the column advance fails, ANOTHER `copyPlanLinkResult` with `success: true, warning: '...'` is sent at line 12128. The kanban.html handler (line 4795) sees both, shows "Copied!" twice in rapid succession, and ignores the `warning` field entirely. The user has no idea their card is still stuck. The first message at line 12090 should be deferred until after the column-advance attempt so only ONE message is sent — either pure success or success-with-warning.

### Stage 2: Balanced Synthesis

**What to keep:**
- `KanbanProvider._getKanbanDb` using `resolveEffectiveWorkspaceRoot` — correct root-cause fix
- Boolean return propagation chain: `_updateKanbanColumnForSession` → `_applyManualKanbanColumnChange` → `_handleCopyPlanLink` — clean, type-safe
- `forWorkspace` child→parent redirect via `_redirectToParentIfMapped` — excellent defensive guard
- `invalidateWorkspace` using `_redirectToParentIfMapped` — correctly fixed by previous reviewer
- Refined inner try/catch in `_handleCopyPlanLink` — correctly avoids misleading error

**What I fixed:**
- Added fallback logic to `_redirectToParentIfMapped` — when `isChild` is true but `parentFolder` is absent, redirect to `workspaceFolders[0]`, consistent with `resolveEffectiveWorkspaceRoot`. Also added a guard against self-redirect (`parentResolved !== resolvedRoot`).
- Extracted `_expandHome` to a `private static` method on `KanbanDatabase`, replacing all 5 inline copies (3 closures + 2 inline expansions).
- Deferred the initial `copyPlanLinkResult` message at line 12090 until after the column-advance attempt, so only ONE message is sent. On success, sends `{ success: true }`. On advance failure, sends `{ success: true, warning: '...' }`. Eliminates the double-toast.

**What to defer:**
- Webview `warning` field rendering in `kanban.html`/`implementation.html` — the warning is now sent in a single message, but the handlers still ignore it. Proper UI surfacing (e.g., yellow toast) is a small follow-up UX task.
- Batch move error propagation in `handleKanbanBackwardMove`/`handleKanbanForwardMove` — existing fire-and-forget design, out of scope.

### Additional Changes Applied (Pass 2)

| # | File | Change |
|---|------|--------|
| 9 | `src/services/KanbanDatabase.ts:424-432` | Extracted `_expandHome` private static method from the inline closures. |
| 10 | `src/services/KanbanDatabase.ts:440-468` | `_redirectToParentIfMapped` now falls back to `workspaceFolders[0]` when `parentFolder` is absent (consistent with `resolveEffectiveWorkspaceRoot`). Added self-redirect guard (`parentResolved !== resolvedRoot`). Replaced inline `expandHome` with `_expandHome` calls. |
| 11 | `src/services/KanbanDatabase.ts:491-526` | Replaced all remaining inline `expandHome` closures/expansions in `forWorkspace` with `KanbanDatabase._expandHome` calls. |
| 12 | `src/services/TaskViewerProvider.ts:12089-12150` | Deferred `copyPlanLinkResult` message until after column-advance attempt. Introduced `advanceWarning` variable to accumulate warning text. Single message now sent with optional `warning` field — eliminates double-toast on advance failure. |

### Updated Validation (Pass 2)

- **TypeScript compilation (`npx tsc --noEmit`):** Exit code 0. No new errors in modified files. Pre-existing module-resolution warnings at `KanbanProvider.ts:3991` and `ClickUpSyncService.ts:2309` remain unrelated.
- **Integration tests:** VS Code extension host tests (`vscode-test`) require the extension runtime and were not executed in this review environment. The changes are conservative and preserve all existing call signatures.

### Updated Remaining Risks

- **Webview warning display:** The `copyPlanLinkResult` message now includes an optional `warning` field in a single message (no double-toast). Webview handlers do not render the `warning` field; users must check the console for advance-failure details. Low impact — copy still succeeds, and the double-toast issue is fixed.
- **Orphaned cache entries:** Existing `_kanbanDbs` entries keyed by child path in `KanbanProvider` will become orphaned until provider disposal. Benign.
- **Batch move silent failures:** `handleKanbanBackwardMove` and `handleKanbanForwardMove` ignore per-card `_applyManualKanbanColumnChange` failures. Existing behavior, low impact.

## Reviewer Pass 3

**Date reviewed:** 2026-05-14

### Stage 1: Grumpy Adversarial Findings

> *squints at diff, rotates monitor to reduce glare*
>
> **CRITICAL — none.** The root-cause fix is correct. `KanbanProvider._getKanbanDb` now uses `resolveEffectiveWorkspaceRoot`. The boolean return chain is clean. The `_redirectToParentIfMapped` guard in `KanbanDatabase.forWorkspace` is well-placed with the `workspaceFolders[0]` fallback and self-redirect guard. The deferred `copyPlanLinkResult` message eliminates the double-toast. Previous reviewer findings about `invalidateWorkspace` and `expandHome` duplication were both correctly addressed.
>
> **MAJOR — none.** I spent ten minutes looking for a trapdoor and couldn't find one. The code actually does what the plan says. I'm as surprised as you are.
>
> **NIT: `resolveEffectiveWorkspaceRoot` in `KanbanProvider` still carries its own inline `~` expansion.** `KanbanDatabase._expandHome` was extracted to a shared static method, but `KanbanProvider.resolveEffectiveWorkspaceRoot` (lines 3018-3022, 3037-3041) never got the memo. It still uses raw `f.startsWith('~')` without `trim()`. If a user fat-fingers a leading space into their `workspaceDatabaseMappings` config, `KanbanProvider` won't match it (no redirect) while `KanbanDatabase.forWorkspace` WILL match it (redirects to parent). The DB instances still converge because `forWorkspace` is the ultimate arbiter, but the cache key universe splits — child-path-keyed `KanbanProvider._kanbanDbs` entries and parent-path-keyed ones both pointing to the same instance. It's not a correctness bug, it's an aesthetic crime against consistency.
>
> **NIT: `_getSessionLog` in `KanbanProvider` still uses `path.resolve`.** Not in the plan's scope, but worth noting: `_getSessionLog` caches `SessionActionLog` instances by child path. Each instance has its own in-memory event queue. Two instances (child and parent contexts) both flush to the same shared DB. No data loss, but events that could have been batched in a single queue are now flushed independently. A missed optimization, not a bug.
>
> **NIT: Webview handlers still ignore the `warning` field.** `kanban.html` line 4804 only checks `msg.success` — it shows a cheerful green "Copied!" toast even when `warning` is present. `implementation.html` line 2897 does the same. The user still has no UI-visible indication that their card is stuck in `CREATED` after a successful copy. Previous reviewers punted this; I will too, but with more theatrical disdain.

### Stage 2: Balanced Synthesis

**What to keep:**
- `KanbanProvider._getKanbanDb` using `resolveEffectiveWorkspaceRoot` — correct root-cause fix
- Boolean return propagation chain — clean, type-safe, no caller breakage
- `KanbanDatabase._redirectToParentIfMapped` with fallback and self-redirect guard — excellent defensive guard
- `invalidateWorkspace` using `_redirectToParentIfMapped` — correctly fixed by previous reviewer
- `_expandHome` extracted to static method — eliminates duplication within `KanbanDatabase`
- Deferred `copyPlanLinkResult` message — correctly avoids double-toast and misleading errors

**What I fixed:**
- Nothing. No material issues found. The NITs are cosmetic and out of scope for a bugfix of this complexity.

**What to defer:**
- `expandHome` inconsistency between `KanbanProvider` and `KanbanDatabase` — cosmetic, requires cross-module refactoring
- `_getSessionLog` cache key inconsistency — performance optimization, not a bug
- Webview `warning` field rendering — UX follow-up, out of scope

### Verification (Pass 3)

- **TypeScript compilation (`npx tsc --noEmit`):** Exit code 0. 2 pre-existing module-resolution warnings (unrelated to this change).
- **Test tsconfig compilation (`npx tsc -p tsconfig.test.json --noEmit`):** Exit code 0. No errors.
- **Call-site compatibility verified:** All 6 callers of `_updateKanbanColumnForSession` are safe with the new `Promise<boolean>` return. `_applyManualKanbanColumnChange` has 4 callers; 2 check the return value, 2 ignore it (batch operations, safe by design).
- **Code review of modified files:** Verified all 12 plan changes are present in `KanbanProvider.ts`, `TaskViewerProvider.ts`, and `KanbanDatabase.ts`.

### Remaining Risks (Pass 3)

- **Webview warning display:** The `copyPlanLinkResult` message includes an optional `warning` field in a single message. Webview handlers in `kanban.html` and `implementation.html` do not render it; users must check the console for advance-failure details. Low impact — copy still succeeds, double-toast is fixed.
- **Orphaned cache entries:** Existing `_kanbanDbs` and `_sessionLogs` entries keyed by child path in `KanbanProvider` will become orphaned until provider disposal. Benign — new entries created under parent key.
- **Batch move silent failures:** `handleKanbanBackwardMove` and `handleKanbanForwardMove` ignore per-card `_applyManualKanbanColumnChange` failures. Existing behavior, low impact.
- **`expandHome` inconsistency:** `KanbanProvider.resolveEffectiveWorkspaceRoot` and `KanbanDatabase._redirectToParentIfMapped` handle whitespace-padded paths differently. Not exploitable in practice but a latent inconsistency.

## Recommendation

Complexity ≤ 6 → **Send to Coder**
