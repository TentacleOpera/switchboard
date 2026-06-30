# Plan-Import DB Manifest: Carry Column, Status, Epic Links & Project on Ingest

## Metadata
**Complexity:** 7
**Tags:** backend, database, feature, cli

## Goal

Let externally-authored plans (written by the `/sw`, `/improve-plan`, and coding workflows) land in the **correct kanban column and state** on import, instead of always defaulting to `CREATED`. Achieve this with a JSON **manifest sidecar** that the workflow writes alongside the plan `.md` files; the extension ingests it (setting DB-owned state the `.md` can't express), then **deletes it** so it never re-applies.

Manifest carries, per plan: **kanban column, status, epic relationships (`is_epic` / `epic_id`), and project name**. Plan *content* metadata (title, complexity, tags) continues to come from the `.md` front-matter / `## Metadata` section — the manifest does not duplicate those.

### Problem / background / root-cause analysis

- **Every file-import path hardcodes `CREATED` + `active` on first insert** (`PlanFileImporter.ts:107-108`, `GlobalPlanWatcherService.ts:535`, `KanbanDatabase.ts:1369`). So a plan that has already been improve-planned (→ `PLAN REVIEWED`) or coded (→ `LEAD CODED`/etc.) still imports to `CREATED`. The board loses the real progress.
- **Column/status/epic links are DB-owned, never file-derived.** The file importer deliberately won't set them; only the DB mutates them (research confirmed: `insertFileDerivedPlan` sets defaults, `upsertPlans` allows full control).
- **Key enabling fact — the column only needs setting ONCE.** `insertFileDerivedPlan` uses `ON CONFLICT(plan_file, workspace_id) DO UPDATE` and **preserves `kanban_column` on every subsequent re-import** (`KanbanDatabase.ts:1377`). So once the manifest upgrades a plan's column, the periodic scanner (`GlobalPlanWatcherService`, ~10s) will **not** reset it, and manual board moves stick. This is why the consume-then-delete manifest is safe and sufficient — it sets initial state and then gets out of the way.
- **No manifest/sidecar mechanism exists today** for plans (research confirmed); this is net-new, but it rides the existing watcher/scan cycle and the existing full-control `upsertPlans()` path.
- **Why a sidecar and not front-matter:** epic→subtask relationships (`epic_id`) span multiple plan files and reference each other's stable `plan_id`; that relational state cannot live in any one `.md`. A batch manifest expresses the whole set at once. (For a column-only need, front-matter honored-once would have sufficed — but epic links rule that out.)

## Manifest Format

**Location:** `.switchboard/plans/manifest.json` (one batch file per workspace, covering all plans a workflow run produced). Written by the workflow **after** all `.md` files.

**Schema (v1):**
```json
{
  "version": 1,
  "plans": [
    {
      "planFile": "feature_plan_20260630_foo.md",
      "planId": "550e8400-e29b-41d4-a716-446655440000",
      "kanbanColumn": "PLAN REVIEWED",
      "status": "active",
      "isEpic": false,
      "epicId": "",
      "project": "Switchboard"
    },
    {
      "planFile": "epic-77ac…-bar.md",
      "planId": "77ac0000-…",
      "kanbanColumn": "CREATED",
      "status": "active",
      "isEpic": true,
      "epicId": "",
      "project": "Switchboard"
    }
  ]
}
```

Field rules:
- `planFile` (**required**, join key): path **as stored in the DB `plan_file` column** (relative form, post-V18). Must resolve inside `.switchboard/plans/` or `.switchboard/epics/`; reject `..`/absolute paths.
- `planId` (recommended): must match the `**Plan ID:** <uuid>` embedded in the corresponding `.md` so identity is stable and `epicId` references resolve. For epics, prefer the `epic-<uuid>.md` filename convention (research: `GlobalPlanWatcherService.ts:520-529`) so the epic's `plan_id` is stable.
- `kanbanColumn`: validated against `VALID_KANBAN_COLUMNS` (`KanbanDatabase.ts:642`). Invalid → skip the column override (leave `CREATED`) + log.
- `status`: validated against the valid set (`KanbanDatabase.ts:648`: `active|archived|completed|deleted`).
- `isEpic` / `epicId`: `epicId` references another entry's `planId` (in-batch) or an existing DB epic. Process epics before subtasks.
- `project`: resolved to `project_id` at ingest (same lookup as `insertFileDerivedPlan`, `KanbanDatabase.ts:1350`); unknown project → leave `project_id` null + keep denormalized `project` string (match existing behavior).

## Implementation Plan

### Phase 1 — Ingest service (extension)
1. Add a `PlanManifestService` (or a method on `GlobalPlanWatcherService`) invoked **at the end of each scan/import cycle**, *after* the normal `.md` import pass — so plan rows exist before the manifest upgrades them.
2. Detect `.switchboard/plans/manifest.json` via the existing watcher + periodic scan (no new watcher needed; hook the existing cycle in `GlobalPlanWatcherService`).
3. **Defensive parse:** `JSON.parse` in a try/catch; if it fails or `version` is missing/unknown, treat as a half-written file — skip this cycle and retry next (the next scan is ≤10s away). This is the primary race guard against reading a partially-written manifest.

### Phase 2 — Apply entries
4. Sort entries: `isEpic: true` first, then subtasks (so epic rows exist before `epic_id` links resolve).
5. For each entry:
   - **Ensure the `.md` row exists.** If `(plan_file, workspace_id)` isn't in the DB yet, trigger import of that `.md` first (reuse `PlanFileImporter` / `GlobalPlanWatcherService._handlePlanFile`) so topic/complexity/tags parse from the file. If the `.md` is missing on disk entirely, **defer** this entry (see staleness, step 8).
   - **Apply DB-owned fields** via the full-control path (`upsertPlans`, `KanbanDatabase.ts:1274`, which can set `kanban_column`/`status`/`is_epic`/`epic_id`/`project_id`) — or a narrow targeted `UPDATE` of just those columns. Validate each field first.
   - Idempotent by construction: re-applying the same entry writes the same state, so a missed delete is harmless.
6. Because `insertFileDerivedPlan` preserves `kanban_column` on conflict, no further work is needed to make the column "stick" against later scans.

### Phase 3 — Delete / retry / staleness
7. **Delete `manifest.json` only after all entries are applied.** If any were deferred, do **not** delete — either leave the whole file (idempotent next cycle) or rewrite it with only the unprocessed entries. (Recommend: leave whole; rely on idempotency.)
8. **Staleness guard:** track per-manifest attempts (in-memory or a sibling dotfile); if entries still can't resolve after N cycles / T minutes (e.g. the referenced `.md` never appears), log a warning and drop those entries / delete the manifest so it can't wedge the scan loop forever.

### Phase 4 — Validation & security
9. Reject path-traversal / absolute `planFile`. Validate `kanbanColumn` and `status` against the canonical sets. Resolve `epicId` only to known plans; unresolved → import without the link + log. Scope everything to the current `workspace_id`. Treat the manifest as semi-trusted file input (it can be authored by an agent) — never insert unvalidated column/status strings.

### Phase 5 — Workflow (skill) changes  ⚠️ requires explicit permission to edit system/workflow files
*(User is the workflow author and has requested this; confirm before editing.)*
10. Update the relevant skills to emit/maintain the manifest after writing plan `.md` files:
    - `.claude/skills/switchboard-chat` (`/sw`) and `.agents/workflows/switchboard-chat.md`: after writing plans, write `manifest.json`. For pure consultation output the column is `CREATED` (trivial, but the manifest still carries status/epic/project).
    - `.claude/skills/improve-plan` / `.agents/workflows/improve-plan.md`: set `kanbanColumn: "PLAN REVIEWED"` for plans it has adversarially reviewed.
    - Coding workflows: set the appropriate coded column.
11. Each plan `.md` must embed `**Plan ID:** <uuid>` (and epics use the `epic-<uuid>.md` filename) so `epicId` links resolve and identity is stable across re-imports.
12. Document the v1 schema inside the skill so the agent emits valid JSON, and instruct it to **write the manifest last** (after all `.md`), ideally via temp-write + rename for atomicity.

### Phase 6 — Verification
13. Build only for VSIX; test from `src/`.
14. Cases:
    - Import a plan with `kanbanColumn: "CODE REVIEWED"` → lands in CODE REVIEWED, not CREATED; manifest is deleted afterward.
    - Re-scan / edit the `.md` → column stays (conflict-preserve); manual move to another column sticks.
    - Epic + two subtasks in one manifest → epic imports as `is_epic=1`, subtasks get `epic_id` = epic's plan_id; board shows the epic grouping.
    - Project name resolves to the right `project_id` (and filters correctly).
    - Half-written manifest (truncated JSON) → skipped that cycle, applied cleanly next cycle, no bad rows.
    - Invalid column/status string → entry imported safely (defaults), warning logged, no crash.
    - Manifest referencing a `.md` that never appears → staleness guard fires, scan loop not wedged.
    - Multi-workspace: manifest in workspace A doesn't affect workspace B.

## Open Decisions
- **MAN1 — deferred-entry handling:** leave whole manifest for idempotent retry (recommended) vs rewrite with remainder.
- **MAN2 — atomic write:** rely on defensive-parse-and-retry (recommended, simplest) vs require workflow to temp-write + rename (more robust, needs agent tooling support).

## Files Touched (anticipated)
- `src/services/GlobalPlanWatcherService.ts` — hook manifest processing into the scan cycle (after `.md` import).
- New `src/services/PlanManifestService.ts` — parse/validate/apply/delete (or fold into the watcher).
- `src/services/KanbanDatabase.ts` — reuse `upsertPlans` / add a narrow column-update helper; reuse project-id resolution and the valid-column/status sets.
- `src/services/PlanFileImporter.ts` — possibly expose a "import single file now" helper for the ensure-row step.
- Skills/workflows (with permission): `.claude/skills/switchboard-chat`, `.claude/skills/improve-plan`, `.agents/workflows/*.md`, plus any coding workflow — manifest-writing instructions + `**Plan ID:**` embedding + schema doc.
- Tests: manifest parse/validate/apply, epic ordering, dedup/idempotency, staleness, security (path traversal, invalid enums).
