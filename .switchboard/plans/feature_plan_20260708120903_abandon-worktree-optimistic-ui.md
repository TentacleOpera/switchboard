# Feature Plan: Fix Abandon Worktree Button Lag with Optimistic UI

## Goal

### Problem
The "Abandon" button in the Worktrees tab of `kanban.html` is super laggy and slow. Clicking it triggers a blocking `git worktree remove --force`, an N+1 database query pattern in `_sendWorktreeConfig`, and a full DOM rebuild — all without any immediate UI feedback. The user stares at a frozen button for several seconds.

### Background
- **Button**: `src/webview/kanban.html` lines 10312–10319 — creates the Abandon button, calls `abandonWorktree(w.id, w.branch, w.path)`. The button is inside `renderWorktreeRow(w, isNested)` (function starts at line 10229), which creates a `row` div (line 10230) containing a `mainLine` div (line 10234).
- **JS handler**: the `abandonWorktree` function (~line 10119) — posts `{ type: 'abandonWorktree', worktreeId, branch, wtPath, workspaceRoot: currentWorkspaceRoot }` to backend.
- **Backend handler**: `src/services/KanbanProvider.ts` lines 9373–9396:
  1. Closes worktree terminals (`closeWorktreeTerminals`)
  2. Runs `git worktree remove --force` synchronously (`await execFileAsync`)
  3. Updates DB status to 'abandoned' (both in try and catch — even on git error, status becomes 'abandoned')
  4. Calls `_sendWorktreeConfig(workspaceRoot)` — full refresh (line 9394, OUTSIDE the try/catch, so refresh always happens)
- **`_sendWorktreeConfig`**: lines 10041–10079 — fetches all worktrees (`db.getWorktrees()` returns only `status = 'active'`, line 3045 of KanbanDatabase.ts), all feature plans, then for EACH worktree calls `db.getPlanByPlanId(w.feature_id)` individually (N+1 query at line 10062), scans control plane directory, sends entire config to webview.
- **Webview render**: `renderWorktreesTab()` at lines 10188–10197 — does `root.innerHTML = ''` and rebuilds the entire panel via `createWorktreesPanel(lastWorktreeConfig)`. Row building happens in `renderWorktreeList()` (line 10380) which loops `worktreeSubset.forEach(w => listDiv.appendChild(renderWorktreeRow(w, false)))` (line 10387).

### Root Cause
1. **No optimistic UI**: Button click provides zero immediate feedback — no spinner, no row removal, no disabled state.
2. **Blocking git operation**: `git worktree remove --force` on a large worktree takes seconds.
3. **N+1 query in refresh**: `_sendWorktreeConfig` queries each worktree's plan individually instead of batching.
4. **Full DOM rebuild**: The entire worktrees tab is re-rendered from scratch.

## Metadata

- **Tags:** frontend, backend, performance, ui, ux
- **Complexity:** 5

## User Review Required

No — this is a pure UX/performance improvement with no product-scope changes, no schema migrations, and no breaking changes. The optimistic UI is additive (fade-out + skip-check), the N+1 optimisation is a backend query-pattern improvement that returns the same data, and the new `getPlansByPlanIds` method is additive. Safe to implement without user sign-off on scope.

## Complexity Audit

### Routine
- Adding optimistic UI: disable button + show "Removing..." text + fade out the worktree row on click.
- Adding a `removingWorktreeIds` Set in the webview to track in-flight abandonments and skip them on re-render.

### Complex / Risky
- Optimising `_sendWorktreeConfig` to batch-fetch plan data instead of N+1 — requires a new DB method or in-memory join.
- Ensuring the optimistic row removal reconciles correctly when the `worktreeConfig` message arrives (the abandoned worktree should already be gone from the server list).

## Edge-Case & Dependency Audit

### Race Conditions
- If the user clicks Abandon on two worktrees rapidly, both should be optimistically removed. The `removingWorktreeIds` Set handles this.
- If the backend abandon fails (git error), the worktree row was already removed from DOM. The `worktreeConfig` refresh will NOT re-add it — the catch block (lines 9390-9392) also marks status 'abandoned', and `getWorktrees()` filters to `status = 'active'` (KanbanDatabase.ts line 3045), so the abandoned worktree never returns in the config. The user sees a warning toast ("Abandon completed with warnings") but the row stays gone. This is acceptable — the worktree directory may still exist on disk but the DB record is retired. The user can re-create a worktree for the same branch if needed.

### Security
- None.

### Side Effects
- The `worktreeConfig` message will still arrive and trigger a full re-render. The optimistic removal just makes the wait feel instant. The re-render reconciles to the same state.

### Dependencies & Conflicts
- The N+1 optimisation is a backend change that benefits all worktree config refreshes, not just abandon. Low risk but touches DB query patterns.

## Dependencies

- No upstream plan dependencies. This is a standalone UX/performance fix.
- The `getPlansByPlanIds` batch method (section 3) must be added to `KanbanDatabase.ts` BEFORE the `_sendWorktreeConfig` call site is changed — the batch call will fail at compile time otherwise (TypeScript will catch the missing method).

## Adversarial Synthesis

Key risks: (1) the skip-check logic must not delete from `_removingWorktreeIds` inside the render loop — `getWorktrees()` filters to `status='active'`, so the abandoned worktree never reappears in config, making the delete premature and causing a flash-back if a second re-render fires before abandon completes. (2) The `getPlansByPlanIds` batch method must handle empty input (zero feature_ids) without throwing a SQL error on an empty IN clause. (3) The optimistic fade uses `row.style.opacity` which is safe in VS Code webviews — no `window.confirm()` or modal APIs involved. Mitigations: skip-check only suppresses during the in-flight window, cleanup happens after full render via config diff; empty-input guard (`featureIds.length > 0 ? ... : []`) already in the plan code.

## Proposed Changes

---

### 1. `src/webview/kanban.html` — Optimistic UI on Abandon click

**Context**: Lines 10226–10233, the Abandon button click handler.

**Implementation**:
```javascript
// BEFORE (lines 10226-10233):
const abandonBtn = document.createElement('button');
abandonBtn.className = 'btn-danger';
abandonBtn.style.cssText = 'padding: 3px 6px; font-size: 10px; font-family: inherit; margin-right:8px;';
abandonBtn.textContent = 'Abandon';
abandonBtn.addEventListener('click', () => {
    abandonWorktree(w.id, w.branch, w.path);
});
mainLine.appendChild(abandonBtn);

// AFTER:
const abandonBtn = document.createElement('button');
abandonBtn.className = 'btn-danger';
abandonBtn.style.cssText = 'padding: 3px 6px; font-size: 10px; font-family: inherit; margin-right:8px;';
abandonBtn.textContent = 'Abandon';
abandonBtn.addEventListener('click', () => {
    // Optimistic UI: disable button, show removing state, fade out row
    abandonBtn.disabled = true;
    abandonBtn.textContent = 'Removing...';
    abandonBtn.style.opacity = '0.5';
    if (row && row.style) {
        row.style.transition = 'opacity 0.3s ease';
        row.style.opacity = '0.4';
    }
    // Track in-flight abandonment so re-render skips it
    if (!window._removingWorktreeIds) window._removingWorktreeIds = new Set();
    window._removingWorktreeIds.add(w.id);
    abandonWorktree(w.id, w.branch, w.path);
});
mainLine.appendChild(abandonBtn);
```

**Note**: `row` is the actual variable name for the worktree row container (defined at line 10230 in `renderWorktreeRow`). It is in scope inside the click handler closure.

---

### 2. `src/webview/kanban.html` — Skip in-flight removals on re-render

**Context**: `renderWorktreeList()` at line 10380, specifically the forEach loop at line 10387: `worktreeSubset.forEach(w => listDiv.appendChild(renderWorktreeRow(w, false)))`. This is where each worktree row is built and appended. The skip must happen HERE (not inside `renderWorktreeRow`, which returns the row element — returning `undefined` would break `appendChild`).

**Key insight**: `db.getWorktrees()` (KanbanDatabase.ts line 3045) queries `WHERE status = 'active'`. Once the backend marks a worktree as 'abandoned' (which it does in BOTH the try and catch blocks), it will never appear in the config again. So the skip-check's only job is to suppress the row during the in-flight window — between click and config refresh — if another event triggers a re-render while the worktree is still 'active' in the DB. Do NOT delete from the set inside the skip-check (that would be premature — the abandon hasn't completed yet).

**Implementation**:
```javascript
// In renderWorktreeList(), replace line 10387:
// BEFORE:
worktreeSubset.forEach(w => listDiv.appendChild(renderWorktreeRow(w, false)));

// AFTER:
worktreeSubset.forEach(w => {
    // Skip worktrees that are being optimistically removed (in-flight abandon)
    if (window._removingWorktreeIds && window._removingWorktreeIds.has(w.id)) return;
    listDiv.appendChild(renderWorktreeRow(w, false));
});
```

**Cleanup**: After the render loop completes, remove completed abandonments from the set. Since `getWorktrees()` filters to `status = 'active'`, any id in `_removingWorktreeIds` that is NOT in the current config has been successfully abandoned. Add this at the end of `renderWorktreesTab()` (after line 10193, after `createWorktreesPanel` returns):
```javascript
// Clean up completed abandonments from the in-flight set
if (window._removingWorktreeIds && lastWorktreeConfig) {
    const activeIds = new Set((lastWorktreeConfig.worktrees || []).map(w => w.id));
    for (const id of Array.from(window._removingWorktreeIds)) {
        if (!activeIds.has(id)) window._removingWorktreeIds.delete(id);
    }
}
```

---

### 3. `src/services/KanbanProvider.ts` — Optimise `_sendWorktreeConfig` N+1 query

**Context**: Lines 10041–10079, the method fetches each worktree's plan individually. The N+1 call is at line 10062: `const featurePlan = await db.getPlanByPlanId(w.feature_id)` inside the `for (const w of worktrees)` loop at line 10058.

**Implementation**: Batch-fetch all plans in a single query instead of per-worktree:
```typescript
// BEFORE: N+1 pattern
for (const w of worktrees) {
    const plan = await db.getPlanByPlanId(w.feature_id);
    // ... build config
}

// AFTER: Batch fetch
const featureIds = worktrees.map(w => w.feature_id).filter(Boolean);
const plans = featureIds.length > 0 ? await db.getPlansByPlanIds(featureIds) : [];
const planMap = new Map(plans.map(p => [p.planId, p]));
for (const w of worktrees) {
    const plan = w.feature_id ? planMap.get(w.feature_id) : undefined;
    // ... build config
}
```

**Note**: This requires adding a `getPlansByPlanIds(ids: string[])` method to `KanbanDatabase.ts`. The singular `getPlanByPlanId` exists at line 3377 (signature: `public async getPlanByPlanId(planId: string): Promise<KanbanPlanRecord | null>`). The codebase already uses IN-clause placeholder patterns (e.g. `setProjectForPlans` at line 3029: `const placeholders = planIds.map(() => '?').join(', ')`). Add the batch method following the same pattern, using `PLAN_COLUMNS` for the SELECT list (consistent with `getPlanByPlanId`).

---

### 4. `dist/webview/kanban.html`

Rebuild via `npm run build`. Do NOT manually edit.

## Verification Plan

### Manual Verification
- [ ] Click Abandon on a worktree — button immediately shows "Removing..." and disables
- [ ] The worktree row fades out within 100ms of click (no multi-second wait)
- [ ] After backend completes, the row is gone from the list (no flash/reappear)
- [ ] Click Abandon on two worktrees rapidly — both show optimistic state
- [ ] If backend abandon fails (e.g. git error), the row does NOT reappear — the catch block still marks status 'abandoned' and `getWorktrees()` filters to `status='active'`. Verify the warning toast appears instead.
- [ ] Verify other worktree operations (create, open terminals) still work after abandon

### Automated

- Compilation (`npm run compile`) and automated tests are SKIPPED per session directive. Verify via the manual checklist above using an installed VSIX.
- If `getPlansByPlanIds` is added, a unit test for it is recommended post-implementation (not part of this verification pass).

## Files Changed

- `src/webview/kanban.html` — optimistic UI + in-flight tracking
- `src/services/KanbanProvider.ts` — batch query in `_sendWorktreeConfig`
- `src/services/KanbanDatabase.ts` — add `getPlansByPlanIds` method (if needed)
- `dist/webview/kanban.html` — rebuild artefact
