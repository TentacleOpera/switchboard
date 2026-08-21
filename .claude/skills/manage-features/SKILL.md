---
name: manage-features
description: Create, group, and rearrange Switchboard features — Create (remote file write), Create from Plans (create-feature.js), Group (scan/cluster/propose), Rearrange (split/move/merge subtasks without rewriting content).
allowed-tools: Bash
---

# Manage Features

Create, group, and rearrange Switchboard features. This skill consolidates four
feature-management operations into one discoverable skill:

- **Create** — write a feature file directly (remote-session fallback when the
  extension is not running).
- **Create from Plans** — create a feature from a known set of plans via
  `create-feature.js` (extension running).
- **Group** — scan pre-coding columns, cluster loose plans by capability, propose
  groupings for one approval, then create features.
- **Rearrange** — restructure a feature's subtasks (split/move/merge/reorder)
  without rewriting their content.

When a directive says "invoke the `manage-features` skill and follow the
Create from Plans section", jump to that section below.

---

## Create

Create a Switchboard feature by writing the feature file directly to
`.switchboard/features/`. Use this section when you are in a **remote session**
(Claude Code web, claude.ai) and the VS Code extension is not running —
`create-feature.js` routes through the extension's LocalApiServer and has no
direct-DB fallback, so it fails when the extension is unreachable.

### When to Use

- You are in a remote session (no VS Code extension running).
- The user asks to create a new feature (grouping plans together, or a standalone feature).
- Do NOT use this section if the extension IS running — call `create-feature.js` instead
  (it's authoritative: does DB upsert, subtask linking, file write, and board refresh
  atomically).

### How to Detect Whether the Extension Is Running

1. Check for `.switchboard/api-server-port.txt` in the workspace root.
2. If present and the health endpoint responds
   (`GET http://127.0.0.1:{port}/health`), the extension is live — use `create-feature.js`.
3. If absent or health check fails, proceed with direct file write.

### Feature File Format

Feature files live in `.switchboard/features/` and follow this structure:

```markdown
---
description: '{Feature Name}'
---

# {Feature Name}

## Goal

{Description of what this feature achieves and why it matters.}

## How the Subtasks Achieve This

{Narrative connecting the subtasks to the goal. Written once by the agent;
preserved by _regenerateFeatureFile on subsequent subtask changes.}

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] (no subtasks)
<!-- END SUBTASKS -->
```

**Format notes (verified against source):**
1. **YAML frontmatter** — the extension writes `---\ndescription: '{name}'\n---\n\n# {name}\n\n...`
   (see `createFeatureFromPlanIds` at `KanbanProvider.ts` line 8771). The `description` field is
   quoted to prevent YAML breakage from names containing `:`, `---`, etc. The watcher extracts
   the topic from the H1 title, so frontmatter is not strictly required for import — but it IS
   the canonical format and should be included for consistency.
2. **Full SUBTASKS marker** — use `<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->`
   (see `_regenerateFeatureFile` at `KanbanProvider.ts` line 8648), not the shorter
   `<!-- BEGIN SUBTASKS -->`. The regeneration search uses the prefix `<!-- BEGIN SUBTASKS`,
   so the shorter marker would technically work — but use the full marker to match
   extension-generated files.
3. **No `## Metadata` section** — the extension writes `complexity: 'Unknown'` and `tags: ''`
   directly to the DB (`createFeatureFromPlanIds` lines 8741–8742), NOT via a `## Metadata` section
   in the file. Real feature files do NOT contain a Metadata section. An optional `## Metadata`
   section MAY be added (the watcher will parse it if present), but it is not part of the
   extension-generated format.

The `<!-- BEGIN SUBTASKS ... -->` / `<!-- END SUBTASKS -->` block is regenerated from the DB
by `_regenerateFeatureFile`, so treat it as DB-derived: never rely on an edit *surviving*
there, and never delete a line expecting the subtask to detach. Writing links INTO it does
work — that is the offline linking path (see "Linking Existing Plans as Subtasks" below) — but
the block will be rewritten from DB state afterwards. If you have no subtasks to link yet,
write the `- [ ] (no subtasks)` placeholder.

### Filename Convention

```
{slug}-{planId}.md
```

- `slug`: lowercase, hyphens only, max 60 chars (e.g. `auth-refactor`)
- `planId`: a fresh UUID v4 (generate with
  `node -e "const {randomUUID}=require('crypto');console.log(randomUUID())"`)
- Full path: `.switchboard/features/{slug}-{planId}.md`
- **Never omit the planId from the filename** — the watcher derives the `plan_id` from this
  trailing UUID on re-import. A bare slug would mint a fresh random ID on re-import and orphan
  every subtask.

### Linking Existing Plans as Subtasks

**If the extension is running**, this is authoritative — it links in the DB and regenerates
the feature file in one step:

```bash
node .agents/skills/kanban_operations/assign-to-feature.js "{featurePlanId}" '["subtaskPlanId1","subtaskPlanId2"]' "{workspaceRoot}"
```

**If it is not running**, subtask linking still works — you do NOT have to wait for VS Code.
Two file-only mechanisms exist, both picked up by `GlobalPlanWatcherService` on the next
import. Prefer the first:

1. **List the subtasks in the feature file's block** (one write links all of them). Use the
   exact link shape the extension generates — a root-relative `../plans/<file>.md` target:

   ```markdown
   <!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
   ## Subtasks
   - [ ] [Add the login form](../plans/feature_plan_20260101_login-form.md)
   - [ ] [Wire the session cookie](../plans/feature_plan_20260101_session-cookie.md)
   <!-- END SUBTASKS -->
   ```

   Only `../plans/<file>.md`, `.switchboard/plans/<file>.md` and `./<file>.md` targets are
   understood. A bare planId or a bare filename is silently ignored — link by **plan file
   path**, never by planId, and never invent a path (`../plans/<planId>.md` is not a real
   file and links nothing).

2. **Add `**Feature:** {featurePlanId}` to the subtask plan file's metadata.** A durable
   fact on the *subtask* side, parsed by `parsePlanMetadata` and applied by
   `_applyFeatureLink`. Useful when you are authoring the subtask plan anyway, or when the
   feature file is owned by someone else. Costs one edit per subtask, so option 1 is
   usually less work.

**Both mechanisms are link-only.** Removing a link from the block does NOT detach the
subtask — omission means "no statement", not "remove". Detaching is an explicit operation
(board drag, `assign-to-feature.js` onto a different feature, or the remove/delete verbs),
because the block is regenerated from the DB and any stale copy of the file would otherwise
read as an instruction to delete rows the DB legitimately has.

Neither mechanism performs project inheritance, kanban column resolution, or integration
sync — those stay extension-only.

### Sourcing Existing Suggest-Feature Content

The kanban UI's "Suggest Features" button generates a detailed prompt (see
`_buildSuggestFeaturesPrompt` in `KanbanProvider.ts`) that:
- Scans `kanban-board.md` for ungrouped plans in pre-coding columns
- Groups them by theme
- Proposes feature names and goals for user approval
- Then calls `create-feature.js`

If the user has not specified which plans to group, read `kanban-board.md`, propose groupings,
get approval, then create the feature files.

### After Writing

- Do NOT commit or push — creating a feature is a planning action. Leave the new
  file in the working tree for the user. (The features folder will be tracked once
  `expose-features-folder-in-gitignore.md` is deployed.)
- Note to the user that the extension will automatically import the feature into the kanban DB on
  next activation via the GlobalPlanWatcherService.

---

## Create from Plans

Create a Switchboard feature when the user already knows which plans belong
together. This is the direct path — no board scanning, no clustering, no
proposal step. Just create the feature, verify it, and write the narrative.

### When to Use

- The user says "create a feature from these plans" / "group these into a
  feature" / "make a feature for X containing plans A, B, C"
- The user has just written several related plans and wants them grouped
- The planner persona (switchboard-chat) flagged 3+ related plans and the
  user confirmed they want a feature
- The improve-plan workflow restructured plans into a feature set during
  review and needs to create the feature
- Do NOT use this section if the user wants you to *discover* groupings from
  the board — use the Group section instead
- Do NOT use this section if the extension is NOT running — use the Create
  section (the remote fallback) instead

### Prerequisites

#### 1. Extension must be running

Check for `.switchboard/api-server-port.txt` in the workspace root. If absent,
the extension is not running — fall back to the Create section (direct
file write).

#### 2. Plans must be in the kanban DB

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

#### 3. Collect plan IDs

If the user gave plan filenames, resolve them to plan_ids via the SQL query
above. If the user gave plan_ids directly, use those.

### Execution

#### Step 1: Create the feature

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
- Extension not reachable → fall back to the Create section (the script itself returns ok:false with a clear message; the AGENT then switches sections).
- Zero subtasks linked (silent blank feature) → `create-feature.js` returns `ok: true` even when none of the supplied plan IDs resolve to DB rows (the extension deliberately allows blank features). This is NOT an error. The Prerequisites §2 pre-flight SQL check is the ONLY gate that prevents this. If you skipped it, Step 2 verification will show zero subtasks — recover by deleting the blank feature: `node .agents/skills/kanban_operations/delete-feature.js "<featurePlanId>" "<workspaceRoot>"`, then re-run the pre-flight and retry.

#### Step 2: Verify

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

#### Step 3: Write narrative sections

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

### Notes

- Feature creation syncs to Linear/ClickUp: the feature is pushed as a parent
  issue/task and subtasks are linked as children. Gated per tracker on BOTH
  `setupComplete` and `realTimeSyncEnabled` being true — with either off, that
  tracker is skipped silently. A subtask is only linked if its own issue/task
  already exists; ones that don't are skipped and get linked on a later
  feature-sync trigger.
- **Never mention tracker sync in your reply.** Do not claim a sync happened,
  and do not hedge about whether one did — a caveat about sync is noise the
  user has to read and cannot act on. Say nothing about Linear/ClickUp unless
  the user asks, or unless a sync error was actually returned to you. If asked,
  confirm it by reading `linear_issue_id` / `clickup_task_id` on the feature and
  subtask rows rather than speculating.
- To add more plans to an existing feature later, use
  `node .agents/skills/kanban_operations/assign-to-feature.js "{featurePlanId}" '["newPlanId"]' "{workspaceRoot}"`
- The `<!-- BEGIN SUBTASKS -->` block is auto-managed by the extension —
  do not edit it manually.

---

## Group

You are grouping loose Switchboard plans into features. Follow this flow exactly — do not create any feature before the user approves.

### When to Use

Triggered when the user asks to "group plans into a feature", "organise loose plans into features", or "suggest feature groupings", OR by clicking the **Suggest Features** board button (which copies this skill's text with the workspace root injected).

If the user already knows which plans to group (no discovery needed), use the Create from Plans section instead — it skips the scan/propose/confirm flow and goes straight to creation.

### Flow

#### 1. SCAN

Read the board snapshot:

```
cat {{WORKSPACE_ROOT}}/.switchboard/kanban-board.md
```

Scope: CREATED and PLAN REVIEWED columns only.
Ignore BACKLOG and all post-coding columns.

Each plan line ends with an HTML comment, e.g.:
```
- [.switchboard/plans/foo.md](...) — Foo <!-- planId:abc-123 -->
- [.switchboard/features/feature-def.md](...) — Bar Feature <!-- planId:def-456 feature -->
- [.switchboard/plans/baz.md](...) — Baz <!-- planId:ghi-789 subtask-of:"Bar Feature" -->
```

Skip lines tagged `feature` (they are features) or `subtask-of:...` (already assigned).
Use the `planId:` value from the comment — NOT the filename — when calling create-feature.js.
(A path under .switchboard/features/ also indicates a feature, but subtask detection
requires the subtask-of tag — do not rely on filenames alone.)

#### 1a. PROJECT SCOPE

The active project filter is injected above as `{{ACTIVE_PROJECT_FILTER}}`.

- If a project name is injected: only consider plans tagged `project:"<that name>"`.
- If no project name is injected (empty, `__unassigned__`, or the literal placeholder): ignore all plans that have a `project:"..."` tag — only untagged plans are candidates.

#### 2. READ PLAN BODIES

For each candidate plan in scope, read the full plan file.
Extract: goal, problem summary, dependencies, tags.
Use this — not just titles — to determine groupings.
Read plans in parallel where possible. If >25 candidates, first-pass cluster by
title then deep-read within each cluster.

#### 3. PROPOSE (single message, all groups at once)

Group by underlying capability theme, not by surface keyword.
Cross-provider plans that address the same capability go into one feature.
Minimum 2 plans per feature. Single-plan "groups" go in the Standalone section.
Flag POSSIBLE OVERLAP / REDUNDANCY / GAP where detected.

**Cross-column warning:** If a proposed feature contains plans from different
kanban columns (e.g. one CREATED + one PLAN REVIEWED), you MUST flag this
prominently in the proposal with a **⚠ CROSS-COLUMN** warning. Explain:
- The CREATED plan(s) have NOT been plan-reviewed yet.
- If the feature is dragged to a coder column, the CREATED subtask(s) will
  skip PLAN REVIEW entirely and go straight to coding without refinement.
- **To fix this after feature creation:** select the feature card on the
  kanban board and press the **Replan** button (the re-plan icon in the
  PLAN REVIEWED column header). This sends the CREATED subtasks to the
  planner agent for `improve-plan` refinement, moving them to PLAN REVIEWED.
- Only once all subtasks are in PLAN REVIEWED should the feature be dragged
  to a coder column.

For each proposed feature, write:
- Feature name
- Goal: 2-4 sentences describing what the feature achieves, what problem it
  solves, and why these plans are grouped together.
- How the Subtasks Achieve This: one bullet per member plan explaining what
  it does and how it contributes to the feature's goal. Format:
    - **Plan Name**: <what it does and how it contributes>
- Dependencies & sequencing: note any ordering constraints between subtasks
  (e.g. "Subtask A must land before Subtask B can be tested") and any
  cross-subtask dependencies. If there are none, state "No hard ordering
  constraints; subtasks can be executed in parallel."
- Member plans with planId, one-line summary, and current kanban column

List genuinely standalone plans separately. Then stop and wait.

#### 4. CONFIRM

Wait for user approval or edits. Do not touch the database until confirmed.

#### 5. EXECUTE

For each approved group, pass the Goal text as the description argument.
Escape any double quotes in the Goal text (replace " with \") or rephrase to
avoid them, so the bash command does not break. Also avoid $, backticks, and
backslashes in the Goal text — these are shell metacharacters inside double quotes.

```bash
node .agents/skills/kanban_operations/create-feature.js "<feature name>" '["planId1","planId2",...]' "{{WORKSPACE_ROOT}}" "<goal text with escaped quotes>"
```

The description becomes the ## Goal section in the feature file.
After all features are created, write the ## How the Subtasks Achieve This section
and the ## Dependencies & sequencing section into each feature file manually (the
create-feature script only writes the Goal).
Use the text from your step 3 proposal — paste the How the Subtasks Achieve This
section between the Goal and the `<!-- BEGIN SUBTASKS -->` marker, then paste the
Dependencies & sequencing section immediately after the Subtasks block. Both
sections are preserved by _regenerateFeatureFile on subsequent subtask changes, so
they only need to be written once.

**Cross-column note in the feature file:** If the feature has subtasks in
different kanban columns (e.g. some CREATED, some PLAN REVIEWED), add a
**⚠ Cross-Column Review Note** section immediately after the Subtasks block
(before Dependencies & sequencing). Write:

> This feature contains subtasks in different kanban columns. The subtasks
> in CREATED have NOT been plan-reviewed yet. Before dragging this feature
> to a coder column, select the feature on the kanban board and press the
> **Replan** button (re-plan icon in the PLAN REVIEWED column header) to
> send the CREATED subtasks to the planner for `improve-plan` refinement.
> Only review/refine the CREATED subtasks — the PLAN REVIEWED subtasks have
> already been reviewed.

This note is preserved by `_regenerateFeatureFile` along with the other
manual sections.

To add more plans to a feature later, use assign-to-feature.js with the feature planId from the create-feature.js output.

#### 6. BACKLOG (optional, after execution)

Ask the user: "Would you like me to analyse the BACKLOG for feature groupings too?"
Do NOT re-read the board or inspect the BACKLOG column yourself.
If the user says yes, repeat steps 1-5 scoped to the BACKLOG column.
If the user says no or does not respond, stop.

### Notes

- Feature creation updates the Switchboard board, writes a `.switchboard/features/` file, and syncs to Linear/ClickUp — the feature is pushed as a parent issue/task with subtasks linked as children. Gated per tracker on BOTH `setupComplete` and `realTimeSyncEnabled` being true; with either off that tracker is skipped silently. Subtasks without an existing issue/task are skipped and get linked on a later feature-sync trigger.
- **Never mention tracker sync in your reply.** Do not claim a sync happened, and do not hedge about whether one did — a caveat about sync is noise the user has to read and cannot act on. Say nothing about Linear/ClickUp unless the user asks, or unless a sync error was actually returned to you. If asked, confirm it by reading `linear_issue_id` / `clickup_task_id` on the feature and subtask rows rather than speculating.
- The `create-feature.js` / `assign-to-feature.js` verb scripts are documented in `.agents/skills/kanban_operations/SKILL.md`.
- The confirm gate is load-bearing **in interactive mode**: never create any feature before the user approves. Unattended mode's authorization comes from the user pressing Start orchestrator.

### Unattended mode (orchestration)

This section applies ONLY when the invoking prompt contains the directive `UNATTENDED=true` (which the Orchestration kickoff prompt injects). It is the explicit, documented exception to the confirm gate above. After the removal of the `Miscellaneous` sweep, `UNATTENDED=true`'s only remaining effect is gating the confirm-skip below.

- Follow steps 1, 1a, 2, 3 as written, but step 3's proposal is written to the reply for the session log, not for approval; **skip step 4 (CONFIRM) entirely** and proceed to step 5 EXECUTE immediately. Never skip step 4 outside unattended mode.
- Standalone plans are left standalone — under the `none` worktree default a plan with no feature dispatches straight to a team, so there is no sweep and no `Miscellaneous` catch-all.
- Repeat the EXECUTE shell-safety rules here: escape `"` in goal text; avoid `$`, backticks, backslashes. No human reviews the generated commands in this mode, so escaping is mandatory, not hygiene.
- Skip step 6 (BACKLOG) in unattended mode — BACKLOG stays human-curated.

---

## Rearrange

Re-slice the subtasks of an existing feature so each one is the right size and scope for a single coding agent — **while keeping the subtask content as written.** This is the structure-only operation: it changes *boundaries* (how work is partitioned across subtasks), not *words* (how each subtask is authored).

Use it when a feature's subtasks are the wrong shape for execution — most often when one subtask bundles several independent tasks and burns a coder's whole context on reading before it can code — and you want to split/move/merge the pieces without a content rewrite.

### When to use vs. the neighbours

- **This section (`rearrange`)** — the subtask *boundaries* are wrong (one is too big, two overlap, work is in the wrong subtask). Split one into N, move scope between them, merge, reorder. **Content is preserved verbatim.**
- **`improve-feature` / `switchboard-feature`** — the subtask *content* needs work (deepen, dedupe, make the set coherent). It re-authors each subtask in its own voice, so it will re-inflate content you deliberately trimmed. Use it *after* rearrange if the freshly-sliced pieces then need polishing — never as a substitute for a structure-only change.
- **`switchboard-split`** — the narrow special case: **one plan → two, along complexity lines** (Complex/Risky vs Routine). If that's exactly the split you want, use it. This section is the general form: any subtask → N pieces along any axis (usually task-separation), plus move/merge/reorder across the whole feature.
- **Group / Create from Plans** — the *inverse* direction: composing loose plans *into* a feature. This section decomposes/rearranges an existing one.

### Core principle — preserve content, change structure

Every implementation step, code block, line reference, and edge case in the source subtasks must land in exactly one destination subtask (shared context — Goal/background/dependencies — may be duplicated into each so every file stays self-contained). **Do not re-author.** If a piece reads well already, it reads well in its new home unchanged. Git is the undo.

### Inputs

- The **feature** (its feature plan-id, or the feature file path — the id is in `.switchboard/features/<slug>-<uuid>.md`).
- The **target shape**: which subtask splits into what, and/or what moves where. If not given, propose the re-slicing and confirm before touching anything.

Read the feature and every subtask first:
```bash
PORT=$(cat .switchboard/api-server-port.txt); BASE="http://127.0.0.1:$PORT"
curl -s "$BASE/kanban/plans?featureId=<featurePlanId>" | jq '.data[] | {planId, topic, planFile, kanbanColumn}'
```

### The building blocks

Subtask membership is `<!-- planId:… subtask-of:"<feature name>" -->` in the kanban-state mirror, backed by `kanban.db`. **Never edit `kanban.db` or the state `.md` mirror by hand** (this workspace has a history of board-clobber from that). Compose the rearrangement from these primitives instead:

| Goal | Local (extension running) | Remote (no extension) |
|---|---|---|
| **Keep a subtask but change its scope** | **Rewrite its `.md` file in place.** This preserves its `planId`, `subtask-of`, and column — zero board churn. The most important move: make one output *be* the rewritten original. | Same — just a file write. |
| **Create a new subtask in the feature** | `POST /kanban/plans` (writes file, imports, returns `planId`) → `node .agents/skills/kanban_operations/assign-to-feature.js <featurePlanId> '["<newPlanId>"]' <workspaceRoot>` | Write the `.md` with `**Feature:** <feature-plan-id>` (and `**Project:** <name>` if needed) in the metadata block — applied apply-if-empty on import — then move it to `PLAN REVIEWED` via the Notion/Linear provider or MCP. |
| **Detach a subtask (keep the plan)** | `node .agents/skills/kanban_operations/remove-from-feature.js <subtaskPlanId> <workspaceRoot>` (or `POST /kanban/feature/remove`) | Remove the `**Feature:**` line and re-import. |
| **Delete a subtask entirely** | `DELETE /kanban/plans?planId=<id>&deleteFile=true` — **`deleteFile=true` is required**, or the file re-imports on the next scan | Delete the `.md` file. |

`POST /kanban/plans` body: `{ title, slug?, complexity?, tags?, project?, body?, workspaceRoot? }` — returns `{ planId, planFile, slug }`. It refuses to overwrite an existing slug (409).

### Steps — split one subtask into N (the common case)

1. **Read** the feature and the target subtask in full.
2. **Decide the partition.** Every step/section of the source lands in exactly one piece; shared Goal/background/dependencies are copied into each so each is self-contained.
3. **Rewrite the original file in place** to hold piece 1 (keeps its `planId` + linkage + column). Do NOT create a new file for piece 1 — reuse the original, so one card stays stable.
4. **Create pieces 2..N** as new subtasks via the table above (local: `POST /kanban/plans` → `assign-to-feature.js`; remote: file + `**Feature:**` line → move to `PLAN REVIEWED`).
5. **Verify nothing was lost** — every source step/code block/edge case is now in exactly one piece.
6. **Update the feature's prose** — the `## Goal`, `## How the Subtasks Achieve This`, and any dependencies/sequencing narrative — to describe the new subtask set. **Never touch the auto-generated `<!-- BEGIN/END SUBTASKS -->` block** — the extension regenerates it from the DB.
7. **Confirm the board** reflects the new set: `curl -s "$BASE/kanban/plans?featureId=<featurePlanId>" | jq '.data[].topic'`.

Move scope, merge, and reorder are the same primitives: **move** = rewrite two files (cut from one, paste into the other); **merge** = fold one file's steps into another, then delete the emptied subtask (`deleteFile=true`); **reorder** = purely narrative (subtask order is presentation — encode intended sequence in the feature's dependencies prose, not by renumbering cards).

### Guardrails

- **Preserve content, not structure** — nothing in the source subtasks may be dropped or rewritten for style; git is the undo.
- **Rewrite-in-place to keep `planId`s stable** — creating four new cards to replace two churns the board and loses history. Reuse originals wherever a piece maps back to one.
- **Never touch a feature's `<!-- BEGIN/END SUBTASKS -->` block** — it is regenerated from the DB; hand-edits are cosmetic and get overwritten.
- **Never write `kanban.db` or `kanban-state-*.md` directly** — go through the API / `kanban_operations` scripts (local) or plan-file frontmatter (remote).
- **`deleteFile=true` on real deletes** — otherwise the `.md` re-imports and the subtask reappears.
- **This is structure-only.** If the sliced pieces need content work afterward, hand off to `improve-feature` as a separate, explicit step — do not let a rearrangement quietly become a rewrite.

### Report

State: the feature, the before→after subtask list (which cards were reused-in-place vs. newly created vs. deleted), and a one-line confirmation that every source step landed in exactly one destination subtask.
