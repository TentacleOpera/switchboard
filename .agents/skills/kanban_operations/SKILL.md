> ⚠️ **MANUAL FALLBACK ONLY** — The `move-card.js` script is an override/recovery mechanism. Do NOT run it automatically during standard workflow routing. Use it ONLY when the user has explicitly requested a card move. The `get-state.js` script is read-only and may be used freely.

# Kanban Operations

Move cards and query kanban state by running the provided scripts.

## Resolving Plan IDs (do this FIRST — offline, no script)

Every op below is keyed on a **`planId`** (a UUID), but you should not need UUIDs for most ops. Resolve a plan the cheap way when needed, or use the path/slug-addressed APIs below so the server resolves it:

- **Per-column index (fastest, offline):** `.switchboard/kanban-state-<column>.md`. Every plan line ends with `<!-- planId:<uuid> … -->`; subtasks also carry `subtask-of:"<feature>"` and feature cards carry `feature`. One `grep` gives you the ID **and** its feature membership:
  ```bash
  grep -i "my-plan-slug-or-title" .switchboard/kanban-state-*.md
  #  → …plans/my-plan.md](…) — My Plan Title <!-- planId:eb75281d-… subtask-of:"Some Feature" -->
  ```
  Columns: `created`, `backlog`, `plan-reviewed`, `lead-coded`, `coder-coded`, `intern-coded`, `code-reviewed`, `acceptance-tested`, `coded`, `completed`, plus custom columns.
- **Whole board via CLI (clean JSON):** `switchboard api GET /kanban/board` → `{ success, data: [{ planId, planFile, kanbanColumn, isFeature, featureId, … }] }`.

> **The real fix is to not need IDs at all:** the path/slug-addressed feature API (`POST /kanban/features/reconcile`, Feature A · A3 — **landed**) lets you reference plans by file path or slug and reconcile the whole feature structure in one idempotent call. Use it (see "Reorganize Features" below) instead of the per-verb UUID choreography. The two lookups above remain useful for one-off card moves.

## Move a Card

```bash
node .agents/skills/kanban_operations/move-card.js <session_or_plan_file> <target_column>
```

**Examples:**
```bash
node .agents/skills/kanban_operations/move-card.js sess_1777206335666 CODER_CODED
node .agents/skills/kanban_operations/move-card.js .switchboard/plans/my-plan.md CODER_CODED
node .agents/skills/kanban_operations/move-card.js my-plan.md CODER_CODED
```

- `<session_or_plan_file>` can be a legacy `session_id`, or a **plan file path** (relative or absolute), or a plan basename. The script resolves it to the DB `planId`.

**Valid columns:** Sourced from `VALID_KANBAN_COLUMNS` export in `KanbanDatabase.ts`. Includes all built-in columns (CREATED, BACKLOG, PLAN REVIEWED, CONTEXT GATHERER, INTERN CODED, LEAD CODED, CODER CODED, CODE REVIEWED, ACCEPTANCE TESTED, CODED, COMPLETED) plus any custom agent columns matching the safe-name regex.

### ⚠️ The user names the BOARD LABEL — translate it before you move anything

Those are **storage ids**, not what the board shows and not what the user will say. Translate the
label to the id and proceed. **Never** tell the user their column "doesn't exist" or recite the
storage ids back at them.

| Board label (what the user says) | Column id (what `move-card.js` takes) |
| :--- | :--- |
| **New** | `CREATED` |
| **Backlog** | `BACKLOG` |
| **Planned** | `PLAN REVIEWED` |
| **Dispatch** | `DISPATCH` |
| **Researcher** | `RESEARCHER` |
| **Lead Coder** | `LEAD CODED` |
| **Coder** | `CODER CODED` |
| **Intern** | `INTERN CODED` |
| **Reviewed** | `CODE REVIEWED` |
| **Acceptance Tested** | `ACCEPTANCE TESTED` |
| **Ticket Updater** | `TICKET UPDATER` |
| **Completed** | `COMPLETED` |

**This is a correctness hazard on a write path, not a naming nicety.** Two labels resolve to the
opposite of the obvious guess:

- **"Planned" → `PLAN REVIEWED`.** No column is stored as `PLANNED`.
- **"Reviewed" → `CODE REVIEWED`.** Reading "Reviewed" as `PLAN REVIEWED` moves the card
  **backwards** past every coding column — silently, because both ids are valid and the move
  succeeds.

Confirm the resolved id in your reply when you move a card (*"Moved to Planned (`PLAN REVIEWED`)"*)
so a mis-resolution is visible immediately.

**Custom columns** carry user-chosen labels this table cannot cover. The live mapping is
`GET /kanban/columns` (the full catalogue tagged with `enabled` and `enabledSource` for built-in and custom alike; filter destinations to `enabled !== false`, though a disabled column may still hold historical cards). Code source of truth:
`DEFAULT_KANBAN_COLUMNS` / `DISPLAY_MODE_COLUMNS` in `src/services/agentConfig.ts` — that file wins
over this table.

**Features:** When the card is a feature, all of its subtasks cascade to the same column automatically.

**How it routes (and why it matters for Linear/ClickUp sync):**
The move is routed through the running Switchboard host's local API server (`POST /kanban/move`). The host performs the move, cascades subtasks, and pushes the feature + every subtask status to Linear/ClickUp — keeping external trackers in exact sync. A running host is required; there is no direct-DB write fallback.


## Dispatching Cards & Features

`move-card.js` / `POST /kanban/move` only modify card placement in the database — no terminal boots, no prompt is delivered. The primitive that **advances a card AND boots a terminal AND delivers the role prompt** is `POST /kanban/dispatch`. It is the canonical one-call advance-and-dispatch in both hosted and standalone modes (`POST /kanban/move` is unavailable — 503 — on the standalone host).

```bash
switchboard api POST /kanban/dispatch '{
  "plan": "<planId | plan-file path>",
  "targetColumn": "<optional — omitted|\"auto\" routes by complexity>",
  "workspaceRoot": "<optional — defaults to primary root>",
  "from": "<optional — caller'\''s own terminal name for team routing>"
}'
```

- `plan` — the field name may be `plan`, `planId`, `sessionId` or `planFile` (`_handleKanbanDispatch`, LocalApiServer.ts:1870 reads `body?.plan || body?.planId || body?.sessionId || body?.planFile`), but the **value** is resolved by `getPlanByPlanId` then by plan-file path only — a `sessionId` that differs from its `plan_id` 404s, so pass the planId. It does **not** accept `featureId` — dispatching a feature as a whole is not supported; dispatch each subtask.
- `targetColumn` omitted or `"auto"` → routed by plan complexity through the board's own rule (default bands 1–4 → INTERN CODED, 5–6 → CODER CODED, 7+/unknown → LEAD CODED; custom routing maps + pair-mode bypass honored; decision returned in `routing`). Supply an explicit column only when you want to override.
- `from` — your own terminal name. Supply it and a role dispatch (e.g. CODE REVIEWED → reviewer) is routed to the member of **your** team rather than the first matching terminal on the board. The response echoes `teamRouting` naming the decision, including when it fell back. **Extension host only:** the standalone host does not wire `resolveKanbanDispatch`, so `gate.role` is absent there and team routing short-circuits — `teamRouting` reads `dispatch role unavailable on this host — fell back to workspace-wide` and `from` has no effect.
- **Response:** `{ success, planId, sessionId, topic, role, mode, column, moved, dispatched, dispatchedAgent, dispatchedAt, error?, routing?, teamRouting? }`. `success` means "the card is in the target column AND a dispatch was observed" — never just "the request parsed". A `502` with `moved: true, dispatched: false` means the move persisted but no terminal agent picked up — investigate, do not retry blindly.

**Physical board dispatch vs. database-only move:**
- `POST /kanban/dispatch` — persists the move, fires the column's role prompt, verifies against DB. The execution primitive.
- `move-card.js` / `POST /kanban/move` — modifies placement only, no terminal boot, no prompt delivery. Recovery/manual override.

**Edge cases:**
- A dispatch to a column with no configured role returns a 400 error (not a silent no-op). Do not retry blindly — the column has no role seat configured. This pre-flight is **extension-host only**: the standalone host leaves `resolveKanbanDispatch` unwired, the check is skipped, and a role-less column falls through to the move without the loud 400.
- With no terminal agent registered the call returns `409` before moving anything — the dispatch would have fallen back to the clipboard and nothing would run. Open your agent terminal(s) so they re-register, then retry.
- `POST /kanban/dispatch` does **not** gate on in-flight status — it moves and dispatches unconditionally. If you dispatch a subtask a seat already holds (no `completed_at`), the move persists and a new dispatch is attempted, overwriting the prior seat's context. To avoid a double-dispatch, check `GET /kanban/plan?planId=<id>` → `dispatchedAt` and `completedAt` first: if `dispatchedAt` is non-null and `completedAt` is null, the card is in-flight — post `POST /kanban/task/complete` before re-dispatching. (The in-flight 409 refusal is a `POST /kanban/queue/next` behavior, not a dispatch behavior — see section 4's queue/next row.)
- See `.agents/skills/switchboard-orchestration/SKILL.md` section 4 for the full HTTP surface authority, including the `from` team-routing contract and the `routing`/`teamRouting` response fields.

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
node .agents/skills/kanban_operations/assign-to-feature.js <feature> <plan_or_plan_ids_json> [workspace_root]
```

**Examples:**
```bash
# Add a single plan by path (no UUID)
node .agents/skills/kanban_operations/assign-to-feature.js "Agent skills improvements" .switchboard/plans/my-plan.md /Users/me/repo

# Add a single plan by slug
node .agents/skills/kanban_operations/assign-to-feature.js "Agent skills improvements" my-plan-slug

# Add a batch by UUIDs (legacy shape still works)
node .agents/skills/kanban_operations/assign-to-feature.js <featurePlanId-from-create> '["e5f6-..."]' /Users/me/repo
```

- `<feature>` can be a feature `planId`, a feature file path, or a feature name/slug.
- `<plan_or_plan_ids_json>` is either a single plan ref (file path, slug, or `planId`) or a JSON array of plan refs.
- Output: `{"ok":true,"assigned":["..."],"skipped":["..."]}`. A plan already on another feature (or that is itself a feature / missing) is reported in `skipped` and left untouched — it does not abort the batch.
- Same constraints as `create-feature.js`: requires the running extension (no direct-DB fallback). Feature assignment syncs the newly assigned subtasks as children of the feature's external issue/task IF real-time sync is enabled.
- **⚠ Cross-column warning:** If the plan being assigned is in a different kanban column than the feature (e.g. the plan is in CREATED but the feature is in PLAN REVIEWED), the agent MUST warn the user:
  - The plan will NOT go through PLAN REVIEW if the feature is dragged to a coder column — it will skip straight to coding.
  - **To fix:** after assignment, select the feature card on the kanban board and press the **Replan** button (the re-plan icon in the PLAN REVIEWED column header). This sends the CREATED subtasks to the planner for `improve-plan` refinement.
  - Only once all subtasks are in PLAN REVIEWED should the feature be dragged to a coder column.
  - The agent should also add a **⚠ Cross-Column Review Note** section to the feature file (see `group-into-features/SKILL.md` for the template).

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
2. **Propose** — in a SINGLE chat message, propose every grouping at once, listing each member plan with its `planId` and current kanban column. Leave standalone plans ungrouped. **Flag any cross-column groupings** (plans from different columns in the same feature) with a ⚠ CROSS-COLUMN warning — see `group-into-features/SKILL.md` for the warning text and replan-button guidance. Then stop.
3. **Confirm** — wait for the user's one approval (or edits). Create nothing before approval.
4. **Execute** — run `create-feature.js` once per approved group, no further confirmation. Use `assign-to-feature.js` to add more plans later. For any cross-column feature, write the **⚠ Cross-Column Review Note** into the feature file (see `group-into-features/SKILL.md` for the template).

## Get Kanban State

```bash
node .agents/skills/kanban_operations/get-state.js <workspace_root>
```

**Example:**
```bash
node .agents/skills/kanban_operations/get-state.js /Users/me/repo
node .agents/skills/kanban_operations/get-state.js /Users/me/repo | jq '.columns["CREATED"] | length'
```

Outputs parseable JSON on stdout with columns as keys and arrays of plans as values. Diagnostic logs are routed to stderr, so piping to `jq` works.

## Usage with Explicit Workspace

When running from a different directory than the target workspace:

```bash
# Get state from specific workspace
node .agents/skills/kanban_operations/get-state.js /Users/patrickvuleta/Documents/Gitlab

# Move card in specific workspace
node .agents/skills/kanban_operations/move-card.js <session_id> <column> "" /Users/patrickvuleta/Documents/Gitlab
```

## Reorganize Features (declarative — preferred over the per-verb scripts)

`reconcile-features.js` converges the whole feature structure to a desired end state in **one idempotent call**. Plans are addressed by **file path / slug / topic / planId** — never a raw UUID the agent must discover. New plans can be defined inline (`{slug,title,body}`) and reconcile writes + imports + links them. Re-running the same input is a no-op, so retry is safe.

```bash
node .agents/skills/kanban_operations/reconcile-features.js <workspace_root> '<reconcile_json>'
```

`reconcile_json`:
```json
{
  "removeUnmentionedFeatures": false,
  "features": [
    {
      "name": "My Feature",
      "description": "optional feature description",
      "subtasks": [
        ".switchboard/plans/my-plan.md",
        "my-plan-slug",
        "eb75281d-...",
        { "slug": "new-plan", "title": "New Plan", "body": "## Goal\n..." }
      ]
    }
  ]
}
```

- **Create a feature:** list it with its subtasks — the feature is created if no active feature has that name.
- **Add subtasks to an existing feature:** include the existing feature name + the full desired subtask set — new entries are assigned, the rest are left in place.
- **Self-linking via file frontmatter:** a plan file can carry `**Feature:** <feature-plan-id>` or `**Feature:** <feature-name>`. The watcher links it to the feature on import (apply-if-empty — it never overwrites an existing link).
- **Remove a subtask from a feature:** omit it from the desired subtask set — it's detached (not tombstoned).
- **Delete unmentioned features:** set `"removeUnmentionedFeatures": true` — every active feature NOT named in the input is deleted (subtasks detached, not tombstoned). Default `false` (safe — never deletes by accident).
- **Inline new plan:** a subtask entry of the form `{slug,title,body}` writes a new plan file, imports it, and links it in one step.
- **Cross-column warning:** assigning a `CREATED` plan to a feature in a later column produces a `warnings[]` entry (not a failure).

Output: `{ ok, features: [{name, featurePlanId, subtasks:[{planId,planFile,topic}]}], mutations: [{action,detail}], warnings: [] }`.

The equivalent HTTP endpoint (for non-shell hosts) is `POST /kanban/features/reconcile` (or `switchboard api POST /kanban/features/reconcile`).

> **Single-add endpoint:** `POST /kanban/features/assign` with `{ feature, plan }` (or `{ feature, plans }` for a batch) is the additive, path/slug-addressed primitive. It resolves both operands server-side and never detaches existing subtasks — use it for "add one plan" instead of the converge-to-set `reconcile` or UUID-only `assignToFeature`.
>
> **`get-state.js | jq` now works:** all diagnostic logging is routed to stderr, so `node get-state.js <root> | jq .` emits parseable JSON on stdout.

