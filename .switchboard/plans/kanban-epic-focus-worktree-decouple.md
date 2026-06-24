# Remove On-Board Epic Focus Mode & Consolidate Worktree Creation Into the Worktrees Tab

## Goal

**Remove on-board epic focus mode entirely**, and untangle the worktree creation that has leaked onto the epic card. Focus mode (clicking an epic to filter the board to its subtasks as independently-movable column cards) exists to let subtasks **diverge across stages** — which is the **wrong model**: an epic is a rigid unit whose subtasks always move with it, and the place to inspect or manage an epic's subtasks is the **Epics tab** (see `feature_plan_20260625081837_epics-as-orchestration-onramp.md`). With focus mode gone, the epic-card control that triggered it is repurposed: the worktree chip becomes a read-only branch label, and per-epic worktree creation moves to the Worktrees tab beside the other creation actions.

> **Model shift (supersedes this plan's original intent).** An earlier draft of this plan aimed to make focus mode *first-class and always-available*. That is now **rejected**: subtasks must not diverge across stages, so focus mode has no purpose. This plan instead **deletes** focus mode and keeps only its worktree-cleanup half.

### Problem Analysis & Root Cause

- **Focus mode models subtasks wrong.** `enterEpicFocusMode` (`src/webview/kanban.html` ~L4992-L5002) filters the board to a single epic's subtasks (`displayCards` keeps `cardId === currentFocusedEpicId || card.epicId === currentFocusedEpicId`, ~L5077-L5087) and surfaces per-column Advance-All over them — i.e. it lets subtasks sit in different stages. The decided model is the opposite: subtasks are a rigid unit that never diverge and never render as individual board cards. Focus mode's whole reason to exist is therefore removed.

- **Focus was welded to the worktree chip anyway.** The only trigger for `enterEpicFocusMode` is clicking the `.wt-chip` (~L9301-L9307), which exists only when `currentEpicWorktrees[card.planId]` is set (epic card render ~L5359-L5367). So a pure view operation was gated behind git plumbing — a smell that disappears once focus is deleted.

- **The "focus the worktree" signal is inert.** Clicking the chip posts `focusWorktree` → backend stores `_focusedWorktreePath` (`KanbanProvider.ts` L152, set ~L7112) and **nothing reads it** (no readers in `src/` outside declaration/assignment). Dead code to remove with focus mode.

- **Worktree execution routing is independent of focus.** Agents run inside an epic's worktree because a dispatched subtask carries `epic_id`, resolved to the worktree path at dispatch time via `TaskViewerProvider.resolveWorktreePathForPlan(...)` (~L2861) → `findTerminalNameByWorktreePath` (~L1764). This is unaffected by removing focus mode.

- **Worktree creation is duplicated/misplaced.** The Worktrees tab (`kanban.html` ~L9011-L9076) creates a **project** worktree, **all epics** in bulk, and an **unbound** worktree — but has **no single-epic** option. The card's `⎇` `.create-wt-chip` button (`createWorktreeForEpic`) is the only per-epic path, which is why creation leaked onto the card.

### Conclusion

Delete focus mode (the Epics tab is the inspection surface). Demote the worktree chip to a read-only branch label and remove the per-card `⎇` creation button. Add a single-epic worktree creation option to the Worktrees tab. Dispatch routing by `epic_id` is untouched.

## Metadata

- **Tags:** `ux`, `kanban`, `epics`, `worktrees`, `frontend`, `refactor`
- **Complexity:** 4/10 (down from 5 — deleting focus is simpler than generalizing it)

## Complexity Audit

Routine, frontend-weighted. No dispatch/DB behavior changes — execution routing stays on `epic_id`. The focus deletion is a clean removal across one hot webview (`kanban.html`); the only genuinely new UI is a single-epic picker in the Worktrees tab that reuses the existing `createWorktreeForEpic` message. Risk: leaving a dangling reference to a deleted focus symbol, or breaking the main board render / drag-drop when the focus-conditional branches are removed.

## Edge-Case & Dependency Audit

- **Depends on** `kanban-epic-subtask-column-leak-and-backlog-cascade.md` §1 — the `!card.epicId` subtask exclusion. With focus gone, that exclusion becomes **unconditional** (the two plans agree on this; whichever lands second makes it unconditional). Subtasks then never appear as board cards.
- **Worktree users lose chip-focus muscle memory** — acceptable: focus is removed for everyone and replaced by the Epics tab. The chip remains visible as a non-interactive branch label so the worktree is still surfaced on the card.
- **No backend message changes for creation** — `createWorktreeForEpic` already exists and is handled (`KanbanProvider.ts` ~L6947). The Worktrees-tab picker just sends it with the selected epic's `planId`/`topic`/`workspaceRoot`.
- **Dangling references** — `currentFocusedEpicId` is read in several render branches (`kanban.html:3738,4993-5087,6152-6184`); every read must be removed or its branch collapsed to the unfocused path. Grep for `currentFocusedEpicId`, `enterEpicFocusMode`, `clearEpicFocusMode`, `renderFocusBanner`, `focusWorktree`, `_focusedWorktreePath` and confirm zero references remain.
- **Per-epic creation needs the epic list** — the Worktrees panel can build its dropdown from `currentCards.filter(c => c.isEpic)`, excluding epics that already have a worktree (show the branch instead).
- **No confirmation dialogs** (project rule).

## Proposed Changes

### 1. Delete on-board focus mode — `src/webview/kanban.html`
- Remove `enterEpicFocusMode` / `clearEpicFocusMode` (~L4992-L5021), `currentFocusedEpicId` (~L3738) and every reference, `renderFocusBanner` (~L5013) and the focus banner element, and the `.wt-chip` click handler that entered focus (~L9301-L9307).
- Make the subtask exclusion **unconditional**: `displayCards = displayCards.filter(card => !card.epicId)` with no `currentFocusedEpicId` branch (~L5077-L5087). (Coordinate with `kanban-epic-subtask-column-leak-and-backlog-cascade.md` §1.)
- Remove focus-conditional render branches (~L6152-L6184), collapsing each to the unfocused behavior.

### 2. Demote the worktree chip to a read-only label — `src/webview/kanban.html`
- Where a worktree exists, keep rendering the branch chip (~L5359-L5367) but remove its click/focus behavior; render it as a label with `title="Worktree: <branch>"`.
- Remove the per-card `.create-wt-chip` `⎇` button entirely (creation moves to the tab, §3).

### 3. Per-epic worktree creation in the Worktrees tab — `src/webview/kanban.html`
- In `createWorktreesPanel` (~L8888), add a "Create Worktree for Epic" form: an epic dropdown (`currentCards.filter(c => c.isEpic)`, excluding epics that already have a worktree) + a button posting:
  ```js
  postKanbanMessage({ type: 'createWorktreeForEpic', epicId, epicTopic, workspaceRoot: currentWorkspaceRoot });
  ```
  Place it beside "Create Worktrees for All Epics". No backend change (`createWorktreeForEpic` handled at `KanbanProvider.ts` ~L6947).

### 4. Remove the inert focus→worktree signal — `kanban.html` + `KanbanProvider.ts`
- Drop the `focusWorktree` post (was in the now-deleted focus entry) and the write-only `_focusedWorktreePath` field/handler (`KanbanProvider.ts` L152, ~L7112), since nothing reads it.

## Verification Plan

1. **Build:** `npm run compile`.
2. **Focus gone:** no way to filter the board to a single epic's subtasks; no focus banner; subtasks never render as individual column cards (epic shows only its count badge). Inspecting an epic's subtasks is done in the **Epics tab** (via the Review button, per `review-epic-opens-kanban-tab-not-epic-tab.md`).
3. **No dangling refs:** grep confirms zero references to `currentFocusedEpicId` / `enterEpicFocusMode` / `clearEpicFocusMode` / `renderFocusBanner` / `focusWorktree` / `_focusedWorktreePath`. Board render and drag-drop not regressed.
4. **Worktree chip is a label:** clicking it does nothing (or shows the branch tooltip); the per-card `⎇` button is gone.
5. **Worktrees tab single-epic creation:** select an epic → worktree created and linked; the epic's card shows the branch label; that epic disappears from the dropdown.
6. **Dispatch routing intact:** dispatch a subtask of a worktree-linked epic → agent still runs in the epic's worktree (routing via `epic_id` unchanged).

## Status

All steps **pending**. Reframed from "make focus first-class" to "remove focus + worktree cleanup" per the decided model. Relates-to: `kanban-epic-subtask-column-leak-and-backlog-cascade.md` (subtask exclusion → unconditional; its §3 dropped) and `feature_plan_20260625081837_epics-as-orchestration-onramp.md` (Epics tab is the epic-inspection + orchestration surface).
