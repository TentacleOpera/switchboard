---
name: Kanban Operations
description: Move kanban cards and query kanban state via direct database access.
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
