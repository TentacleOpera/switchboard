# Decouple Epic Focus From Worktrees & Consolidate Worktree Creation Into the Worktrees Tab

## Goal

Make "focus on an epic" a first-class, always-available board view, independent of git worktrees. Today the only way to focus an epic (filter the board to that epic's subtasks) is to click its **worktree chip** — which only exists once the epic has a linked worktree. So a pure view operation is gated behind git plumbing, and worktree creation has leaked onto the epic card. Untangle the three concerns that are currently fused onto one tiny card control: **focus** (view), **worktree creation** (a Worktrees-tab job), and the **branch label**.

### Problem Analysis & Root Cause

- **Focus is welded to the worktree chip.** `src/webview/kanban.html` ~L5359-L5367: an epic card renders either a `.wt-chip` (when `currentEpicWorktrees[card.planId]` exists) or a `.create-wt-chip` `⎇` button (when it doesn't). The only trigger for `enterEpicFocusMode(epicId)` is clicking the `.wt-chip` (~L9301-L9307). No worktree → no chip → no way to focus.

- **The focus function doesn't actually need a worktree.** `enterEpicFocusMode` (~L4992-L5002) already degrades gracefully: `currentEpicWorktrees[epicId]` is simply `undefined` with no worktree, so it focuses the view and posts a null worktree path. Only the *entry point* is gated.

- **The "focus the worktree" signal is inert.** Clicking the chip posts `focusWorktree` → backend stores `_focusedWorktreePath` (`KanbanProvider.ts` L152, set at ~L7112) — and **nothing ever reads it** (confirmed: no readers in `src/` outside the declaration/assignment). So the worktree half of the chip-click only updates a label/indicator; it has no functional effect.

- **Worktree execution routing is independent of focus.** Agents run inside an epic's worktree because a dispatched subtask carries `epic_id`, which resolves to the worktree path at dispatch time via `TaskViewerProvider.resolveWorktreePathForPlan(...)` (~L2861) and routes to a terminal in that worktree (`findTerminalNameByWorktreePath`, ~L1764). This happens whether or not the chip was ever clicked.

- **Worktree creation is duplicated/misplaced.** The Worktrees tab (`kanban.html` ~L9011-L9076) creates: a **project** worktree, **all epics** in bulk, and an **unbound** worktree — but has **no single-epic** option. The card's `⎇` button (`createWorktreeForEpic`) is the only per-epic creation path, which is why creation leaked onto the card.

### Conclusion

Focus is a pure view and should live on the epic itself. The chip should be a read-only branch label. Per-epic worktree creation belongs in the Worktrees tab next to the existing creation actions. Dispatch routing by `epic_id` is untouched.

## Metadata

- **Tags:** `ux`, `kanban`, `epics`, `worktrees`, `frontend`, `refactor`
- **Complexity:** 5/10

## Complexity Audit

Moderate, frontend-weighted. No dispatch/DB behavior changes — execution routing stays on `epic_id`. Risk areas: (a) ensuring focus is discoverable and toggles cleanly without a worktree, (b) the Worktrees tab gaining a per-epic picker that reuses the existing `createWorktreeForEpic` message, (c) not regressing worktree users who currently focus via the chip.

## Edge-Case & Dependency Audit

- **Depends on** `kanban-epic-subtask-column-leak-and-backlog-cascade.md` §3 (focus-aware column buttons). Making focus always-available means more users will enter focus mode and click Advance All there; column ops must already target the focused epic's subtasks, not no-op.
- **Toggle semantics:** clicking the focus control on the already-focused epic should clear focus (mirror `clearEpicFocusMode`). Clicking a different epic's focus while focused should switch focus.
- **Worktree users (chip present):** preserve their muscle memory — clicking the chip can still focus (focus + show branch indicator), or we route all focus through the badge and make the chip a non-interactive label. Decide one (recommendation below) and be consistent.
- **Focus indicator:** the `wt-indicator` badge currently surfaces the focused worktree branch. With worktree-less focus, either hide it (no branch) or repurpose the focus banner (`renderFocusBanner`, ~L5013) as the single "you are focused on <epic>" affordance — the banner already exists and has an exit control.
- **Per-epic creation in tab:** needs the epic list (topic + planId) available to the Worktrees panel. The board already has `currentCards`; epics are `card.isEpic`. Reuse for the dropdown. Disable the option for epics that already have a worktree (show branch instead).
- **No backend message changes required** for creation — `createWorktreeForEpic` already exists and is handled (`KanbanProvider.ts` ~L6947). The tab just needs to send it with the selected epic's `planId`/`topic`/`workspaceRoot`.
- **`_focusedWorktreePath` cleanup:** since it's write-only and inert, either remove it and the `focusWorktree` round-trip, or leave it as a harmless no-op. Removing reduces confusion; low risk. Treat as optional sub-task.

## Proposed Changes

### 1. Focus toggle on the epic badge — `src/webview/kanban.html`

Make the `EPIC · N subtasks` badge (~L5355) the focus toggle (add `cursor:pointer`, a `data-epic-id`, and a delegated click handler that calls `enterEpicFocusMode` / `clearEpicFocusMode`). Available on every epic regardless of worktree. The existing focus banner (`renderFocusBanner`) remains the exit affordance.

### 2. Demote the worktree chip to a read-only label — `src/webview/kanban.html`

When a worktree exists, keep rendering the branch chip but remove its focus click behavior (it becomes a label, `title="Worktree: <branch>"`). Remove the `.create-wt-chip` `⎇` button from the card entirely (creation moves to the tab, §3).

### 3. Per-epic worktree creation in the Worktrees tab — `src/webview/kanban.html`

In `createWorktreesPanel` (~L8888), add a "Create Worktree for Epic" form: an epic dropdown (from `currentCards.filter(c => c.isEpic)`, excluding epics that already have a worktree) + a button posting:
```js
postKanbanMessage({ type: 'createWorktreeForEpic', epicId, epicTopic, workspaceRoot: currentWorkspaceRoot });
```
Place it beside "Create Worktrees for All Epics". No backend change.

### 4. (Optional) Remove the inert focus→worktree signal — `kanban.html` + `KanbanProvider.ts`

Drop the `focusWorktree` post from `enterEpicFocusMode`/`clearEpicFocusMode` and the write-only `_focusedWorktreePath` field/handler, since nothing reads it. Keep `updateWorktreeIndicator` only if it still serves a purpose for worktree-linked epics; otherwise fold its role into the focus banner.

## Verification Plan

1. **Build:** `npm run compile`.
2. **Manual (installed VSIX):**
   - Epic with **no** worktree: click its badge → board filters to that epic's subtasks, focus banner shows; click again (or banner exit) → unfocus. (Previously impossible.)
   - Epic with a worktree: chip shows the branch as a label (no longer triggers focus); focus still via the badge.
   - Worktrees tab: select an epic in the new dropdown → worktree created and linked; the epic's card now shows the branch label; the epic disappears from the dropdown (already has a worktree).
   - Confirm the per-card `⎇` button is gone.
   - Dispatch a subtask of a worktree-linked epic → agent still runs in the epic's worktree (routing via `epic_id` unchanged).
3. **Regression:** focus-mode Advance All advances the focused epic's subtasks (relies on the column-leak plan §3).

## Status

All steps **pending**. Sequenced after `kanban-epic-subtask-column-leak-and-backlog-cascade.md`.

> Open decisions for the author before build:
> - Chip on worktree epics: pure label (recommended) vs. still-clickable-for-focus.
> - Whether to do §4 (remove inert `_focusedWorktreePath`) now or leave as harmless.
