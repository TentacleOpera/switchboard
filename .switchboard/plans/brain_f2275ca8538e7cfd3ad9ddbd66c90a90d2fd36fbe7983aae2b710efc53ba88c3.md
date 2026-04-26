# Fix: Restore Missing KanbanProvider Methods (Compile Errors)

The extension has **18 TypeScript compiler errors** caused by a revert that deleted all
missing public/private methods from `KanbanProvider.ts` and left behind a stale
3-argument constructor call in `extension.ts`. The extension cannot compile or load
until these are restored.

No net-new functionality is required — every method was previously implemented and its
call-site contract is fully documented by the existing tests, callers, and the `_queueClickUpSync` /
`_queueLinearSync` helpers that are still present in the file.

---

## Error Summary (from `npm run compile`)

| # | File | Error | Root Cause |
|---|------|-------|------------|
| 1 | `extension.ts:1090` | `TS2554: Expected 2 arguments, but got 3` | Extra `undefined` arg on `new KanbanProvider(...)` |
| 2–3 | `extension.ts:1140, 1274` | `resolveEffectiveWorkspaceRoot` missing | Method deleted |
| 4 | `extension.ts:1319` | `setPlannerPromptWriter` missing | Method deleted |
| 5 | `extension.ts:1383` | `clearControlPlaneCache` missing | Method deleted |
| 6 | `extension.ts:1475` | `queueIntegrationSyncForSession` missing | Method deleted |
| 7–11 | `TaskViewerProvider.ts:446, 477, 490, 493, 524, 1442, 1568` | `resolveEffectiveWorkspaceRoot` missing | Method deleted |
| 12–13 | `TaskViewerProvider.ts:1299, 1364` | `getRepoScopeFromPlan` missing | Method deleted |
| 14 | `TaskViewerProvider.ts:1412` | `ensureControlPlaneSelection` missing | Method deleted |

---

## Open Questions

> [!NOTE]
> No breaking changes; all call-sites and contracts are already defined in callers.

---

## Proposed Changes

### `extension.ts`

#### [MODIFY] [extension.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts)

**Line 1090** — Remove spurious third argument:

```diff
-    const kanbanProvider = new KanbanProvider(context.extensionUri, context, undefined);
+    const kanbanProvider = new KanbanProvider(context.extensionUri, context);
```

---

### `KanbanProvider.ts`

All 9 missing methods will be added in a single grouped block near the end of the
public API surface (after `getDependenciesFromPlan`, before `_normalizeMcpTarget`).
Each method is justified by its callers below.

#### [MODIFY] [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts)

**1. Private field: `_repoScopeFilter`**

Required by the `control-plane-repo-scope.test.js` assertion:
```
/private _repoScopeFilter: string \| null = null;/
```
Added to the class field declarations alongside the other private state fields.

```typescript
private _repoScopeFilter: string | null = null;
```

**2. Private field: `_plannerPromptWriter`**

Stores the `PlannerPromptWriter` reference injected from `extension.ts`.

```typescript
private _plannerPromptWriter: any | null = null;
```

---

**3. `resolveEffectiveWorkspaceRoot(workspaceRoot: string): string`**

Called 9 times (extension.ts ×2, TaskViewerProvider.ts ×7).
In the single-workspace case this is an identity function; in control-plane mode it
maps a child repo root to the control-plane root where `.switchboard/` actually lives.

Implementation: delegate to `_resolveWorkspaceRoot` which already persists the last
active root. For control-plane setups the mapping is read from a config key stored in
`workspaceState` (`kanban.controlPlaneRoot`). If no explicit override is set, returns
the passed-in root unchanged.

```typescript
public resolveEffectiveWorkspaceRoot(workspaceRoot: string): string {
    const explicit = this._context.workspaceState.get<string>('kanban.controlPlaneRoot');
    if (explicit && explicit.trim()) {
        return path.resolve(explicit.trim());
    }
    return path.resolve(workspaceRoot);
}
```

**4. `ensureControlPlaneSelection(workspaceRoot: string): Promise<void>`**

Called once in `TaskViewerProvider.initializeKanbanDbOnStartup()`.  
Reads the workspace-state key and validates the path still exists; clears the key if
the stored root is stale. No-op if no explicit root is set. Fire-and-forget.

```typescript
public async ensureControlPlaneSelection(workspaceRoot: string): Promise<void> {
    const explicit = this._context.workspaceState.get<string>('kanban.controlPlaneRoot');
    if (!explicit) return;
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved)) {
        console.warn(`[KanbanProvider] Stored control-plane root no longer exists: ${resolved}. Clearing.`);
        await this._context.workspaceState.update('kanban.controlPlaneRoot', undefined);
    }
}
```

**5. `getControlPlaneSelectionStatus(workspaceRoot?: string): ControlPlaneSelectionStatus`**

Called from `SetupPanelProvider` and `TaskViewerProvider` to drive the UI.
Exported type `ControlPlaneSelectionStatus` must also be exported from this file.

```typescript
export type ControlPlaneSelectionStatus = {
    mode: 'explicit' | 'auto';
    controlPlaneRoot: string | null;
    workspaceRoot: string | null;
};
```

```typescript
public getControlPlaneSelectionStatus(workspaceRoot?: string): ControlPlaneSelectionStatus {
    const resolved = workspaceRoot ? path.resolve(workspaceRoot) : null;
    const explicit = this._context.workspaceState.get<string>('kanban.controlPlaneRoot');
    if (explicit && explicit.trim()) {
        return { mode: 'explicit', controlPlaneRoot: path.resolve(explicit), workspaceRoot: resolved };
    }
    return { mode: 'auto', controlPlaneRoot: resolved, workspaceRoot: resolved };
}
```

**6. `setExplicitControlPlaneRoot(controlPlaneRoot: string | null, workspaceRoot?: string): Promise<void>`**

Saves an explicit control-plane root to `workspaceState`. Passing `null` clears it
(equivalent to "Reset to Auto-Detect").

```typescript
public async setExplicitControlPlaneRoot(
    controlPlaneRoot: string | null,
    workspaceRoot?: string
): Promise<void> {
    if (controlPlaneRoot === null) {
        await this._context.workspaceState.update('kanban.controlPlaneRoot', undefined);
        console.log('[KanbanProvider] Cleared explicit control-plane root.');
    } else {
        const resolved = path.resolve(controlPlaneRoot);
        await this._context.workspaceState.update('kanban.controlPlaneRoot', resolved);
        console.log(`[KanbanProvider] Set explicit control-plane root: ${resolved}`);
    }
    const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
    if (resolvedWorkspaceRoot) {
        this._scheduleBoardRefresh(resolvedWorkspaceRoot);
    }
}
```

**7. `clearControlPlaneCache(workspaceRoot?: string): Promise<void>`**

Called from the `switchboard.clearControlPlaneCache` command. Clears the stored
explicit root and triggers a board refresh.

```typescript
public async clearControlPlaneCache(workspaceRoot?: string): Promise<void> {
    await this._context.workspaceState.update('kanban.controlPlaneRoot', undefined);
    const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
    if (resolvedWorkspaceRoot) {
        this._scheduleBoardRefresh(resolvedWorkspaceRoot);
    }
    console.log('[KanbanProvider] Cleared control-plane cache.');
}
```

**8. `getRepoScopeFromPlan(workspaceRoot: string, planFile: string): Promise<string>`**

Reads the `**Repo:**` field from the plan's `## Metadata` section. Follows the exact
same file-resolution pattern as `getComplexityFromPlan` and `getTagsFromPlan`.
Returns empty string if the plan file doesn't exist or has no scope annotation.

```typescript
public async getRepoScopeFromPlan(workspaceRoot: string, planPath: string): Promise<string> {
    try {
        if (!planPath) return '';
        const resolvedPlanPath = path.isAbsolute(planPath)
            ? planPath
            : path.join(workspaceRoot, planPath);
        if (!fs.existsSync(resolvedPlanPath)) return '';
        const content = await fs.promises.readFile(resolvedPlanPath, 'utf8');
        const repoMatch = content.match(/^\*\*Repo:\*\*\s*(.+)$/im);
        if (!repoMatch) return '';
        const raw = repoMatch[1].trim();
        // Security: reject path-traversal values (same guard as sanitizeRepoScope in PlanFileImporter)
        if (/[/\\]|\.\./.test(raw)) return '';
        return raw;
    } catch {
        return '';
    }
}
```

**9. `getRepoScopeFilter(): string | null`**

Simple getter for the in-memory filter value. Used by `_refreshRunSheets` in
`TaskViewerProvider` to pass the active scope to `getBoardFiltered`.

```typescript
public getRepoScopeFilter(): string | null {
    return this._repoScopeFilter;
}
```

**10. `queueIntegrationSyncForSession(workspaceRoot: string, sessionId: string, targetColumn: string): Promise<void>`**

The central integration sync bridge. Required by the regression test:
```
/public async queueIntegrationSyncForSession\([\s\S]*await Promise\.allSettled\(\[[\s\S]*this\._queueClickUpSync\([\s\S]*this\._queueLinearSync\(/m
```

Fetches the plan record from the DB then fans out to `_queueClickUpSync` and
`_queueLinearSync` in parallel using `Promise.allSettled`.

```typescript
public async queueIntegrationSyncForSession(
    workspaceRoot: string,
    sessionId: string,
    targetColumn: string
): Promise<void> {
    try {
        const db = this._getKanbanDb(workspaceRoot);
        if (!await db.ensureReady()) return;
        const plan = await db.getPlanBySessionId(sessionId);
        if (!plan) {
            console.warn(`[KanbanProvider] queueIntegrationSyncForSession: no plan found for session ${sessionId}`);
            return;
        }
        await Promise.allSettled([
            this._queueClickUpSync(workspaceRoot, plan, targetColumn),
            this._queueLinearSync(workspaceRoot, plan, targetColumn)
        ]);
    } catch (err) {
        console.error('[KanbanProvider] queueIntegrationSyncForSession failed:', err);
    }
}
```

**11. `setPlannerPromptWriter(writer: any): void`**

Called once at startup in `extension.ts`. Stores the writer instance for potential
future use by `KanbanProvider` when constructing plan-specific prompts.

```typescript
public setPlannerPromptWriter(writer: any): void {
    this._plannerPromptWriter = writer;
}
```

**12. `moveCardToColumn(workspaceRoot: string, sessionId: string, targetColumn: string): Promise<boolean>`**

Called after a successful Linear task import to promote the new card to PLAN REVIEWED.
Uses the existing `db.updateColumn()` method.

```typescript
public async moveCardToColumn(
    workspaceRoot: string,
    sessionId: string,
    targetColumn: string
): Promise<boolean> {
    try {
        const db = this._getKanbanDb(workspaceRoot);
        if (!await db.ensureReady()) return false;
        const moved = await db.updateColumn(sessionId, targetColumn);
        if (moved) {
            await this.queueIntegrationSyncForSession(workspaceRoot, sessionId, targetColumn);
        }
        return moved;
    } catch (err) {
        console.error(`[KanbanProvider] moveCardToColumn failed for session ${sessionId}:`, err);
        return false;
    }
}
```

---

## Verification Plan

### Automated — must all pass

```bash
# 1. Clean compile (zero TS errors)
npm run compile 2>&1 | grep -c ERROR
# Expected: 0

# 2. Regression test: integration sync bridge shape
node src/test/plan-creation-integration-sync-regression.test.js
# Expected: "plan creation integration sync regression test passed"

# 3. Repo scope test (DB schema + KanbanProvider field + TaskViewerProvider query)
npm test -- --grep "control-plane-repo-scope" 2>&1 | tail -5
# (or run directly if not in mocha suite)
node src/test/control-plane-repo-scope.test.js
# Expected: "control-plane repo scope tests passed"
```

### Structural assertions verified by the tests

| Test | Assertion |
|------|-----------|
| `control-plane-repo-scope.test.js:123` | `private _repoScopeFilter: string \| null = null;` present |
| `control-plane-repo-scope.test.js:128` | `getRepoScopeFilter()` used in `_refreshRunSheets` with `getBoardFiltered` |
| `plan-creation-integration-sync-regression.test.js:17` | `queueIntegrationSyncForSession` fans out to `_queueClickUpSync` and `_queueLinearSync` via `Promise.allSettled` |

### Manual

- Open the extension in the Extension Development Host.
- Kanban board opens without errors.
- Run `switchboard.clearControlPlaneCache` command — no error thrown.
- Import a Linear task — card moves to PLAN REVIEWED.

## Verification Results

- **Compile:** PASS (0 TypeScript errors — webpack exit code 0)
- **Integration Sync Regression Test:** PASS (`plan creation integration sync regression test passed`)
- **Control Plane Repo Scope Test:** PASS (`control-plane repo scope tests passed`)

## Reviewer Pass Results (2026-04-25)

### Stage 1 — Adversarial Findings

| ID | Severity | Finding |
|----|----------|---------|
| F1 | MAJOR (latent) | `resolveEffectiveWorkspaceRoot` discards `workspaceRoot` arg when explicit CP root is set — correct for CP semantics but had no explanatory comment |
| F2 | NIT | `ControlPlaneSelectionStatus` exported type is richer than the plan's sketch (extra fields, `'none'` mode variant) — internally consistent with all callers, not a defect |
| F3 | NIT | `queueIntegrationSyncForSession` has an undocumented 4th `options?` parameter; the regression test regex is flexible enough to accommodate it (tests pass) |
| F4 | DOC | Plan's `Files Modified` claimed the regression test file was modified to allow the optional 4th arg — test file was **not** modified; the existing regex already handled it |
| F5 | NIT | `_plannerPromptWriter: any` lacked a suppression/explanation comment |

### Stage 2 — Actions Taken

| Finding | Action |
|---------|--------|
| F1 | Added 7-line JSDoc to `resolveEffectiveWorkspaceRoot` explaining control-plane intent |
| F2 | No change — implementation correct; plan sketch was always approximate |
| F3 | No change — tests pass, 4th param is additive and non-breaking |
| F4 | Corrected this plan file: test was not modified (regex already flexible) |
| F5 | Added `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comment with rationale |

### Post-Fix Verification

- **Compile:** PASS (exit code 0, `webpack 5.105.4 compiled successfully`)
- **Integration Sync Regression Test:** PASS
- **Control Plane Repo Scope Test:** PASS

## Files Modified

### Initial Implementation
1. `src/extension.ts:1090` — Removed spurious third argument from KanbanProvider constructor
2. `src/services/KanbanProvider.ts` — Added:
   - Type export: `ControlPlaneSelectionStatus` (richer than plan sketch; includes `mode:'none'`, `effectiveWorkspaceRoot`, `repoScopeFilter`, etc.)
   - Private fields: `_repoScopeFilter: string | null = null`, `_plannerPromptWriter: any | null = null`
   - Public methods (10): `resolveEffectiveWorkspaceRoot`, `ensureControlPlaneSelection`, `getControlPlaneSelectionStatus`, `setExplicitControlPlaneRoot`, `clearControlPlaneCache`, `getRepoScopeFromPlan`, `getRepoScopeFilter`, `queueIntegrationSyncForSession` (with optional 4th `options?` param), `setPlannerPromptWriter`, `moveCardToColumn`
3. `src/services/TaskViewerProvider.ts` — Pre-existing callers already present; no structural changes required by this plan

### Reviewer Fix-Up
4. `src/services/KanbanProvider.ts:~2295` — Added JSDoc comment to `resolveEffectiveWorkspaceRoot` explaining control-plane root-mapping semantics
5. `src/services/KanbanProvider.ts:~161` — Added `eslint-disable-next-line` suppression comment on `_plannerPromptWriter` field

## Remaining Risks

- `_repoScopeFilter` is declared but has no setter exposed via a public method — the filter can only be changed through internal state (not via any current caller). If a UI element wants to set the scope filter, a `setRepoScopeFilter()` method will be needed. This is a future gap, not a current defect.
- `resolveEffectiveWorkspaceRoot` in control-plane mode always returns the same root regardless of the child passed — correct for the current single-DB-per-control-plane model, but would need revisiting if per-child-repo DB isolation is ever introduced.

## Switchboard State
**Kanban Column:** CODE REVIEWED
**Status:** active
**Last Updated:** 2026-04-25T21:27:45.019Z
**Format Version:** 1
