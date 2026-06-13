# Worktrees Part 3: Epic Integration

## Goal

Link epics to worktrees: add a "Create Worktree" button on each epic card that creates a worktree named after the epic and stores the link in the DB. Add an "Epic Focus Mode" to the kanban board that filters plans by a single epic and switches the sub-bar worktree indicator to that epic's worktree.

## Dependencies

**Requires Part 2 complete.** The `worktrees` table and `epic_id` foreign key (introduced in Part 2 migration V30) are prerequisites for storing the epic ↔ worktree link.

## Problem Analysis

### Epic Linkage
Epics (plans with `is_epic=1` in the `plans` table) represent large, long-lived bodies of work. A worktree per epic provides clean branch isolation. The link is stored in `worktrees.epic_id` (already present in the V30 schema from Part 2). When a worktree is created from an epic card, the epic's topic is slugified as the branch name.

### "Create Worktree" on Epic Cards
Each epic card in the Kanban board needs a small button (suggested: a branch/fork icon). Clicking it calls `_createSafetyWorktree(workspaceRoot, epic.topic)` and stores `epicId` in the resulting DB row. If the epic already has a linked worktree, the button should instead show the branch name (no-op click or focus mode toggle).

### Epic Focus Mode
Clicking a focus icon on an epic card puts the kanban board into "epic focus mode":
- Only plans belonging to that epic are shown in the board
- The sub-bar worktree indicator (introduced in Part 4) switches to that epic's linked worktree if one exists
- A visible banner or indicator shows which epic is in focus, with an × to clear it

Focus mode is UI-only state (no DB write). It is stored in the webview's `currentFocusedEpicId` variable and cleared on tab reload.

## Metadata

**Tags:** backend, frontend, ux
**Complexity:** 6

## User Review Required

None.

## Complexity Audit

### Routine
- "Create Worktree" button on epic cards (HTML/JS)
- `createWorktreeForEpic` message handler (KanbanProvider.ts)
- Epic focus filter in board render loop
- Focus mode banner/indicator in sub-bar area
- Focus icon on epic card

### Complex / Risky
- **Already-linked check**: Must read `worktrees` table to determine if an epic already has a linked worktree before showing the Create button vs branch name.
- **Focus mode ↔ sub-bar indicator interaction**: Part 4 builds the sub-bar indicator; this plan adds the focus-mode trigger for it. The two parts must use the same `currentActiveWorktreePath` variable or message protocol.

## Edge-Case & Dependency Audit

### Already-Linked Epic
If an epic already has a worktree (`worktrees` row with `epic_id = this epic's id` and `status='active'`), the "Create Worktree" button is replaced with the branch name in a monospace chip. Clicking the chip enters focus mode for that epic.

### Deleted Worktree but Still Linked
The `worktrees.epic_id` row may have `status='abandoned'` or `status='merged'`. In this case, treat the epic as unlinked — show "Create Worktree" again.

### Multiple Focus Resets
Focus mode stores `currentFocusedEpicId` as a webview-local variable. Page reload resets it. No persistence needed.

### Sub-bar Indicator (Part 4 Dependency)
This plan emits a `setFocusedWorktree` message to the sub-bar when focus mode activates. Part 4 implements the sub-bar indicator that consumes this message. If Part 4 is not yet deployed, the message is a no-op.

## Proposed Changes

### Phase 6: Epic Card — Create Worktree Button and Linked State

**Files: `src/services/KanbanProvider.ts`, `src/webview/kanban.html`**

**Context**: Epic cards are rendered by `renderEpicCard` (or similar) in `kanban.html`. The `plans` table has `is_epic=1` for epics; the `worktrees` table has `epic_id` for the link.

**Change — `getKanbanData` response in `KanbanProvider.ts`**: Include `epicWorktrees` map in the board payload — a mapping of `epicId → { branch, path }` for all active worktrees with a non-null `epic_id`. This lets the webview render the correct state per card without separate queries.

```typescript
const epicWorktrees = db.getWorktrees()
    .filter(w => w.epic_id !== null && w.status === 'active')
    .reduce((acc, w) => { acc[w.epic_id!] = { branch: w.branch, path: w.path, id: w.id }; return acc; }, {} as Record<number, { branch: string; path: string; id: number }>);

// Include in board message
{ type: 'kanbanData', ..., epicWorktrees }
```

**Change — `createWorktreeForEpic` handler in `KanbanProvider.ts`**:

```typescript
case 'createWorktreeForEpic': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) break;
    const db = this._getKanbanDb(workspaceRoot);
    if (!db || !await db.ensureReady()) break;

    // Block if epic already has an active linked worktree
    const existing = db.getWorktrees().find(w => w.epic_id === msg.epicId && w.status === 'active');
    if (existing) {
        vscode.window.showInformationMessage(`Epic already has worktree: ${existing.branch}`);
        break;
    }

    try {
        const { branch, path: wtPath } = await this._createSafetyWorktree(workspaceRoot, msg.epicTopic);
        db.addWorktree(branch, wtPath, msg.epicId);

        // Force-create terminals in worktree
        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
        const roleToName: Record<string, string> = {
            'planner': 'Planner', 'lead': 'Lead Coder', 'coder': 'Coder',
            'intern': 'Intern', 'reviewer': 'Reviewer', 'analyst': 'Analyst'
        };
        for (const [role, enabled] of Object.entries(visibleAgents)) {
            if (!enabled) continue;
            const agentName = roleToName[role] || role.charAt(0).toUpperCase() + role.slice(1);
            await vscode.commands.executeCommand('switchboard.addAutobanTerminalFromKanban', role, agentName, wtPath);
        }

        vscode.window.showInformationMessage(`Worktree created for epic: ${branch}`);
        this._sendBoardData(workspaceRoot);  // refresh board to show linked state on card
    } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to create worktree: ${e.message}`);
    }
    break;
}
```

**Change — `kanban.html` epic card render**: Add a small button in the epic card header area:

```javascript
// In renderEpicCard / wherever epic cards are built:
const linkedWorktree = epicWorktrees[epic.id];
const wtButton = linkedWorktree
    ? `<span class="wt-chip" title="Worktree: ${linkedWorktree.branch}" onclick="enterEpicFocusMode(${epic.id})"
           style="font-family:monospace; font-size:10px; cursor:pointer; padding:1px 5px; background:var(--badge-bg); border-radius:3px;">
         ${linkedWorktree.branch}
       </span>`
    : `<button class="btn-icon" title="Create Worktree for this epic"
           onclick="vscode.postMessage({type:'createWorktreeForEpic', epicId:${epic.id}, epicTopic:'${escapeAttr(epic.topic)}', workspaceRoot:currentWorkspaceRoot})"
           style="opacity:0.6; font-size:10px;">⎇</button>`;
// Insert wtButton into card header HTML
```

**Verification**: Epic with no worktree → shows ⎇ button. Click → worktree created, card shows branch chip. Epic with existing active worktree → shows branch chip. Click chip → enters focus mode.

---

### Phase 7: Epic Focus Mode

**Files: `src/webview/kanban.html`**

**Context**: When a user clicks a focused epic's chip or the focus icon, the board filters to only show plans belonging to that epic. A banner at the top of the board shows which epic is focused. An × button clears focus mode.

**Change — `kanban.html`**: Add `currentFocusedEpicId` and `currentFocusedEpicWorktreePath` to webview state:

```javascript
let currentFocusedEpicId = null;
let currentFocusedEpicWorktreePath = null;
```

**`enterEpicFocusMode(epicId)` function**:

```javascript
function enterEpicFocusMode(epicId) {
    currentFocusedEpicId = epicId;
    const linked = currentEpicWorktrees[epicId];
    currentFocusedEpicWorktreePath = linked ? linked.path : null;

    // Update sub-bar indicator (Part 4 consumes this)
    vscode.postMessage({ type: 'focusWorktree', worktreePath: currentFocusedEpicWorktreePath });

    renderBoard();  // re-render with filter
    renderFocusBanner();
}

function clearEpicFocusMode() {
    currentFocusedEpicId = null;
    currentFocusedEpicWorktreePath = null;
    vscode.postMessage({ type: 'focusWorktree', worktreePath: null });
    renderBoard();
    renderFocusBanner();
}
```

**`renderFocusBanner()` function**: Renders or removes a banner in the `kanban-sub-bar` area (above the board, below the toolbar):

```javascript
function renderFocusBanner() {
    const bar = document.getElementById('kanban-focus-banner');
    if (!bar) return;
    if (!currentFocusedEpicId) {
        bar.style.display = 'none';
        return;
    }
    const epic = currentPlans.find(p => p.id === currentFocusedEpicId);
    const wtInfo = currentEpicWorktrees[currentFocusedEpicId];
    bar.style.display = 'flex';
    bar.innerHTML = `
        <span style="font-size:11px; flex:1;">
            Focus: <strong>${epic?.topic ?? 'Epic'}</strong>
            ${wtInfo ? `&nbsp;·&nbsp;<span style="font-family:monospace;">${wtInfo.branch}</span>` : ''}
        </span>
        <button class="btn-icon" onclick="clearEpicFocusMode()" title="Clear focus">×</button>
    `;
}
```

**Board filter**: In `renderBoard` / plan card iteration, when `currentFocusedEpicId` is set, skip any plan where `plan.epic_id !== currentFocusedEpicId` (and skip top-level non-epic plans).

**Add focus banner container** to `kanban.html` body (inside the board area, before the columns):

```html
<div id="kanban-focus-banner" style="display:none; align-items:center; padding:4px 8px; background:var(--banner-bg); border-bottom:1px solid var(--border-subtle);"></div>
```

**Verification**: Click epic chip → board shows only that epic's plans. Banner shows epic name and worktree branch. Click × → board returns to full view, banner hidden. No control plane needed for focus mode itself (worktree indicator just stays null if no worktree linked).

---

## Files Changed

- `src/services/KanbanProvider.ts` — Add `epicWorktrees` to board data, `createWorktreeForEpic` and `focusWorktree` handlers
- `src/webview/kanban.html` — Epic card worktree button/chip, `enterEpicFocusMode`/`clearEpicFocusMode`, focus banner

## Verification Plan

1. **No worktree**: Epic card shows ⎇ button.
2. **Create from card**: Click ⎇ → worktree created, card shows branch chip, terminals opened with worktree cwd.
3. **Already linked**: Reopen board → card still shows chip (persisted in DB).
4. **Focus mode enter**: Click chip → board filters, banner appears with epic name + branch.
5. **Focus mode clear**: Click × → full board restored, banner hidden.
6. **No worktree linked**: Enter focus mode on epic without worktree → board filters, banner shows epic name only, no branch shown.
7. **`focusWorktree` message**: Sent to extension on enter/clear — Part 4 sub-bar indicator picks this up.

## Risks

- **`epicWorktrees` stale**: If a worktree is merged/abandoned externally and the board is not refreshed, the chip stays visible. Mitigation: the board data is re-sent after `mergeWorktree`/`abandonWorktree` actions in Part 2, which clears the chip.
- **Part 4 not deployed yet**: `focusWorktree` message sent by focus mode is a no-op without Part 4's handler. Safe — messages with unhandled types are ignored.

## Recommendation

**Complexity: 6 → Send to Coder**

The epic card UI changes are the most involved part — careful to not break existing card rendering. The focus mode logic is self-contained webview state.
