---
name: kanban-operations
description: Move kanban cards and query kanban state via direct database access.
allowed-tools: Bash
disable-model-invocation: true
---

> ⚠️ **MANUAL FALLBACK ONLY** — The `move-card.js` script is an override/recovery mechanism. Do NOT run it automatically during standard workflow routing. Use it ONLY when the user has explicitly requested a card move. The `get-state.js` script is read-only and may be used freely.

# Kanban Operations

Move cards and query kanban state by running the provided scripts.

## Move a Card

```bash
node .agents/skills/kanban_operations/move-card.js <session_id> <target_column>
```

**Example:**
```bash
node .agents/skills/kanban_operations/move-card.js sess_1777206335666 CODER_CODED
```

**Valid columns:** Sourced from `VALID_KANBAN_COLUMNS` export in `KanbanDatabase.ts`. Includes all built-in columns (CREATED, BACKLOG, PLAN REVIEWED, CONTEXT GATHERER, INTERN CODED, LEAD CODED, CODER CODED, CODE REVIEWED, ACCEPTANCE TESTED, CODED, COMPLETED) plus any custom agent columns matching the safe-name regex.

**Epics:** When the card is an epic, all of its subtasks cascade to the same column automatically.

**How it routes (and why it matters for Linear/ClickUp sync):**
1. **Preferred** — if the Switchboard extension is running, the move is routed through its local API server (`POST /kanban/move`). The extension performs the move, so it cascades subtasks **and** pushes the epic + every subtask status to Linear/ClickUp — keeping external trackers in exact sync. When the extension is reachable it is authoritative: a refused move (e.g. an invalid transition) fails rather than silently falling back.
2. **Fallback** — if no extension/API server is reachable, the script writes the kanban DB directly. Subtasks still cascade, but there is **no Linear/ClickUp sync** (the integration token lives in VS Code secret storage, unreachable from a standalone process). If real-time sync is enabled, a direct-DB change may be reconciled away on the next inbound poll. Use the fallback for recovery only.

## Create an Epic

```bash
node .agents/skills/kanban_operations/create-epic.js <epic_name> <plan_ids_json> [workspace_root] [description]
```

**Example:**
```bash
node .agents/skills/kanban_operations/create-epic.js "Onboarding revamp" '["a1b2-...","c3d4-..."]' /Users/me/repo
```

- `plan_ids_json` is a JSON array of **`planId`** values (the `planId` field from `get-state.js` output) — NOT `sessionId`. File-watcher-imported plans have an empty `session_id`, so `planId` is the only reliable key.
- Output (stdout): `{"ok":true,"epicPlanId":"...","epicSessionId":"..."}` on success, or `{"ok":false,"error":"..."}` on failure. Exit code 0/1 matches.
- The epic inherits its project/column from the subtasks and appears on the board immediately.
- **No external sync:** epic creation updates the Switchboard board and writes a `.switchboard/epics/` file. It does **NOT** sync to Linear/ClickUp.
- **Requires the running extension** — there is no direct-DB fallback (unlike `move-card.js`). Epic creation spans project inheritance, column resolution, a file write, and subtask linking; replicating that in raw DB calls would risk an orphaned epic. If the extension isn't reachable the script fails with a clear message.

## Assign Plans to an Epic

```bash
node .agents/skills/kanban_operations/assign-to-epic.js <epic_plan_id> <plan_ids_json> [workspace_root]
```

**Example:**
```bash
node .agents/skills/kanban_operations/assign-to-epic.js <epicPlanId-from-create> '["e5f6-..."]' /Users/me/repo
```

- `epic_plan_id` is the `epicPlanId` returned by `create-epic.js`. `plan_ids_json` is a JSON array of `planId` values to add.
- Output: `{"ok":true,"assigned":["..."],"skipped":["..."]}`. A plan already on another epic (or that is itself an epic / missing) is reported in `skipped` and left untouched — it does not abort the batch.
- Same constraints as `create-epic.js`: no Linear/ClickUp sync, requires the running extension (no direct-DB fallback).

## Suggest Epics Workflow (scan → propose → confirm → execute)

Triggered by the **SUGGEST EPICS** board button, which copies a prompt to the clipboard. The agent must follow this flow:

1. **Scan** — read the board with `get-state.js` and look only at pre-coding columns: CREATED, BACKLOG, CONTEXT GATHERER, PLAN REVIEWED. Ignore cards that are already epics or already assigned (they carry an `epicId`).
2. **Propose** — in a SINGLE chat message, propose every grouping at once, listing each member plan with its `planId`. Leave standalone plans ungrouped. Then stop.
3. **Confirm** — wait for the user's one approval (or edits). Create nothing before approval.
4. **Execute** — run `create-epic.js` once per approved group, no further confirmation. Use `assign-to-epic.js` to add more plans later.

## Get Kanban State

```bash
node .agents/skills/kanban_operations/get-state.js <workspace_id>
```

**Example:**
```bash
node .agents/skills/kanban_operations/get-state.js my-workspace-123
```

Outputs JSON with columns as keys and arrays of plans as values.

## Usage with Explicit Workspace

When running from a different directory than the target workspace:

```bash
# Get state from specific workspace
node .agents/skills/kanban_operations/get-state.js /Users/patrickvuleta/Documents/Gitlab

# Move card in specific workspace
node .agents/skills/kanban_operations/move-card.js <session_id> <column> "" /Users/patrickvuleta/Documents/Gitlab
```
