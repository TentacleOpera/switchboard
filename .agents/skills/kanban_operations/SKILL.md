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

**Features:** When the card is a feature, all of its subtasks cascade to the same column automatically.

**How it routes (and why it matters for Linear/ClickUp sync):**
1. **Preferred** — if the Switchboard extension is running, the move is routed through its local API server (`POST /kanban/move`). The extension performs the move, so it cascades subtasks **and** pushes the feature + every subtask status to Linear/ClickUp — keeping external trackers in exact sync. When the extension is reachable it is authoritative: a refused move (e.g. an invalid transition) fails rather than silently falling back.
2. **Fallback** — if no extension/API server is reachable, the script writes the kanban DB directly. Subtasks still cascade, but there is **no Linear/ClickUp sync** (the integration token lives in VS Code secret storage, unreachable from a standalone process). If real-time sync is enabled, a direct-DB change may be reconciled away on the next inbound poll. Use the fallback for recovery only.

## Create a Feature

```bash
node .agents/skills/kanban_operations/create-feature.js <feature_name> <plan_ids_json> [workspace_root] [description]
```

**Example:**
```bash
node .agents/skills/kanban_operations/create-feature.js "Onboarding revamp" '["a1b2-...","c3d4-..."]' /Users/me/repo
```

- `plan_ids_json` is a JSON array of **`planId`** values (the `planId` field from `get-state.js` output) — NOT `sessionId`. File-watcher-imported plans have an empty `session_id`, so `planId` is the only reliable key.
- Output (stdout): `{"ok":true,"featurePlanId":"...","featureSessionId":"..."}` on success, or `{"ok":false,"error":"..."}` on failure. Exit code 0/1 matches.
- The feature inherits its project/column from the subtasks and appears on the board immediately.
- **External sync:** feature creation and assignment sync the feature as a parent issue (Linear) or parent task (ClickUp) and link subtasks as children, IF real-time sync is enabled for that tracker. Subtasks without an existing external issue/task are skipped — they will be linked on a future feature-sync trigger once their individual sync creates an external issue. Sync is best-effort: failures are logged but do not roll back the local feature creation.
- **Requires the running extension** — there is no direct-DB fallback (unlike `move-card.js`). Feature creation spans project inheritance, column resolution, a file write, and subtask linking; replicating that in raw DB calls would risk an orphaned feature. If the extension isn't reachable the script fails with a clear message.

## Assign Plans to a Feature

```bash
node .agents/skills/kanban_operations/assign-to-feature.js <feature_plan_id> <plan_ids_json> [workspace_root]
```

**Example:**
```bash
node .agents/skills/kanban_operations/assign-to-feature.js <featurePlanId-from-create> '["e5f6-..."]' /Users/me/repo
```

- `feature_plan_id` is the `featurePlanId` returned by `create-feature.js`. `plan_ids_json` is a JSON array of `planId` values to add.
- Output: `{"ok":true,"assigned":["..."],"skipped":["..."]}`. A plan already on another feature (or that is itself a feature / missing) is reported in `skipped` and left untouched — it does not abort the batch.
- Same constraints as `create-feature.js`: requires the running extension (no direct-DB fallback). Feature assignment syncs the newly assigned subtasks as children of the feature's external issue/task IF real-time sync is enabled.

## Remove a Subtask from a Feature

```bash
node .agents/skills/kanban_operations/remove-from-feature.js <subtask_plan_id> [workspace_root]
```

**Example:**
```bash
node .agents/skills/kanban_operations/remove-from-feature.js "e5f6-..." /Users/me/repo
```

- `subtask_plan_id` is the `planId` of the subtask to detach from its parent feature.
- Output: `{"ok":true}` on success, or `{"ok":false,"error":"..."}` on failure.
- Detaches the subtask, abandons its per-subtask worktree, regenerates the feature file, refreshes the board, and unlinks the subtask from external trackers (best-effort).
- **Requires the running extension** — no direct-DB fallback.

## Delete a Feature

```bash
node .agents/skills/kanban_operations/delete-feature.js <feature_plan_id> [delete_subtasks] [workspace_root]
```

**Example:**
```bash
node .agents/skills/kanban_operations/delete-feature.js "a1b2-..." true /Users/me/repo
```

- `feature_plan_id` is the `featurePlanId` of the feature to delete.
- `delete_subtasks`: `true` to tombstone all subtasks, `false` (default) to detach them and leave them on the board.
- Output: `{"ok":true}` on success, or `{"ok":false,"error":"..."}` on failure.
- Abandons all child worktrees, either tombstones or detaches subtasks, tombstones the feature, refreshes the board, and unlinks subtasks from external trackers (best-effort).
- **Requires the running extension** — no direct-DB fallback.

## Split a Feature

```bash
node .agents/skills/kanban_operations/split-feature.js <feature_plan_id> <kept_plan_ids_json> <first_feature_name> <second_feature_name> [workspace_root]
```

**Example:**
```bash
node .agents/skills/kanban_operations/split-feature.js "a1b2-..." '["c3d4-...","e5f6-..."]' "Backend refactor" "Frontend polish" /Users/me/repo
```

- `feature_plan_id` is the `featurePlanId` of the feature to split.
- `kept_plan_ids_json` is a JSON array of `planId` values that go to the **first** new feature. All other subtasks go to the **second** new feature.
- `first_feature_name` and `second_feature_name` are the names for the two new features.
- Output: `{"ok":true,"firstFeaturePlanId":"...","secondFeaturePlanId":"..."}` on success, or `{"ok":false,"error":"..."}` on failure.
- The original feature is deleted (subtasks detached, not tombstoned). Two new features are created with their respective subtask sets.
- **Requires the running extension** — no direct-DB fallback.

## Suggest Features Workflow (scan → propose → confirm → execute)

Triggered by the **SUGGEST FEATURES** board button, which copies a prompt to the clipboard. The agent must follow this flow:

1. **Scan** — read the board with `get-state.js` and look only at pre-coding columns: CREATED, BACKLOG, CONTEXT GATHERER, PLAN REVIEWED. Ignore cards that are already features or already assigned (they carry an `featureId`).
2. **Propose** — in a SINGLE chat message, propose every grouping at once, listing each member plan with its `planId`. Leave standalone plans ungrouped. Then stop.
3. **Confirm** — wait for the user's one approval (or edits). Create nothing before approval.
4. **Execute** — run `create-feature.js` once per approved group, no further confirmation. Use `assign-to-feature.js` to add more plans later.

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
