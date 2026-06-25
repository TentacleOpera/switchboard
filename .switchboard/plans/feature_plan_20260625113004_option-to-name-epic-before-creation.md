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
- **Tags:** frontend, backend, ui, feature
- **Complexity:** 5/10

## User Review Required
- None. The behavior is decided: single-plan promotion stays **in-place** (no new record), with an optional rename that must persist to both the DB topic **and** the plan file's `# H1` heading (see Edge-Case audit and Change 4 below for why the file rewrite is mandatory).

## Complexity Audit
**Moderate (5/10).** The modal already exists and works for the multi-plan path; the bulk of the work is routing the single-plan path through the same modal and threading an optional `name` through the existing `promoteToEpic` backend handler. The one genuine risk that lifts this above "trivial" is the topic-durability data-consistency issue: a custom name written only to the DB is silently reverted to the old `# H1` heading on the next file re-import, so the backend must also rewrite the file heading.

### Routine
- Adding an `opts` parameter to `openEpicCreateModal()` and toggling field visibility / button + title labels (reuses the existing modal and `escapeHtml`/`postKanbanMessage` patterns).
- Routing the single-plan click branch to `openEpicCreateModal({ singlePlanPromote: true })` instead of dispatching `promoteToEpic` directly.
- Branching the existing submit handler on `subtaskPlanIds.length === 1` to dispatch `promoteToEpic` (with `name`) vs `createEpic`.
- Threading an optional `name` into the `promoteToEpic` backend handler and using it for the slug.

### Complex / Risky
- **Topic durability across re-import.** Updating only the DB `topic` is not durable — `extractTopic` (PlanFileImporter.ts:206) re-derives topic from the file's `# H1`, and `insertFileDerivedPlan` overwrites `topic` on conflict (KanbanDatabase.ts:1328-1329). The custom name MUST also be written into the file's `# H1` heading or it reverts on the next re-import.
- Preserving `selectedCards` between opening the modal and submitting (the old single-plan branch cleared selection immediately; the modal path must defer clearing to the submit handler).

## Edge-Case & Dependency Audit

### Race Conditions
- The promote flow runs synchronously inside the message handler and is watcher-suppressed (`GlobalPlanWatcherService.registerPendingCreation(newAbsPath)` + `registerRename(oldRelPath)`), so the file move does not trigger a competing re-import mid-promotion. The new topic write (DB + file `# H1`) must happen **before** the move so the suppressed move carries the final content; no additional locking is required.

### Security
- The custom name is user-supplied free text. It is already escaped for display via `escapeHtml` in the plan list, and the slug derivation strips it to `[a-z0-9-]`. When rewriting the file `# H1`, treat the name as plain text (single-line) — strip any embedded newlines so the user cannot inject a second heading or break the markdown structure.

### Side Effects
- A custom name changes the file slug, so the file is renamed (e.g. `old-slug-<planId>.md` → `new-slug-<planId>.md`). The trailing `<planId>` is preserved, so the subtask→epic link still survives re-import. The file's `# H1` heading is also rewritten (new behavior) so the DB topic is durable.
- No new plan record is created — promotion stays in-place.

### Dependencies & Conflicts
- `db.updatePlanTopic(planId, topic)` **does not exist**. Do not invent it inline — either add it (per the note below) or reuse the existing `db.updateTopicByPlanFile(plan.planFile, plan.workspaceId, name)` (KanbanDatabase.ts:1721), called **before** `updatePlanFileByPlanId` so it matches the still-current `plan.planFile`. Reusing the existing method is preferred (no net-new API).
- The DB topic update alone is **not** durable across re-import (see Complexity Audit → Complex/Risky). The file `# H1` rewrite is a hard dependency of the custom-name feature, not optional polish.

- **In-place promotion vs. new record:** The current `promoteToEpic` promotes the plan **in-place** (marks `is_epic=1`, moves file to `epics/`, no new plan record). The `createEpic` path creates a **new** plan record and links the original plan as a subtask. If we route single-plan through the modal, we must decide: does a custom name still promote in-place (just renaming), or does it create a new epic record?
  - **Recommended:** Keep the in-place promotion behavior. The `promoteToEpic` backend should accept an optional `name` parameter. If provided, it updates the plan's `topic` before promoting. If not provided (or same as current topic), behavior is unchanged.
- **Modal pre-fill:** The modal should pre-fill the name input with the plan's current topic (not `topic + ' Epic'`, since this is a promotion, not a new epic from multiple plans).
- **Backward compatibility:** The `promoteToEpic` message currently does not send a `name` field. The backend must treat a missing `name` as "use existing topic" (current behavior).
- **Modal description field:** The single-plan promotion has no use for the description field (the plan already has its own content). The description field should be hidden or disabled for the single-plan case.
- **Plan list in modal:** For single-plan, the modal shows "1 plan selected" with the plan topic. This is fine.

## Dependencies
- None. All required infrastructure (the `#epic-create-modal`, the `promoteToEpic`/`createEpic` handlers, `updateTopicByPlanFile`) already exists.

## Adversarial Synthesis
Key risks: (1) writing the custom name only to the DB topic — it silently reverts to the old `# H1` heading on the next file re-import; (2) clearing `selectedCards` too early (before modal submit), which would post an empty selection; (3) the empty-name guard relying on `alert()`, which is a confirmed silent no-op in the sandboxed webview. Mitigations: rewrite the file `# H1` alongside the DB topic in the backend, defer all selection clearing to the submit handler, and replace the `alert()` guard with an in-webview inline error (the pre-filled name makes empty submission rare regardless).

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

**Clarification — modal title.** The modal header `<h3 class="modal-title">Create Epic</h3>` (line 3145) has **no `id`**. To flip it to "Promote to Epic" for the single-plan case, add `id="epic-create-title"` to that `<h3>` and set `.textContent` in each branch alongside the submit-button label. This is optional polish; leaving the title as "Create Epic" is acceptable since the submit button already reads "Promote to Epic".

**Clarification — selection must persist.** The old single-plan click branch (lines 9347–9358) cleared `selectedCards` immediately after dispatch. Routing through the modal removes that early clear; selection is now cleared only in the submit handler (Change 3), so the modal still has the selection to read when the user submits.

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

**Required — replace the `alert()` guard.** This handler currently uses `alert('Epic name is required.')` (line 9370). **`alert()` is a confirmed silent no-op in the VS Code webview** — the sandboxed iframe omits `allow-modals`, so `alert`/`confirm`/`prompt` return immediately and only log a console warning (same constraint that makes `confirm()` a no-op — see CLAUDE.md). The guard therefore shows the user nothing. Replace it with an in-webview indicator: focus `#epic-create-name` and toggle a `.modal-input-error` class (or set `nameInput.placeholder`/border), then `return`. Do **not** use `alert`/`confirm`/`prompt` and do **not** add a confirm dialog. Even if the guard is bypassed, both backends are safe: `createEpic` rejects an empty name, and single-plan `promoteToEpic` falls back to the existing topic when `name` is blank — so this is a UX/feedback fix, not a correctness blocker.

### `src/services/KanbanProvider.ts` — `promoteToEpic` handler (lines 7426–7467)

**Change 4: Accept an optional `name`, and when it differs from the current topic, persist it to BOTH the DB topic AND the file's `# H1` heading before moving the file.**

> ⚠️ **Durability requirement (do not skip the file rewrite).** `extractTopic` (PlanFileImporter.ts:206) derives the topic from the file's first `# H1` line, and `insertFileDerivedPlan` does `ON CONFLICT(plan_file, workspace_id) DO UPDATE SET topic = excluded.topic` (KanbanDatabase.ts:1328-1329). So if the custom name is written only to the DB, the **next** re-import (file touch, startup re-scan) silently reverts the epic name to the old heading. The backend must rewrite the file's `# H1` so the name survives.
>
> `db.updatePlanTopic(planId, ...)` **does not exist** — the plan-id-keyed method is not present. Reuse the existing `db.updateTopicByPlanFile(plan.planFile, plan.workspaceId, name)` (KanbanDatabase.ts:1721), called while `plan.planFile` is still the current (pre-move) value.

```typescript
case 'promoteToEpic': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot || !msg.planId) break;
    const db = this._getKanbanDb(workspaceRoot);
    if (!db || !(await db.ensureReady())) break;
    const plan = await db.getPlanByPlanId(String(msg.planId));
    if (!plan) { vscode.window.showWarningMessage('Plan not found.'); break; }
    if (plan.isEpic) { vscode.window.showWarningMessage('Plan is already an epic.'); break; }

    // If a custom name is provided, persist it to BOTH the DB topic and the file's
    // # H1 heading. DB-only is NOT durable: the next re-import re-derives topic from
    // the heading (extractTopic) and overwrites the DB topic via insertFileDerivedPlan's
    // ON CONFLICT ... DO UPDATE SET topic = excluded.topic.
    // Strip newlines so a multi-line name cannot inject a second heading.
    const customName = msg.name ? String(msg.name).replace(/[\r\n]+/g, ' ').trim() : '';
    if (customName && customName !== plan.topic) {
        // 0a. DB topic (use the still-current pre-move plan_file as the key)
        await db.updateTopicByPlanFile(plan.planFile, plan.workspaceId, customName);
        // 0b. File # H1 heading — rewrite the first H1 (or prepend one if absent)
        try {
            const curAbsPath = path.resolve(workspaceRoot, plan.planFile);
            const content = await fs.promises.readFile(curAbsPath, 'utf8');
            const rewritten = /^#\s+.+$/m.test(content)
                ? content.replace(/^#\s+.+$/m, `# ${customName}`)
                : `# ${customName}\n\n${content}`;
            await fs.promises.writeFile(curAbsPath, rewritten, 'utf8');
        } catch (titleErr) {
            console.warn(`[KanbanProvider] promoteToEpic: H1 rewrite failed (DB topic still updated): ${titleErr}`);
        }
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

**Clarification (not new scope):** the `updateTopicByPlanFile` + `# H1` rewrite must occur while `plan.planFile` still points at the old `.switchboard/plans/...` path — i.e. before `updatePlanFileByPlanId`/`rename` below. The watcher suppression (`registerPendingCreation` + `registerRename`) already covers the move, so the in-place content edit does not trigger a competing import.

## Verification Plan

### Automated Tests
- No automated tests are added in this change; the test suite is run separately by the user (per session directive). If a unit test were added, it would target the backend `promoteToEpic` custom-name path: assert that after promotion with a custom name, both the DB `topic` and the moved file's `# H1` heading equal the custom name, and that a subsequent re-import (via `PlanFileImporter`) leaves the topic unchanged.

### Manual Verification
1. **Single plan, default name:** Select 1 plan, click PROMOTE TO EPIC. Modal opens with the plan's topic pre-filled. Click "Promote to Epic" without changing the name. Confirm the plan is promoted in-place and appears as an epic with the original topic.
2. **Single plan, custom name:** Select 1 plan, click PROMOTE TO EPIC. Modal opens. Change the name to "My Custom Epic Name". Click "Promote to Epic". Confirm the epic appears with the custom name and the file slug reflects the custom name.
3. **Multiple plans, custom name:** Select 2+ plans, click PROMOTE TO EPIC. Modal opens with description field visible. Enter a name and description. Click "Create Epic". Confirm a new epic is created with the custom name and the subtasks are linked.
4. **Modal cancel:** Open the modal, click Cancel. Confirm no epic is created and selection is preserved.
5. **Empty name validation:** Open the modal, clear the name field, click submit. Confirm the `alert` prevents submission.
6. **Description hidden for single-plan:** Open the modal with 1 plan selected. Confirm the description label and textarea are hidden. Open with 2+ plans. Confirm they are visible.
7. **Custom name survives re-import (durability):** Promote a single plan with a custom name. Then touch/save the epic file (or trigger a workspace re-scan) so the importer re-runs. Confirm the epic name on the board is STILL the custom name (not the original topic) — this verifies the file `# H1` was rewritten, not just the DB topic.
8. **Title label (if implemented):** With the optional title `id` change, open the modal for a single plan and confirm the header reads "Promote to Epic"; for 2+ plans confirm it reads "Create Epic".

## Uncertain Assumptions
- None outstanding. The one prior uncertainty — whether `alert()` is suppressed in the VS Code webview — was confirmed via web research: the sandboxed iframe omits `allow-modals`, so `alert`/`confirm`/`prompt` are silent no-ops (VS Code issues #67109, #185204; WHATWG sandboxed-modals flag). The plan now requires replacing the `alert()` guard with an in-webview inline indicator (see Change 3).

---

**Recommendation:** Complexity 5/10 → **Send to Coder.**
