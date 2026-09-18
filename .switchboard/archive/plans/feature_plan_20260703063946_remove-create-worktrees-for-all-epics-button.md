# Remove "Create Worktrees for All Epics" Button from Worktrees Tab

## Goal

Remove the "Create Worktrees for All Epics" button from the kanban.html Worktrees tab. This batch button creates a worktree for every epic in one shot, but the user has decided it is no longer needed — the per-epic manual creation dropdown plus the auto-provisioning radio modes cover all use cases, and the batch button adds UI clutter without sufficient value.

### Problem Analysis & Root Cause

The button lives in `createWorktreesPanel()` inside `src/webview/kanban.html` (lines 9827–9840, inside the function that starts at line 9613). It posts a `createWorktreesForAllEpics` message to the extension backend. The backend handler in `src/services/KanbanProvider.ts` (lines 8738–8783) loops over every epic plan, calls `_createSafetyWorktree`, and calls `ensureWorktreeTerminals` for each — a heavy operation that can take a long time and hit the `MAX_AUTOBAN_TERMINALS_PER_ROLE = 5` ceiling silently.

The button is purely additive UI — removing it does not affect the per-epic dropdown, the project dropdown, the auto-mode radios, or the active worktrees list. The backend handler can be left in place (harmless dead code) or removed; this plan removes both the UI and the handler for cleanliness.

**Bonus cleanup:** The batch button never forwarded `repoName` in its message (kanban.html line 9836), so in explicit control-plane mode with no scope filter it failed to target the right repo — a pre-existing bug noted in the `fix-worktree-creation-in-control-plane-directories` plan. Removing the button eliminates this dead-end code path entirely.

## Metadata

- **Tags:** frontend, backend, ui, cleanup
- **Complexity:** 2

## User Review Required

No — removing dead UI and its self-contained handler. No user data impact, no migration (unreleased feature).

## Dependencies

- None. This plan should land **first** in the epic (per epic sequencing: `77844254` → `7b858061` → `3a59baf3`) so the reorganization plan's target structure — which already omits the batch button — does not need to account for a transient dead button.

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

## Adversarial Synthesis

Key risks: orphaned message handler if only UI removed (mitigated by removing both); line anchors must be re-verified since sibling plans rewrite the same function. Mitigations: handler is self-contained with no other posters (verified — single UI reference at kanban.html line 9835); plan lands first per epic sequencing.

## Proposed Changes

### 1. `src/webview/kanban.html` — Remove the batch button block

Delete lines 9827–9840 (the `// 2. Create worktrees for all epics` block):

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

Delete the `case 'createWorktreesForAllEpics'` block (lines 8738–8783):

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

## Review Findings

**CRITICAL fix applied:** The implementer wrote the new reorganized `createWorktreesPanel` (Plan 2) but forgot to delete the old one — the old function (kanban.html line 9745) never closed its braces, nesting the new function and `renderWorktreeRow` inside it and causing a `SyntaxError: Unexpected end of input` that broke the ENTIRE kanban webview script. The old function body also still contained the batch button UI (posting `createWorktreesForAllEpics` to the already-removed backend handler). Fix: deleted the orphaned old function body (306 lines, kanban.html 9745-10050), freeing `renderWorktreeRow` to outer scope and making the new `createWorktreesPanel` the sole definition. The backend handler removal in `KanbanProvider.ts` was already clean (switch statement intact, no orphaned references). **Files changed:** `src/webview/kanban.html`. **Validation:** `node --check` on extracted script passes clean; brace balance 1632/1632; zero references to `createWorktreesForAllEpics` in source. **Remaining risks:** None — the batch button UI and backend handler are both fully removed.
