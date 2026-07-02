# Remove "Create Worktrees for All Epics" Button from Worktrees Tab

## Goal

Remove the "Create Worktrees for All Epics" button from the kanban.html Worktrees tab. This batch button creates a worktree for every epic in one shot, but the user has decided it is no longer needed — the per-epic manual creation dropdown plus the auto-provisioning radio modes cover all use cases, and the batch button adds UI clutter without sufficient value.

### Problem Analysis & Root Cause

The button lives in `createWorktreesPanel()` inside `src/webview/kanban.html` (lines 9298–9311). It posts a `createWorktreesForAllEpics` message to the extension backend. The backend handler in `src/services/KanbanProvider.ts` (lines 8142–8188) loops over every epic plan, calls `_createSafetyWorktree`, and calls `ensureWorktreeTerminals` for each — a heavy operation that can take a long time and hit the `MAX_AUTOBAN_TERMINALS_PER_ROLE = 5` ceiling silently.

The button is purely additive UI — removing it does not affect the per-epic dropdown, the project dropdown, the auto-mode radios, or the active worktrees list. The backend handler can be left in place (harmless dead code) or removed; this plan removes both the UI and the handler for cleanliness.

## Metadata

- **Tags:** frontend, backend, ui, cleanup
- **Complexity:** 2

## Complexity Audit

### Routine
- Deleting a DOM-element block from `createWorktreesPanel()` in `kanban.html` — pure UI removal, no state dependencies.
- Deleting the `case 'createWorktreesForAllEpics'` block in `KanbanProvider.ts` — the handler is self-contained and not referenced anywhere else.
- No database schema changes, no migrations, no state to preserve.

### Complex / Risky
- None. The button has no downstream side effects beyond creating worktrees, and the remaining creation paths (per-epic dropdown, auto-mode) are independent.

## Edge-Case & Dependency Audit

- **Orphaned message handler:** If only the UI is removed, the `createWorktreesForAllEpics` case in `KanbanProvider.ts` becomes dead code. Removing it is safe — no other code path posts that message type.
- **No user data impact:** Existing worktrees created via the batch button remain in the database and render normally in the active worktrees list.
- **No migration needed:** This feature only ever existed in unreleased dev work; clean break is acceptable per project rules.

## Proposed Changes

### 1. `src/webview/kanban.html` — Remove the batch button block

Delete lines 9298–9311 (the `// 2. Create worktrees for all epics` block):

```javascript
// REMOVE THIS ENTIRE BLOCK:
// 2. Create worktrees for all epics
const batchEpicsBtn = document.createElement('button');
batchEpicsBtn.className = 'worktree-primary-btn';
batchEpicsBtn.style.alignSelf = 'flex-start';
batchEpicsBtn.textContent = 'Create Worktrees for All Epics';
batchEpicsBtn.addEventListener('click', () => {
    batchEpicsBtn.disabled = true;
    postKanbanMessage({
        type: 'createWorktreesForAllEpics',
        workspaceRoot: currentWorkspaceRoot
    });
    setTimeout(() => { batchEpicsBtn.disabled = false; }, 5000);
});
actionSection.appendChild(batchEpicsBtn);
```

### 2. `src/services/KanbanProvider.ts` — Remove the backend handler

Delete the `case 'createWorktreesForAllEpics'` block (lines 8142–8188):

```typescript
// REMOVE THIS ENTIRE CASE BLOCK:
case 'createWorktreesForAllEpics': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    // ... (entire block through the closing brace and `break;`)
}
```

## Verification Plan

1. Open the kanban board and switch to the Worktrees tab.
2. Confirm the "Create Worktrees for All Epics" button is no longer present.
3. Confirm the "Create Epic Worktree" dropdown + button still works (select an epic, click create, verify worktree appears in active list).
4. Confirm the "Create Project Worktree" dropdown + button still works.
5. Confirm the auto-mode radios (None / Per Subtask / High-Low) still persist their selection.
6. Confirm the active worktrees list still renders existing worktrees (including any previously created via the batch button).
7. Run `npm run compile` to confirm no TypeScript errors from the removed handler.
