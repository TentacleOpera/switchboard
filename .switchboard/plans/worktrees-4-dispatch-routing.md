# Worktrees Part 4: Dispatch Routing + Sub-bar Indicator

## Goal

Route dispatch calls to the terminal in the correct worktree when a plan belongs to an epic that has a linked worktree. Add a sub-bar worktree indicator in the kanban board that shows the currently focused worktree and updates when epic focus mode is active. Update `implementation.html` dispatch readiness to surface worktree awareness.

## Dependencies

**Requires Parts 1, 2, and 3 complete.** This plan depends on:
- Part 1: Worktree creation creates terminals with `worktreePath` stored in terminal state
- Part 2: `worktrees` table with `epic_id` foreign key; `db.getWorktrees()`
- Part 3: `focusWorktree` message protocol and `epicWorktrees` data in board payload

## Problem Analysis

### Dispatch Routing: Terminal Selection for Worktree Plans
When a plan is dispatched (`sendPlanToAgent` / `_computeDispatchReadiness`), the system currently picks the terminal by agent role only. If the plan belongs to an epic that has a linked worktree, and there is a terminal with `worktreePath` matching that worktree, the system should prefer that terminal.

`findTerminalNameByWorktreePath` already exists at `TaskViewerProvider.ts:6306` — it finds a terminal by its stored `worktreePath`. The dispatch chain needs to call it when `plan.epic_id` maps to a worktree.

The `BatchPromptPlan` interface in `agentPromptBuilder.ts` already has `worktreePath?: string` — this is what tells the prompt builder to inject worktree path directives. Part 4 adds `epicId?: number` to this interface so the dispatch system can look up the worktree.

### Sub-bar Worktree Indicator
The `kanban-sub-bar` div (kanban.html:2250) already hosts automation timers and status messages. A small worktree chip should be added to this bar showing the currently active/focused worktree path (branch name only). It:
- Shows nothing when no worktree is focused (default state)
- Updates when `enterEpicFocusMode` is called (Part 3 sets `currentFocusedEpicWorktreePath`)
- Updates when a worktree is explicitly selected from the Worktrees tab

### `implementation.html` Dispatch Readiness
The implementation panel shows dispatch readiness status per agent role. When a plan is in an epic with a linked worktree, the readiness display should note which terminal will be used (the worktree terminal vs the default terminal). This is a display-only change — no dispatch logic lives in `implementation.html`.

## Metadata

**Tags:** backend, frontend, dispatch
**Complexity:** 7

## User Review Required

None.

## Complexity Audit

### Routine
- Sub-bar indicator HTML/JS (reads `currentFocusedEpicWorktreePath`)
- `epicId` field on `BatchPromptPlan` interface
- `focusWorktree` handler in KanbanProvider.ts
- Dispatch readiness note in `implementation.html`

### Complex / Risky
- **`_computeDispatchReadiness` modification**: This function maps roles to terminals and is on the dispatch critical path. Changes here can break dispatching for all plans. Worktree routing must be additive — if no matching worktree terminal is found, fall back to default role-based selection.
- **`BatchPromptPlan.epicId` lookup timing**: The epicId → worktreePath lookup must happen at dispatch time (not at plan creation time) because worktrees may be created/abandoned between when a plan is created and when it's dispatched.

## Edge-Case & Dependency Audit

### No Worktree Terminal Found
If `findTerminalNameByWorktreePath` returns null (the worktree terminal was closed or never created), dispatch falls back to the default terminal for the role. No error — just a best-effort routing.

### Multiple Terminals for Same Worktree
If multiple terminals have the same `worktreePath`, `findTerminalNameByWorktreePath` returns the first match. This is acceptable.

### Plan Has epicId but Epic Has No Worktree
`db.getWorktrees().find(w => w.epic_id === epicId && w.status === 'active')` returns undefined → routing falls back to default terminal. No error.

### Sub-bar Indicator When No Control Plane
If no control plane is set, no worktrees exist, indicator stays hidden. The indicator only renders when `currentFocusedEpicWorktreePath` is non-null.

## Proposed Changes

### Phase 8: Dispatch Routing — Epic → Worktree Terminal Preference

**Files: `src/services/TaskViewerProvider.ts`, `src/services/agentPromptBuilder.ts`, `src/services/KanbanProvider.ts`**

**Context**: `_computeDispatchReadiness` at `TaskViewerProvider.ts` maps roles to terminal names. `findTerminalNameByWorktreePath` at line 6306 finds a terminal by `worktreePath`. `BatchPromptPlan` interface at `agentPromptBuilder.ts:12` already has `worktreePath?` field.

**Change — `BatchPromptPlan` interface in `agentPromptBuilder.ts`**: Add `epicId` field:

```typescript
export interface BatchPromptPlan {
    topic: string;
    absolutePath: string;
    complexity?: string;
    workingDir?: string;
    sessionId?: string;
    worktreePath?: string;
    epicId?: number;          // ← add this
    isSubtask?: boolean;
    epicTopic?: string;
}
```

**Change — `_computeDispatchReadiness` in `TaskViewerProvider.ts`**: When a `BatchPromptPlan` has `epicId` set, look up the linked worktree and prefer its terminal:

```typescript
// Inside _computeDispatchReadiness, before the role→terminal mapping:
if (plan.epicId) {
    const db = this._kanbanProvider?.getKanbanDbForRoot(plan.workingDir ?? plan.absolutePath);
    if (db) {
        const linkedWorktree = db.getWorktrees().find(w => w.epic_id === plan.epicId && w.status === 'active');
        if (linkedWorktree) {
            plan.worktreePath = linkedWorktree.path;
        }
    }
}
```

Then in the role→terminal mapping, after finding the default terminal name for the role:

```typescript
// Prefer worktree terminal if plan is worktree-routed
if (plan.worktreePath) {
    const wtTerminal = this.findTerminalNameByWorktreePath(plan.worktreePath);
    if (wtTerminal) {
        roleAssignments[role] = wtTerminal;  // override default
        continue;
    }
    // Fall through to default if no worktree terminal found
}
```

**Change — `sendPlanToAgent` in `KanbanProvider.ts`**: When building the `BatchPromptPlan` for a dispatched plan, include `epicId` from the plan's DB row:

```typescript
const batchPlan: BatchPromptPlan = {
    topic: plan.topic,
    absolutePath: plan.absolutePath,
    complexity: plan.complexity,
    workingDir: workspaceRoot,
    sessionId: plan.sessionId,
    epicId: plan.epic_id ?? undefined,  // ← add this
};
```

**Verification**: Plan in epic with linked worktree + worktree terminal open → dispatch routes to worktree terminal. Plan in epic with no worktree → dispatch routes to default terminal. Plan not in any epic → dispatch routes to default terminal. Worktree terminal closed → dispatch falls back to default terminal (no error).

---

### Phase 9: Sub-bar Worktree Indicator

**Files: `src/webview/kanban.html`**

**Context**: `kanban-sub-bar` div at line 2250 hosts the automation timers and status area. The indicator is a small chip showing the current worktree branch. It sits on the right side of the sub-bar.

**Change — `kanban.html`**: Add indicator container to `kanban-sub-bar`:

```html
<div id="kanban-sub-bar" class="kanban-sub-bar">
    <!-- existing automation timers and status -->
    <div id="wt-indicator" style="display:none; margin-left:auto; align-items:center; gap:4px; font-size:10px; color:var(--text-secondary);">
        <span style="opacity:0.6;">⎇</span>
        <span id="wt-indicator-branch" style="font-family:monospace;"></span>
    </div>
</div>
```

**`updateWorktreeIndicator(worktreePath)` function**:

```javascript
function updateWorktreeIndicator(worktreePath) {
    const el = document.getElementById('wt-indicator');
    const branchEl = document.getElementById('wt-indicator-branch');
    if (!el || !branchEl) return;
    if (!worktreePath) {
        el.style.display = 'none';
        return;
    }
    // Extract branch name from path (last path segment)
    const branch = worktreePath.split(/[\\/]/).pop() ?? worktreePath;
    branchEl.textContent = branch;
    el.style.display = 'flex';
}
```

**Call sites**:
- In `enterEpicFocusMode(epicId)` (Part 3): call `updateWorktreeIndicator(currentFocusedEpicWorktreePath)` after setting the variable.
- In `clearEpicFocusMode()` (Part 3): call `updateWorktreeIndicator(null)`.
- On `worktreeConfig` message: if exactly one active worktree exists and no epic focus is active, call `updateWorktreeIndicator(worktrees[0].path)`.

**Verification**: No worktrees → indicator hidden. One worktree created → indicator shows branch name. Enter epic focus → indicator switches to that epic's worktree. Clear focus → indicator reverts (or hides if >1 worktree and none focused).

---

### Phase 10: `implementation.html` Dispatch Readiness Awareness

**Files: `src/webview/implementation.html`** (or the provider serving it)

**Context**: The implementation panel shows which terminal is assigned to each agent role for the current plan. When a plan is worktree-routed, the readiness display should note the worktree terminal name alongside the role.

**Change — dispatch readiness payload in `KanbanProvider.ts`**: When sending dispatch readiness data, include `worktreeTerminalName` in the per-role entry if the plan is routed to a worktree terminal:

```typescript
// In _computeDispatchReadiness, after resolving role → terminal:
readiness[role] = {
    terminalName,
    isWorktreeTerminal: !!plan.worktreePath && terminalName === findTerminalNameByWorktreePath(plan.worktreePath),
};
```

**Change — `implementation.html`**: In the dispatch readiness table, add a small "(worktree)" label next to the terminal name when `isWorktreeTerminal` is true:

```html
<td>${r.terminalName}${r.isWorktreeTerminal ? ' <span style="font-size:9px; opacity:0.6;">(worktree)</span>' : ''}</td>
```

**Verification**: Open implementation panel for a plan in a worktree-linked epic → terminal name shows "(worktree)" badge. Plan not in epic → no badge. Worktree terminal closed → no badge (falls back to default terminal).

---

## Files Changed

- `src/services/agentPromptBuilder.ts` — Add `epicId` to `BatchPromptPlan` interface
- `src/services/TaskViewerProvider.ts` — Worktree-aware routing in `_computeDispatchReadiness`, expose `findTerminalNameByWorktreePath` if needed
- `src/services/KanbanProvider.ts` — Pass `epicId` in `BatchPromptPlan` construction, `focusWorktree` handler
- `src/webview/kanban.html` — Sub-bar indicator element and `updateWorktreeIndicator` function
- `src/webview/implementation.html` — "(worktree)" badge in dispatch readiness table

## Verification Plan

1. **Worktree routing**: Plan in epic with active worktree + matching terminal → dispatches to worktree terminal.
2. **Fallback routing**: No worktree terminal found → dispatches to default terminal, no error.
3. **Non-epic plan**: No `epicId` → routing unchanged from current behaviour.
4. **Sub-bar indicator**: One worktree active → shows branch. Epic focus active → shows focused epic's branch. No worktrees → hidden.
5. **Implementation panel**: Worktree-routed plan → "(worktree)" badge visible. Standard plan → no badge.

## Risks

- **`_computeDispatchReadiness` breakage**: This is the most critical function in the dispatch path. The worktree routing must be strictly additive with a fallback. If the worktree lookup throws (DB not ready, etc.), catch and fall through to default routing — never let a worktree lookup failure block dispatch.
- **`getKanbanDbForRoot` API**: Check whether this method exists on `KanbanProvider` or needs to be added. If it doesn't exist, the dispatch worktree lookup must happen in `KanbanProvider` before building the `BatchPromptPlan`, not inside `TaskViewerProvider`.

## Recommendation

**Complexity: 7 → Send to Lead Coder**

The dispatch path change is the riskiest part — `_computeDispatchReadiness` must not break existing dispatch for the ~4000 existing users. The additive-with-fallback pattern is mandatory. All other changes in this plan are display-only.
