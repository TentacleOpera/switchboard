# Remove On-Board Epic Focus Mode & Consolidate Worktree Creation Into the Worktrees Tab

## Goal

**Remove on-board epic focus mode entirely**, and untangle the worktree creation that has leaked onto the epic card. Focus mode (clicking an epic to filter the board to its subtasks as independently-movable column cards) exists to let subtasks **diverge across stages** — which is the **wrong model**: an epic is a rigid unit whose subtasks always move with it, and the place to inspect or manage an epic's subtasks is the **Epics tab** (see `feature_plan_20260625081837_epics-as-orchestration-onramp.md`). With focus mode gone, the epic-card control that triggered it is repurposed: the worktree chip becomes a read-only branch label, and per-epic worktree creation moves to the Worktrees tab beside the other creation actions.

> **Model shift (supersedes this plan's original intent).** An earlier draft of this plan aimed to make focus mode *first-class and always-available*. That is now **rejected**: subtasks must not diverge across stages, so focus mode has no purpose. This plan instead **deletes** focus mode and keeps only its worktree-cleanup half.

### Problem Analysis & Root Cause

- **Focus mode models subtasks wrong.** `enterEpicFocusMode` (`src/webview/kanban.html` L4992-L5002) filters the board to a single epic's subtasks (`displayCards` keeps `cardId === currentFocusedEpicId || card.epicId === currentFocusedEpicId`, L5077-L5087) and surfaces per-column Advance-All over them — i.e. it lets subtasks sit in different stages. The decided model is the opposite: subtasks are a rigid unit that never diverge and never render as individual board cards. Focus mode's whole reason to exist is therefore removed.

- **Focus was welded to the worktree chip anyway.** The only trigger for `enterEpicFocusMode` is clicking the `.wt-chip` (L9310-L9317), which exists only when `currentEpicWorktrees[card.planId]` is set (epic card render L5359-L5367). So a pure view operation was gated behind git plumbing — a smell that disappears once focus is deleted.

- **The "focus the worktree" signal is inert.** Clicking the chip posts `focusWorktree` → backend stores `_focusedWorktreePath` (`KanbanProvider.ts` L152, set at L7204) and **nothing reads it** (verified: only 2 references in `src/` — the declaration at L152 and the assignment at L7204; no readers anywhere). The handler also calls `this._taskViewerProvider.notifyStateChanged()` (L7206) — a side effect whose subscribers must be checked before deletion (see Edge-Case Audit). Dead code to remove with focus mode.

- **Worktree execution routing is independent of focus.** Agents run inside an epic's worktree because a dispatched subtask carries `epic_id`, resolved to the worktree path at dispatch time via `TaskViewerProvider.resolveWorktreePathForPlan(...)` (`TaskViewerProvider.ts` L6992, called at L1705/L2864/L15514) → `findTerminalNameByWorktreePath` (`TaskViewerProvider.ts` L6972). Verified: neither references focus state. Unaffected by removing focus mode.

- **Worktree creation is duplicated/misplaced.** The Worktrees tab (`kanban.html` L8897 `createWorktreesPanel`) creates a **project** worktree (L8999-L9047), **all epics** in bulk (L9049-L9062), and an **unbound** worktree (L9064-L9085) — but has **no single-epic** option. The card's `⎇` `.create-wt-chip` button (`createWorktreeForEpic`, delegated at L9319-L9334) is the only per-epic path, which is why creation leaked onto the card.

### Conclusion

Delete focus mode (the Epics tab is the inspection surface). Demote the worktree chip to a read-only branch label and remove the per-card `⎇` creation button. Add a single-epic worktree creation option to the Worktrees tab. Dispatch routing by `epic_id` is untouched.

## Metadata

- **Tags:** `ux`, `frontend`, `refactor`, `feature`
- **Complexity:** 4

## User Review Required

No. This is a pure front-end deletion + UI relocation. No persisted state, schema, dispatch, or backend behavior changes (the only backend change is removing a write-only dead field and its handler). The model shift (subtasks never diverge) was already decided and is enforced data-side by the sibling plan `kanban-epic-subtask-column-leak-and-backlog-cascade.md` (§1 done). No user data or workflow is affected beyond removing a view filter the user has explicitly rejected.

## Complexity Audit

### Routine
- Pure deletion of focus-mode functions, state vars, banner element, and click delegators in one hot webview (`kanban.html`).
- Demoting the `.wt-chip` from clickable to read-only label is a 2-property CSS/attribute change (`cursor:pointer`→`cursor:default`, drop the delegator).
- The single-epic Worktrees-tab form reuses the existing `createWorktreeForEpic` message (backend handler at `KanbanProvider.ts` L7039) — no new backend message.
- The subtask-exclusion bullet (make `!card.epicId` unconditional) is **already done** by the sibling plan's §1 (implemented in working tree).

### Complex / Risky
- **Dangling-reference surface is wider than the obvious symbols.** Beyond `currentFocusedEpicId`/`enterEpicFocusMode`/`clearEpicFocusMode`/`renderFocusBanner`, the focus state leaks into: `currentFocusedEpicWorktreePath` (L3739), the `worktreeConfig` handler's `if (!currentFocusedEpicId)` guard (L6184), and `renderFocusBanner()` call (L6156). Every site must be collapsed to the unfocused path or removed. `updateWorktreeIndicator` (L4978) SURVIVES — it is still called from L6186/L6188 — only its calls inside the deleted focus functions disappear.
- **`focusWorktree` handler side effect.** The handler at L7202-L7208 calls `this._taskViewerProvider.notifyStateChanged()`. Removing it drops one `notifyStateChanged` call. Must verify no subscriber depends on that notification firing on focus changes (see Edge-Case Audit).

## Edge-Case & Dependency Audit

- **Race Conditions:** None introduced. The new epic-create button must reuse the existing 5-second disable-debounce pattern (as at L9042/L9082) to prevent double-click worktree spam — `createWorktreeForEpic` is not idempotent at the UI level (the backend blocks duplicate epic worktrees at L7047, but the button should still debounce to avoid redundant messages).
- **Security:** None. No new user input surfaces; the epic dropdown is built from already-trusted `currentCards`.
- **Side Effects:**
  - Removing the `focusWorktree` handler (L7202-L7208) removes one `this._taskViewerProvider.notifyStateChanged()` call. **Verification required:** grep `notifyStateChanged` consumers and confirm none read `_focusedWorktreePath` (which has zero readers — verified). If `notifyStateChanged` only refreshes tree views that don't depend on the focus field, removal is safe.
  - `updateWorktreeIndicator` (L4978) stays — it is called from the `worktreeConfig` handler (L6186/L6188) for the non-focus worktree indicator. Do NOT delete the function; only its calls inside `enterEpicFocusMode`/`clearEpicFocusMode` go away with those functions.
- **Dependencies & Conflicts:**
  - Depends on `kanban-epic-subtask-column-leak-and-backlog-cascade.md` §1 — the `!card.epicId` subtask exclusion. **§1 is already DONE** (implemented in working tree, unconditional). This plan's matching bullet (Proposed Change §1, second bullet) is therefore a **no-op / already-complete** — do not re-edit L5086.
  - The Worktrees-tab epic dropdown freshness depends on `createWorktreeForEpic`'s backend handler calling `_refreshBoard` (L7067) BEFORE `_sendWorktreeConfig` (L7068), both awaited in order. This ensures `updateBoard` (which updates `currentCards` + `currentEpicWorktrees`) lands before `worktreeConfig` (which re-renders the tab via L6182). **Invariant: do not reorder L7067/L7068.** No code change needed — just documented so a future refactor doesn't break the dropdown.
  - Worktree users lose chip-focus muscle memory — acceptable: focus is removed for everyone and replaced by the Epics tab. The chip remains visible as a non-interactive branch label so the worktree is still surfaced on the card.
  - No confirmation dialogs (project rule).
- **Dangling references — full removal checklist** (grep each, expect zero after):
  `currentFocusedEpicId`, `currentFocusedEpicWorktreePath`, `enterEpicFocusMode`, `clearEpicFocusMode`, `renderFocusBanner`, `focusWorktree`, `_focusedWorktreePath`, `kanban-focus-banner`, and the `.wt-chip` / `#kanban-focus-banner .btn-icon` click delegators. `updateWorktreeIndicator` must STILL appear (at L6186/L6188) — its presence is expected and correct.
- **Per-epic creation needs the epic list** — the Worktrees panel builds its dropdown from `currentCards.filter(c => c.isEpic)`, excluding epics that already have a worktree (via `currentEpicWorktrees[epicId]` — show the branch label instead). Both are module-level (L3736/L3737) and accessible inside `createWorktreesPanel`.

## Dependencies

None (no prerequisite sessions). Relates-to:
- `kanban-epic-subtask-column-leak-and-backlog-cascade.md` (§1 done — unconditional `!card.epicId` exclusion already in working tree; this plan's matching bullet is a no-op).
- `feature_plan_20260625081837_epics-as-orchestration-onramp.md` (Epics tab is the sole epic-inspection + orchestration surface).

## Adversarial Synthesis

Key risks: (1) the focus-state surface is wider than the obvious symbols — `currentFocusedEpicWorktreePath` (L3739), the `worktreeConfig` guard at L6184, and the `renderFocusBanner()` call at L6156 must all be collapsed, and `updateWorktreeIndicator` must NOT be deleted (it survives at L6186/L6188); (2) removing the `focusWorktree` handler drops a `notifyStateChanged` side effect whose subscribers must be confirmed not to depend on the write-only `_focusedWorktreePath`; (3) the new epic-create button must reuse the 5s disable-debounce pattern or users can spam worktree creation. Mitigations: full grep checklist including the non-obvious symbols; trace `notifyStateChanged` consumers before deleting the handler; copy the debounce pattern verbatim from L9042.

## Proposed Changes

### `src/webview/kanban.html` — Delete on-board focus mode

- **Context:** Focus mode is the wrong model (subtasks never diverge). All focus symbols are confined to this file's inline script.
- **Logic / Implementation:**
  - Delete `enterEpicFocusMode` (L4992-L5002) and `clearEpicFocusMode` (L5004-L5011).
  - Delete `renderFocusBanner` (L5013-L5031) and the focus banner element at L2540 (`<div id="kanban-focus-banner" ...>`).
  - Delete the module-level state `let currentFocusedEpicId = null;` (L3738) and `let currentFocusedEpicWorktreePath = null;` (L3739).
  - In `renderBoard`, remove the focus branch at L5077-L5087 and keep ONLY the unfocused subtask exclusion: `displayCards = displayCards.filter(card => !card.epicId);`. **Note:** this is already the unconditional behavior in the working tree (sibling plan §1 done) — verify, do not re-edit if already unconditional.
  - In the `updateBoard` handler: remove the `if (currentFocusedEpicId) { renderBoard(currentCards); }` branch at L6152-L6154 (collapse to the unfocused path — no re-render needed there since `epicWorktreesChanged`/`boardSignatureChanged` already gate re-render), and remove the `renderFocusBanner();` call at L6156.
  - In the `worktreeConfig` handler (L6180-L6191): remove the `if (!currentFocusedEpicId)` guard at L6184 and make the inner `updateWorktreeIndicator` logic unconditional:
    ```js
    if (activeWorktrees.length === 1) {
        updateWorktreeIndicator(activeWorktrees[0].path);
    } else {
        updateWorktreeIndicator(null);
    }
    ```
    (Keep `updateWorktreeIndicator` itself — it is still used here.)
  - In the global click delegator (L9303-L9341): delete the `.wt-chip` → `enterEpicFocusMode` block (L9310-L9317) and the `#kanban-focus-banner .btn-icon` → `clearEpicFocusMode` block (L9336-L9340). Keep the `.create-wt-chip` block for now (it is removed in the next section).
- **Edge Cases:** Do not delete `updateWorktreeIndicator` (L4978) — it survives via L6186/L6188. Do not touch `currentEpicWorktrees` (L3737) — needed for the chip label and the new dropdown.

### `src/webview/kanban.html` — Demote the worktree chip to a read-only label

- **Context:** With focus gone, the chip's only job is to display the linked branch. It is already a `<span>` with `title="Worktree: ${linkedWorktree.branch}"` (L5361-L5364). The only edits are removing interactivity.
- **Logic / Implementation:**
  - At L5361-L5364, change `cursor:pointer` → `cursor:default` on the `.wt-chip` span and remove `data-epic-id` (no longer needed — no delegator). Keep the `title` and branch text.
  - Remove the per-card `.create-wt-chip` `⎇` button entirely (L5365-L5367) — creation moves to the Worktrees tab.
  - Delete the `.create-wt-chip` click delegator block (L9319-L9334) — no longer reachable.
- **Edge Cases:** Epics without a worktree now show no chip at all (the `⎇` affordance is gone). Creation is discoverable via the Worktrees tab. This matches the plan's intent (creation consolidated in the tab).

### `src/webview/kanban.html` — Per-epic worktree creation in the Worktrees tab

- **Context:** `createWorktreesPanel` (L8897) already has project / all-epics / unbound forms. Add a single-epic picker beside "Create Worktrees for All Epics" (L9049-L9062).
- **Logic / Implementation:** Insert a new form between the all-epics button (L9062) and the unbound form (L9064):
  ```js
  // 2b. Create worktree for a single epic
  const epicForm = document.createElement('div');
  epicForm.style.cssText = 'display: flex; gap: 8px; align-items: center;';
  const epicLabel = document.createElement('span');
  epicLabel.style.fontSize = '11px';
  epicLabel.textContent = 'Epic:';
  const epicSelect = document.createElement('select');
  epicSelect.style.cssText = 'flex: 1; padding: 4px; font-size: 11px; background: var(--input-bg, #222); color: var(--text-normal, #ccc); border: 1px solid var(--border-color);';
  const epicDefaultOpt = document.createElement('option');
  epicDefaultOpt.value = '';
  epicDefaultOpt.textContent = '-- Choose an Epic --';
  epicSelect.appendChild(epicDefaultOpt);
  const epicCards = (Array.isArray(currentCards) ? currentCards : []).filter(c => c.isEpic);
  epicCards.forEach(epic => {
      if (currentEpicWorktrees[epic.planId]) return; // exclude epics that already have a worktree
      const opt = document.createElement('option');
      opt.value = epic.planId;
      opt.textContent = epic.topic;
      epicSelect.appendChild(opt);
  });
  const createEpicBtn = document.createElement('button');
  createEpicBtn.className = 'worktree-primary-btn';
  createEpicBtn.style.padding = '4px 8px';
  createEpicBtn.style.fontSize = '10px';
  createEpicBtn.textContent = 'Create Epic Worktree';
  if (config && config.controlPlaneMode === 'explicit' && repos.length === 0) {
      createEpicBtn.disabled = true;
      createEpicBtn.title = 'No git repositories detected in control plane';
  }
  createEpicBtn.addEventListener('click', () => {
      const selectedEpicId = epicSelect.value;
      if (!selectedEpicId) {
          showUIMessage('Please select an epic first.');
          return;
      }
      const epic = epicCards.find(e => e.planId === selectedEpicId);
      if (!epic) return;
      createEpicBtn.disabled = true;
      postKanbanMessage({
          type: 'createWorktreeForEpic',
          epicId: selectedEpicId,
          epicTopic: epic.topic,
          workspaceRoot: currentWorkspaceRoot,
          repoName: selectedWorktreeRepo || undefined
      });
      setTimeout(() => { createEpicBtn.disabled = false; }, 5000);
  });
  epicForm.appendChild(epicLabel);
  epicForm.appendChild(epicSelect);
  epicForm.appendChild(createEpicBtn);
  actionSection.appendChild(epicForm);
  ```
- **Edge Cases:**
  - Empty epic list → dropdown shows only the placeholder; button is a no-op (guarded by `showUIMessage`).
  - Dropdown freshness: relies on `_refreshBoard` (L7067) preceding `_sendWorktreeConfig` (L7068) in the backend handler — already the case (both awaited in order). Do not reorder.
  - Reuses `selectedWorktreeRepo` (L5948) for control-plane repo targeting, matching the project/unbound forms.

### `src/services/KanbanProvider.ts` — Remove the inert focus→worktree signal

- **Context:** `_focusedWorktreePath` is write-only (verified: only L152 declaration + L7204 assignment, zero readers). The `focusWorktree` handler (L7202-L7208) also calls `this._taskViewerProvider.notifyStateChanged()`.
- **Logic / Implementation:**
  - Delete the `case 'focusWorktree':` handler (L7202-L7208).
  - Delete the field `private _focusedWorktreePath: string | null = null;` (L152).
- **Edge Cases:** Before deleting, grep `notifyStateChanged` consumers and confirm none read `_focusedWorktreePath` (already verified zero readers). If any `notifyStateChanged` subscriber reads the focus field, it is already broken (no readers) — removal is safe. The `createWorktreeForEpic` handler (L7039-L7073) is untouched.

## Verification Plan

### Automated Tests

No automated tests apply (pure front-end deletion + UI relocation; the only backend change is removing dead code). Verification is manual + grep audit. Per session directives, do NOT run `npm run compile` or the test suite here — the user runs them separately.

1. **Focus gone:** no way to filter the board to a single epic's subtasks; no focus banner; subtasks never render as individual column cards (epic shows only its count badge). Inspecting an epic's subtasks is done in the **Epics tab** (via the Review button, per `review-epic-opens-kanban-tab-not-epic-tab.md`).
2. **No dangling refs (scoped grep):** `grep -n "currentFocusedEpicId\|currentFocusedEpicWorktreePath\|enterEpicFocusMode\|clearEpicFocusMode\|renderFocusBanner\|focusWorktree\|_focusedWorktreePath\|kanban-focus-banner" src/` returns **zero** matches. `grep -n "updateWorktreeIndicator" src/webview/kanban.html` still returns matches at L6186/L6188 (expected — the function survives). Board render and drag-drop not regressed.
3. **Worktree chip is a label:** clicking it does nothing (shows the branch tooltip only); the per-card `⎇` button is gone.
4. **Worktrees tab single-epic creation:** select an epic → worktree created and linked; the epic's card shows the branch label; that epic disappears from the dropdown on next render. Double-clicking the button is debounced (5s disable).
5. **Dispatch routing intact:** dispatch a subtask of a worktree-linked epic → agent still runs in the epic's worktree (routing via `epic_id` / `resolveWorktreePathForPlan` unchanged).
6. **Other themes/panels unchanged:** no regression to Claudify / Afterburner-Pro; no regression to the project / all-epics / unbound worktree forms.
7. **(User-run) Build:** `npm run compile` succeeds (run by user, not in this session).
8. **(User-run) Tests:** existing test suite passes (run by user, not in this session).

## Status

**IMPLEMENTED + REVIEWED.** All proposed changes applied in commit `70c0e08` (auto-commit before review). Reviewer pass complete — see `## Reviewer Pass` below. Reframed from "make focus first-class" to "remove focus + worktree cleanup" per the decided model. The subtask-exclusion bullet (Proposed Change §1, second bullet) was **already complete** via the sibling plan's §1 (unconditional `!card.epicId`) — verified in working tree, not re-edited. Relates-to: `kanban-epic-subtask-column-leak-and-backlog-cascade.md` (§1 done; §3 dropped) and `feature_plan_20260625081837_epics-as-orchestration-onramp.md` (Epics tab is the epic-inspection + orchestration surface).

> **Recommendation:** Send to Coder (complexity 4 — multi-site deletion in one hot file plus a new UI form reusing an existing backend message; no architectural risk but the dangling-reference surface warrants care).

## Reviewer Pass

### Stage 1 — Grumpy Principal Engineer

*"You want me to review a deletion? Fine. Deletions are where bugs hide, because nobody checks the seams. Let me poke every seam."*

- **[MAJOR] `showUIMessage` is a phantom function.** The brand-new epic-create form (`src/webview/kanban.html` L9145, post-edit) calls `showUIMessage('Please select an epic first.')` — a function that **does not exist anywhere in `src/`** (grep: zero definitions, two call sites). The dropdown defaults to the placeholder `value=''`, so the very first time a user clicks "Create Epic Worktree" without picking an epic, the handler throws a `ReferenceError`, the message never shows, and the button stays enabled with zero feedback. The plan *specified this call verbatim* — the plan was wrong about the helper existing. The project form at L9081 has the **same pre-existing bug** (copied the broken pattern). The codebase standard is `postKanbanMessage({ type: 'showWarning', message: ... })`, which the backend handles at `KanbanProvider.ts` L5526. **Fix applied.**

- **[NIT] `--border-color` has no fallback in the epic `<select>` style.** `epicSelect.style.cssText` uses `var(--border-color)` without a fallback (L9120). It IS defined at the root theme (L20/L42), so it resolves in shipped themes — but a custom theme that omits it gets a borderless select. The neighboring project/unbound forms do the same, so this is consistent with the file's conventions. Not worth fixing in isolation.

- **[NIT] Unescaped `linkedWorktree.branch` in the chip `title` attribute** (L5363). A branch name containing `"` would break the title attribute. Pre-existing (the original chip had the same unescaped title) and git branch names are charset-constrained, so not introduced by this plan. Out of scope.

- **[PASS] Dangling-reference checklist — clean.** Grep across `src/` for `currentFocusedEpicId|currentFocusedEpicWorktreePath|enterEpicFocusMode|clearEpicFocusMode|renderFocusBanner|focusWorktree|_focusedWorktreePath|kanban-focus-banner` returns **zero** matches. `updateWorktreeIndicator` correctly survives at L5019 (def) / L6181 / L6183. `currentEpicWorktrees` correctly survives at L3780/L5361/L6127/L6128/L9127. The `.wt-chip` span survives as a read-only label (L5363); `.create-wt-chip` and its delegator are gone. The global click delegator (L9404-L9410) no longer references any focus/chip selectors — only the button-flash animation remains.

- **[PASS] `updateBoard` restructure is behaviorally equivalent.** The new logic collapses the old `else if (epicWorktreesChanged)` / `else { if (currentFocusedEpicId) renderBoard }` into `else { currentCards = nextCards; if (epicWorktreesChanged) renderBoard }`. Traced all four branches against the original: sigChanged → `renderBoard(nextCards)` (same, and `renderBoard` sets `currentCards` at L5038); !sigChanged && epicWorktreesChanged → set + render (same); !sigChanged && !epicWorktreesChanged → set, no render (same, since the old `currentFocusedEpicId` branch is now permanently dead). Correct.

- **[PASS] `worktreeConfig` guard collapse is correct.** The `if (!currentFocusedEpicId)` guard at the old L6184 is gone; the `updateWorktreeIndicator` logic is now unconditional (L6180-L6184). Matches the plan exactly.

- **[PASS] `focusWorktree` handler + `_focusedWorktreePath` field removed.** `KanbanProvider.ts` L152 field and the L7202-L7208 handler are both gone. Traced `notifyStateChanged` (`TaskViewerProvider.ts` L9854): it triggers `_refreshConfiguredPlanWatcher`, `_stateSyncHook`, and `refresh()` — none read `_focusedWorktreePath` (which lived on `KanbanProvider` and had zero readers, verified). The two remaining `notifyStateChanged` callers (L878, L1871) fire for their own reasons. Removal is safe — the edge-case audit's claim holds.

- **[PASS] Backend invariant holds.** `createWorktreeForEpic` (`KanbanProvider.ts` L7070-L7104) still awaits `_refreshBoard` (L7098) BEFORE `_sendWorktreeConfig` (L7099). Dropdown freshness invariant preserved. Handler untouched.

- **[PASS] New epic-create form scoping.** `selectedWorktreeRepo` (L5948), `currentWorkspaceRoot` (L3800), `currentCards` (L3779), `currentEpicWorktrees` (L3780), `config`/`repos` (panel params), `postKanbanMessage`, `escapeHtml`/`escapeAttr` (L4381) — all in scope inside `createWorktreesPanel`. The 5s disable-debounce (L9158) matches the plan and the sibling buttons (L9109/L9183). `worktree-primary-btn` CSS class is defined (L63-L71). `epic.topic` is set via `textContent` (safe). The `epicCards` closure is consistent with the dropdown options (both built at the same render pass).

### Stage 2 — Balanced Synthesis

**Keep as-is:** All deletions (focus functions, state vars, banner element, click delegators, `focusWorktree` handler, `_focusedWorktreePath` field), the chip demotion to read-only label, the `updateBoard` restructure, the `worktreeConfig` guard collapse, and the new epic-create form structure. All match the plan and are behaviorally correct.

**Fix now (applied):**
1. **[MAJOR] `showUIMessage` → `postKanbanMessage({ type: 'showWarning', ... })`** at the new epic form (L9145) AND the pre-existing project form (L9081). Both were calling an undefined function; both now use the codebase-standard warning channel that the backend handles at `KanbanProvider.ts` L5526. The project-form fix is opportunistic (pre-existing, same bug class, one line) — leaving it broken while fixing only the new form would be inconsistent.

**Defer (noted, not fixed):**
- `--border-color` fallback in the epic select (NIT — matches file conventions; fix would be a file-wide sweep, out of scope).
- Unescaped `linkedWorktree.branch` in the chip title (NIT — pre-existing, git-constrained charset, out of scope).

### Code Fixes Applied

| File | Line(s) | Change |
| :--- | :--- | :--- |
| `src/webview/kanban.html` | 9145 | `showUIMessage('Please select an epic first.')` → `postKanbanMessage({ type: 'showWarning', message: 'Please select an epic first.' })` |
| `src/webview/kanban.html` | 9081 | `showUIMessage('Please select a project first.')` → `postKanbanMessage({ type: 'showWarning', message: 'Please select a project first.' })` (pre-existing same-bug fix) |

### Validation Results

- **Dangling-reference grep** (`currentFocusedEpicId|currentFocusedEpicWorktreePath|enterEpicFocusMode|clearEpicFocusMode|renderFocusBanner|focusWorktree|_focusedWorktreePath|kanban-focus-banner|showUIMessage` across `src/`): **0 matches**. PASS.
- **`updateWorktreeIndicator` survival grep** (`src/webview/kanban.html`): 3 matches at L5019 (def), L6181, L6183. PASS (expected — function survives).
- **`currentEpicWorktrees` survival grep**: 5 matches at L3780, L5361, L6127, L6128, L9127. PASS.
- **`.wt-chip` survival / `.create-wt-chip` removal grep**: 1 match (the read-only span at L5363), 0 `.create-wt-chip` matches. PASS.
- **Backend invariant** (`_refreshBoard` before `_sendWorktreeConfig` in `createWorktreeForEpic`): confirmed at `KanbanProvider.ts` L7098-L7099, both awaited in order. PASS.
- **`notifyStateChanged` consumer trace**: no reader of `_focusedWorktreePath`; removal safe. PASS.
- **Compilation (`npm run compile`)**: SKIPPED per session directives (user runs separately).
- **Automated tests**: SKIPPED per session directives (user runs separately).

### Remaining Risks

1. **Manual UX verification still required** (per Verification Plan §1-§6): focus is gone, chip is non-interactive, single-epic creation works end-to-end, dispatch routing intact, no theme regressions. These are runtime behaviors not exhaustively provable by static grep.
2. **`--border-color` fallback** (NIT, deferred) — borderless select in a hypothetical custom theme that omits the variable.
3. **Unescaped branch name in chip `title`** (NIT, deferred, pre-existing) — theoretical title-attribute break if a branch name contains `"`.
4. **User-run build + tests** — `npm run compile` and the test suite must be run by the user (skipped in this session per directives).
