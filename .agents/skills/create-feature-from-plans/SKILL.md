---
name: create-feature-from-plans
description: Create a Switchboard feature from a known set of plans — no discovery, just mechanics. Use when the user already knows which plans to group.
---

# Create Feature from Plans (Direct)

Create a Switchboard feature when the user already knows which plans belong
together. This is the direct path — no board scanning, no clustering, no
proposal step. Just create the feature, verify it, and write the narrative.

## When to Use

- The user says "create a feature from these plans" / "group these into a
  feature" / "make a feature for X containing plans A, B, C"
- The user has just written several related plans and wants them grouped
- The planner persona (switchboard-chat) flagged 3+ related plans and the
  user confirmed they want a feature
- The improve-plan workflow restructured plans into a feature set during
  review and needs to create the feature
- Do NOT use this skill if the user wants you to *discover* groupings from
  the board — use `group-into-features` instead
- Do NOT use this skill if the extension is NOT running — use `create-feature`
  (the remote fallback) instead

## Prerequisites

### 1. Extension must be running

Check for `.switchboard/api-server-port.txt` in the workspace root. If absent,
the extension is not running — fall back to the `create-feature` skill (direct
file write).

### 2. Plans must be in the kanban DB

`create-feature.js` needs `planId` values from the kanban DB `plans` table.
If the plans were just written as files to `.switchboard/plans/`, the
`GlobalPlanWatcherService` will import them within a few seconds.

To check if plans are imported:
```bash
sqlite3 {{WORKSPACE_ROOT}}/.switchboard/kanban.db \
  "SELECT plan_id, topic FROM plans WHERE plan_file LIKE '%{plan-filename}%'"
```

If the query returns no rows, wait 3-5 seconds for the watcher and re-check.
Do NOT proceed until all plan IDs are confirmed in the DB.

### 3. Collect plan IDs

If the user gave plan filenames, resolve them to plan_ids via the SQL query
above. If the user gave plan_ids directly, use those.

## Execution

### Step 1: Create the feature

```bash
node .agents/skills/kanban_operations/create-feature.js \
  "<feature name>" \
  '["planId1","planId2","planId3"]' \
  "<workspace root absolute path>" \
  "<goal description — 2-4 sentences>"
```

The description becomes the `## Goal` section in the feature file.

**Shell escaping:** Escape double quotes (`"` → `\"`). Avoid `$`, backticks, and backslashes — shell metacharacters inside double quotes. Newlines ARE safe and preserved as multi-line Goal content — do not flatten them.

Expected output:
```json
{"ok":true,"featurePlanId":"<uuid>","featureSessionId":"<uuid>"}
```

If `ok: false`, read the `error` field. Common failures:
- Extension not reachable → fall back to `create-feature` skill (the script itself returns ok:false with a clear message; the AGENT then switches skills).
- Zero subtasks linked (silent blank feature) → `create-feature.js` returns `ok: true` even when none of the supplied plan IDs resolve to DB rows (the extension deliberately allows blank features). This is NOT an error. The Prerequisites §2 pre-flight SQL check is the ONLY gate that prevents this. If you skipped it, Step 2 verification will show zero subtasks — recover by deleting the blank feature: `node .agents/skills/kanban_operations/delete-feature.js "<featurePlanId>" "<workspaceRoot>"`, then re-run the pre-flight and retry.

### Step 2: Verify

```bash
sqlite3 {{WORKSPACE_ROOT}}/.switchboard/kanban.db \
  "SELECT plan_id, is_feature, topic FROM plans WHERE plan_id='<featurePlanId>'"
```

Confirm `is_feature=1`. Then verify subtasks are linked:

```bash
sqlite3 {{WORKSPACE_ROOT}}/.switchboard/kanban.db \
  "SELECT plan_id, topic, feature_id FROM plans WHERE feature_id='<featurePlanId>'"
```

All subtask plan IDs should appear with the feature's plan_id in `feature_id`.

### Step 3: Write narrative sections

The feature file is at `.switchboard/features/{slug}-{featurePlanId}.md`.
`create-feature.js` only writes the `## Goal` section. Write the remaining
narrative sections manually:

1. **`## How the Subtasks Achieve This`** — one bullet per subtask plan:
   `- **{Plan Name}**: {what it does and how it contributes to the goal}`

2. **`## Dependencies & sequencing`** — note ordering constraints between
   subtasks. If none, write "No hard ordering constraints; subtasks can be
   executed in parallel."

Insert `## How the Subtasks Achieve This` between the `## Goal` section and
the `<!-- BEGIN SUBTASKS -->` marker. Insert `## Dependencies & sequencing`
immediately after the `<!-- END SUBTASKS -->` marker.

These sections are preserved by `_regenerateFeatureFile` on subsequent
subtask changes, so they only need to be written once.

## Notes

- Feature creation does NOT sync to Linear/ClickUp.
- To add more plans to an existing feature later, use
  `node .agents/skills/kanban_operations/assign-to-feature.js "{featurePlanId}" '["newPlanId"]' "{workspaceRoot}"`
- The `<!-- BEGIN SUBTASKS -->` block is auto-managed by the extension —
  do not edit it manually.
