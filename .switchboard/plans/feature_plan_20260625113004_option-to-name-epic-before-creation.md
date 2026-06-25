# Option to Name Epic Before Creation (Single-Plan Promote Path)

## Goal

### Problem
When an epic is created via `kanban.html`, the epic name is automatically derived from the selected plan's topic (or the first selected plan's topic if multiple plans were selected). There is no opportunity for the user to **name the epic before it gets created**.

### Background Context
There are two epic creation paths from the kanban board:

1. **Multiple plans selected** → `openEpicCreateModal()` (kanban.html line 7219) opens a modal with a name input (`#epic-create-name`), description textarea, and a plan list. The name field is pre-filled with a suggestion (`firstTopic + ' Epic'`, line 7230) but the user **can edit it**. This path already has the naming option.

2. **Single plan selected** → `promoteToEpic` message (kanban.html line 9353) → `KanbanProvider.ts` line 7426. This path **does not open a modal** — it promotes the plan in-place, deriving the epic name from the plan's existing `topic` field. There is **no opportunity to name the epic**.

### Root Cause
The single-plan path (lines 9347–9358 in `kanban.html`) directly posts a `promoteToEpic` message without any UI prompt. The backend (`KanbanProvider.ts` line 7426) uses the plan's existing `topic` as the epic name and derives the file slug from it (line 7439). The user cannot override this name.

The multi-plan path already has a modal (`#epic-create-modal`, lines 3141–3159) with a name input. The single-plan path should reuse this modal.

## Metadata
- **Tags:** kanban, epic, ui, modal, frontend
- **Complexity:** 4/10

## Complexity Audit
**Moderate.** The modal already exists and works for the multi-plan path. The fix is to route the single-plan path through the same modal, with a backend adjustment to accept a `name` parameter for `promoteToEpic` (or to use `createEpic` with a single subtask). The main risk is ensuring the single-plan path still promotes in-place (no new file) when the user accepts the default name, vs. creating a new epic record when the user provides a custom name.

## Edge-Case & Dependency Audit
- **In-place promotion vs. new record:** The current `promoteToEpic` promotes the plan **in-place** (marks `is_epic=1`, moves file to `epics/`, no new plan record). The `createEpic` path creates a **new** plan record and links the original plan as a subtask. If we route single-plan through the modal, we must decide: does a custom name still promote in-place (just renaming), or does it create a new epic record?
  - **Recommended:** Keep the in-place promotion behavior. The `promoteToEpic` backend should accept an optional `name` parameter. If provided, it updates the plan's `topic` before promoting. If not provided (or same as current topic), behavior is unchanged.
- **Modal pre-fill:** The modal should pre-fill the name input with the plan's current topic (not `topic + ' Epic'`, since this is a promotion, not a new epic from multiple plans).
- **Backward compatibility:** The `promoteToEpic` message currently does not send a `name` field. The backend must treat a missing `name` as "use existing topic" (current behavior).
- **Modal description field:** The single-plan promotion has no use for the description field (the plan already has its own content). The description field should be hidden or disabled for the single-plan case.
- **Plan list in modal:** For single-plan, the modal shows "1 plan selected" with the plan topic. This is fine.

## Proposed Changes

### `src/webview/kanban.html` — Click handler (lines 9347–9361)

**Change 1: Route single-plan selection through the epic create modal.**

Replace the direct `promoteToEpic` dispatch with `openEpicCreateModal()`, but flag it as a single-plan promotion:

```javascript
} else if (epics.length === 0 && nonEpics.length === 1) {
    // Single plan — open the modal with promotion mode
    openEpicCreateModal({ singlePlanPromote: true });
} else if (epics.length === 0 && nonEpics.length > 1) {
    openEpicCreateModal({ singlePlanPromote: false });
}
```

### `src/webview/kanban.html` — `openEpicCreateModal()` (lines 7219–7232)

**Change 2: Accept a mode parameter and adjust the modal for single-plan promotion.**

```javascript
function openEpicCreateModal(opts = {}) {
    const modal = document.getElementById('epic-create-modal');
    const planCount = document.getElementById('epic-create-plan-count');
    const planList = document.getElementById('epic-create-plan-list');
    const nameInput = document.getElementById('epic-create-name');
    const descLabel = modal?.querySelector('label[for="epic-create-description"]');
    const descInput = document.getElementById('epic-create-description');
    const submitBtn = document.getElementById('epic-create-submit');
    const selectedIds = Array.from(selectedCards.keys());
    const selectedPlans = selectedIds.map(id => currentCards.find(c => (c.planId || c.sessionId) === id)).filter(Boolean);
    if (planCount) planCount.textContent = `${selectedPlans.length} plan(s) selected`;
    if (planList) planList.innerHTML = selectedPlans.map(p => `<li>${escapeHtml(p.topic)}</li>`).join('');

    const isSinglePromote = opts.singlePlanPromote === true;
    // For single-plan promotion, pre-fill with the plan's exact topic (no "Epic" suffix)
    const firstTopic = selectedPlans[0]?.topic || '';
    if (isSinglePromote) {
        if (nameInput) nameInput.value = firstTopic;
        // Hide description — not applicable to in-place promotion
        if (descLabel) descLabel.style.display = 'none';
        if (descInput) descInput.style.display = 'none';
        if (submitBtn) submitBtn.textContent = 'Promote to Epic';
    } else {
        const suggestion = firstTopic.length > 40 ? firstTopic.substring(0, 37) + '...' : firstTopic;
        if (nameInput) nameInput.value = suggestion ? suggestion + ' Epic' : '';
        if (descLabel) descLabel.style.display = '';
        if (descInput) descInput.style.display = '';
        if (submitBtn) submitBtn.textContent = 'Create Epic';
    }
    if (modal) modal.classList.remove('hidden');
}
```

### `src/webview/kanban.html` — Submit handler (lines 9365–9381)

**Change 3: Dispatch `promoteToEpic` with name for single-plan, `createEpic` for multi-plan.**

```javascript
document.getElementById('epic-create-submit')?.addEventListener('click', () => {
    const nameInput = document.getElementById('epic-create-name');
    const descInput = document.getElementById('epic-create-description');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
        alert('Epic name is required.');
        return;
    }
    const subtaskPlanIds = Array.from(selectedCards.keys());
    const workspaceRoot = getActiveWorkspaceRoot();

    if (subtaskPlanIds.length === 1) {
        // Single-plan promotion — promote in-place with optional rename
        postKanbanMessage({ type: 'promoteToEpic', planId: subtaskPlanIds[0], name, workspaceRoot });
    } else {
        // Multi-plan — create new epic record
        postKanbanMessage({ type: 'createEpic', name, description: descInput ? descInput.value.trim() : '', subtaskPlanIds, workspaceRoot });
    }
    closeEpicCreateModal();
    selectedCards.clear();
    document.querySelectorAll('.kanban-card.selected').forEach(el => el.classList.remove('selected'));
    updateReassignButtonVisibility();
    updateEpicActionButton();
});
```

### `src/services/KanbanProvider.ts` — `promoteToEpic` handler (lines 7426–7467)

**Change 4: Accept an optional `name` parameter and update the plan's topic if provided.**

```typescript
case 'promoteToEpic': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot || !msg.planId) break;
    const db = this._getKanbanDb(workspaceRoot);
    if (!db || !(await db.ensureReady())) break;
    const plan = await db.getPlanByPlanId(String(msg.planId));
    if (!plan) { vscode.window.showWarningMessage('Plan not found.'); break; }
    if (plan.isEpic) { vscode.window.showWarningMessage('Plan is already an epic.'); break; }

    // If a custom name is provided, update the topic before promoting
    const customName = msg.name ? String(msg.name).trim() : '';
    if (customName && customName !== plan.topic) {
        await db.updatePlanTopic(plan.planId, customName);
    }

    // Use the custom name (or existing topic) for the slug
    const effectiveTopic = customName || plan.topic || 'epic';
    const slug = (effectiveTopic).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'epic';
    const epicDir = path.join(workspaceRoot, '.switchboard', 'epics');
    const oldAbsPath = path.resolve(workspaceRoot, plan.planFile);
    await fs.promises.mkdir(epicDir, { recursive: true });
    const newRelPath = path.join('.switchboard', 'epics', `${slug}-${plan.planId}.md`);
    const newAbsPath = path.join(workspaceRoot, newRelPath);

    await db.updatePlanFileByPlanId(plan.planId, newRelPath);
    await db.updateEpicStatus(plan.planId, 1, '');

    GlobalPlanWatcherService.registerPendingCreation(newAbsPath);
    const oldRelPath = plan.planFile.replace(/\\/g, '/');
    this._globalPlanWatcher?.registerRename(oldRelPath);

    try {
        await fs.promises.rename(oldAbsPath, newAbsPath);
    } catch (moveErr) {
        console.warn(`[KanbanProvider] promoteToEpic: file move failed, reverting DB path: ${moveErr}`);
        await db.updatePlanFileByPlanId(plan.planId, plan.planFile);
    }

    await this._refreshBoard(workspaceRoot);
    break;
}
```

**Note:** `db.updatePlanTopic` may need to be added to `KanbanDatabase.ts` if it does not exist. Check for an existing method like `updateTopic` or `updatePlanTopic`:

```typescript
public async updatePlanTopic(planId: string, topic: string): Promise<boolean> {
    return this._persistedUpdate(
        'UPDATE plans SET topic = ?, updated_at = ? WHERE plan_id = ?',
        [topic, new Date().toISOString(), planId]
    );
}
```

## Verification Plan
1. **Single plan, default name:** Select 1 plan, click PROMOTE TO EPIC. Modal opens with the plan's topic pre-filled. Click "Promote to Epic" without changing the name. Confirm the plan is promoted in-place and appears as an epic with the original topic.
2. **Single plan, custom name:** Select 1 plan, click PROMOTE TO EPIC. Modal opens. Change the name to "My Custom Epic Name". Click "Promote to Epic". Confirm the epic appears with the custom name and the file slug reflects the custom name.
3. **Multiple plans, custom name:** Select 2+ plans, click PROMOTE TO EPIC. Modal opens with description field visible. Enter a name and description. Click "Create Epic". Confirm a new epic is created with the custom name and the subtasks are linked.
4. **Modal cancel:** Open the modal, click Cancel. Confirm no epic is created and selection is preserved.
5. **Empty name validation:** Open the modal, clear the name field, click submit. Confirm the `alert` prevents submission.
6. **Description hidden for single-plan:** Open the modal with 1 plan selected. Confirm the description label and textarea are hidden. Open with 2+ plans. Confirm they are visible.
