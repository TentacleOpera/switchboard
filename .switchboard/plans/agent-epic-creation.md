# Plan: Agent Epic Creation & Grouping

## Context

Agents can already move kanban cards (via `kanban_operations/move-card.js`), but they have no way to create epics or assign cards to them. The DB already supports epics (`is_epic`, `epic_id` columns, `updateEpicStatus`, `getSubtasksByEpicId`, etc.) and the webview already has full epic create/assign logic in `KanbanProvider.ts` (`createEpic` message handler). The gap is:

1. Exposing that logic to agents via the skill/API layer
2. Adding a "Suggest Epics" button to the board UI as a third entry point
3. Documenting the workflow so agents follow it consistently (scan → propose → confirm → execute)

---

## What Gets Built

### 1. Two new CLI scripts in `.agents/skills/kanban_operations/`

**`create-epic.js`**
- Args: `<epic_name> <plan_ids_json> [workspace_root] [description]`
- `plan_ids_json` is a JSON array of `plan_id` values (from `get-state.js` output)
- Dual-path like `move-card.js`:
  - Preferred: `POST /kanban/epic` on the running extension's API server → full flow (DB upsert, subtask linking, epic file write, board refresh, Linear/ClickUp sync)
  - Fallback: direct DB write via `KanbanDatabase` (no board refresh, no sync)
- Output: JSON `{ ok, epicPlanId, epicSessionId }`

**`assign-to-epic.js`**
- Args: `<epic_plan_id> <plan_ids_json> [workspace_root]`
- Assigns additional plans to an existing epic
- Same dual-path routing
- Output: JSON `{ ok, assigned, skipped }`

### 2. New API endpoints in `LocalApiServer.ts`

Two new callbacks added to `LocalApiServerOptions`:
- `createEpic?(workspaceRoot, name, planIds, description?)` → `{ success, epicPlanId, epicSessionId, error? }`
- `assignToEpic?(workspaceRoot, epicPlanId, planIds)` → `{ success, assigned, skipped, error? }`

Two new route handlers:
- `POST /kanban/epic` — calls `createEpic` callback
- `POST /kanban/epic/assign` — calls `assignToEpic` callback

### 3. New public methods in `KanbanProvider.ts`

- `createEpicFromPlanIds(workspaceRoot, name, planIds, description?)` — extracts the logic from the existing `createEpic` webview message handler into a callable public method (no duplication of the switch case, just delegation)
- `assignPlansToEpic(workspaceRoot, epicPlanId, planIds)` — assigns plans, regenerates epic file, refreshes board

### 4. Wire callbacks in `TaskViewerProvider.ts`

In `_startLocalApiServer()`, add `createEpic` and `assignToEpic` alongside the existing `moveCard` callback, delegating to the new `KanbanProvider` public methods.

### 5. "Suggest Epics" button in the kanban webview

In `src/webview/kanban.html` / `project.js`:
- Add a "Suggest Epics" button in the board toolbar (near existing column controls)
- Clicking it dispatches an agent prompt that:
  - Reads all cards in CREATED, BACKLOG, CONTEXT GATHERER, PLAN REVIEWED
  - Proposes groupings in chat
  - Waits for user confirmation
  - Calls `create-epic.js` once per approved group

The button message type: `suggestEpics` → handled in `KanbanProvider._handleWebviewMessage`.

### 6. Updated `SKILL.md`

Documents:
- The full epic grouping workflow (scan → propose → confirm → execute)
- `create-epic.js` usage and output
- `assign-to-epic.js` usage and output
- Which `planId` field to use (from `get-state.js` output) vs `sessionId`
- Note that the board updates live when the extension is running

---

## Approval Flow (Agent Behaviour)

1. Agent reads board state via `get-state.js` (all pre-coding columns)
2. Agent analyses topics and proposes groupings **all at once** in a single chat message
3. User gives one approval (or edits the groupings)
4. Agent runs `create-epic.js` once per group — no further confirmation needed
5. Agent optionally runs `assign-to-epic.js` if user wants to add more cards later

This is documented in SKILL.md so the agent follows it consistently, not just ad-hoc.

---

## Critical Files

| File | Change |
|------|--------|
| `src/services/KanbanProvider.ts` | Add `createEpicFromPlanIds()` and `assignPlansToEpic()` public methods; add `suggestEpics` webview message handler |
| `src/services/LocalApiServer.ts` | Add `createEpic`/`assignToEpic` callbacks to options interface; add two route handlers; wire into `_handleRequest` |
| `src/services/TaskViewerProvider.ts` | Wire new callbacks in `_startLocalApiServer()` |
| `src/webview/kanban.html` | Add "Suggest Epics" toolbar button |
| `src/webview/project.js` | Handle `suggestEpics` button click, dispatch agent prompt |
| `.agents/skills/kanban_operations/create-epic.js` | New script |
| `.agents/skills/kanban_operations/assign-to-epic.js` | New script |
| `.agents/skills/kanban_operations/SKILL.md` | Updated docs + workflow |

---

## Key Reuse (do not reinvent)

- `KanbanDatabase.updateEpicStatus()` — already handles DB linking
- `KanbanDatabase.getSubtasksByEpicId()` — already fetches subtasks
- `KanbanProvider._regenerateEpicFile()` — already regenerates the epic markdown
- `KanbanProvider._refreshBoard()` — already triggers webview update
- `move-card.js` — copy its dual-path pattern (API → DB fallback) exactly
- `get-state.js` — agents use this unchanged to read the board before suggesting

---

## Verification

1. Run `get-state.js` against a workspace with cards in CREATED/BACKLOG — confirm output includes `planId` field
2. Run `create-epic.js` with two planIds — confirm epic appears on the kanban board immediately (extension running) and on restart (fallback path)
3. Run `assign-to-epic.js` — confirm the new card appears under the epic in the Epics tab
4. Click "Suggest Epics" button — confirm agent reads the board and proposes groupings in chat before touching anything
5. Approve groupings — confirm epics are created and board updates without further prompts
