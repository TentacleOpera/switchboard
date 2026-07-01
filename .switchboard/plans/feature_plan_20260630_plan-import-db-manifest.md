# Plan-Import DB Manifest: Carry Column, Status, Epic Links & Project on Ingest

## Metadata
**Complexity:** 7
**Tags:** backend, database, feature, cli

## Goal

Let externally-authored plans (written by the `/sw`, `/improve-plan`, and coding workflows) land in the **correct kanban column and state** on import, instead of always defaulting to `CREATED`. Achieve this with a JSON **manifest sidecar** that the workflow writes alongside the plan `.md` files; the extension ingests it (setting DB-owned state the `.md` can't express), then **deletes it** so it never re-applies.

Manifest carries, per plan: **kanban column, status, epic relationships (`is_epic` / `epic_id`), and project name**. Plan *content* metadata (title, complexity, tags) continues to come from the `.md` front-matter / `## Metadata` section — the manifest does not duplicate those.

### Problem / background / root-cause analysis

- **Every file-import path hardcodes `CREATED` + `active` on first insert** (`PlanFileImporter.ts:107-108`, `GlobalPlanWatcherService.ts:535`, `KanbanDatabase.ts:1403`). So a plan that has already been improve-planned (→ `PLAN REVIEWED`) or coded (→ `LEAD CODED`/etc.) still imports to `CREATED`. The board loses the real progress.
- **Column/status/epic links are DB-owned, never file-derived.** The file importer deliberately won't set them; only the DB mutates them (research confirmed: `insertFileDerivedPlan` sets defaults, `upsertPlans` allows full control).
- **Key enabling fact — the column only needs setting ONCE.** `insertFileDerivedPlan` uses `ON CONFLICT(plan_file, workspace_id) DO UPDATE` and **preserves `kanban_column` on every subsequent re-import** — the ON CONFLICT clause at `KanbanDatabase.ts:1404-1411` omits `kanban_column` from the UPDATE SET, so re-imports never touch it. So once the manifest upgrades a plan's column, the periodic scanner (`GlobalPlanWatcherService`, ~10s) will **not** reset it, and manual board moves stick. This is why the consume-then-delete manifest is safe and sufficient — it sets initial state and then gets out of the way.
- **No manifest/sidecar mechanism exists today** for plans (research confirmed); this is net-new, but it rides the existing watcher/scan cycle and the existing targeted-UPDATE methods (`movePlanByPlanFile`, `updateEpicStatus`).
- **Why a sidecar and not front-matter:** epic→subtask relationships (`epic_id`) span multiple plan files and reference each other's stable `plan_id`; that relational state cannot live in any one `.md`. A batch manifest expresses the whole set at once. (For a column-only need, front-matter honored-once would have sufficed — but epic links rule that out.)

## User Review Required

Yes — two decisions need a human call before implementation:
1. **MAN1 (deferred-entry handling):** leave the whole manifest for idempotent retry (recommended) vs. rewrite it with only the unprocessed entries.
2. **MAN2 (atomic write):** rely on defensive-parse-and-retry (recommended, simplest, no agent tooling changes) vs. require the workflow to temp-write + rename (more robust, needs every emitting skill to support atomic rename).
3. **Phase 5 permission:** editing system/workflow/skill files (`.agents/workflows/*.md`, `.claude/skills/*`) requires explicit user approval — these are the source of truth for agent behavior.

## Complexity Audit

### Routine
- Reusing `movePlanByPlanFile` (`KanbanDatabase.ts:1635`) for the column override — it already validates against `VALID_KANBAN_COLUMNS` + `SAFE_COLUMN_NAME_RE` and fires `_fireColumnChanged` for UI refresh.
- Reusing `updateEpicStatus` (`KanbanDatabase.ts:1576`) for `is_epic` / `epic_id` — it sets both atomically and recomputes epic complexity on link change.
- Reusing the project-name → `project_id` resolution pattern from `insertFileDerivedPlan` (`KanbanDatabase.ts:1383-1395`).
- JSON parse in try/catch; delete file after success; per-entry validation.
- Skill/workflow edits to emit the manifest (prose + schema doc, no logic).

### Complex / Risky
- **`upsertPlans` does NOT override `kanban_column` on existing rows.** The `UPSERT_PLAN_SQL` ON CONFLICT clause (`KanbanDatabase.ts:580-609`) omits `kanban_column` from the UPDATE SET (only fresh INSERTs take the column value). The original plan's claim that `upsertPlans` "can set kanban_column" is **wrong for existing rows**. The manifest MUST use the targeted `movePlanByPlanFile` (column) + `updateEpicStatus` (epic links) + a narrow status UPDATE, NOT `upsertPlans`. This is the single most important correction.
- **The existing scan cycle never reads `manifest.json`.** The periodic scan `_scanForNewFiles` (`GlobalPlanWatcherService.ts:157`) collects only `.md` files (line 171) and short-circuits when nothing is new (line 195). Both file watchers filter to `.md` (`:335`, `:375`). So "hook the existing cycle, no new watcher" is misleading — the manifest needs an **explicit dedicated check** in the periodic-scan timer callback (independent of new-file detection), not a ride-along on the `.md` pass.
- **Stale-manifest-clobbers-user-move race:** if a user manually moves a plan between manifest-write and manifest-consume (≤10s window), a naive apply reverts their move. Mitigation: only override the column when the row is still at `CREATED` (treat `CREATED` as "uninitialized"); skip the override (but still apply epic/project) if the user already moved it.
- **Atomic-write DELETE→re-INSERT race interaction:** when a `.md` is atomically saved (temp+rename), `_handlePlanDelete` tombstones the column, deletes the row, then `_handlePlanFile` re-INSERTs at `CREATED` and the tombstone restores the real column (`GlobalPlanWatcherService.ts:562-590`). The tombstone captures the *actual DB column* — so a manifest-set column IS restored correctly. But if the manifest is consumed in the same cycle as an atomic save, ordering matters: apply the manifest AFTER the `.md` import pass so the row exists and the tombstone has already been consumed.
- **Epic ordering + `epic_id` resolution across in-batch and DB-existing epics:** `epicId` may reference another manifest entry's `planId` (in-batch) OR an already-DB-existing epic. Must process `isEpic:true` entries first, then resolve subtask `epicId` against both the just-applied epics and the DB.
- **Staleness guard** so a manifest referencing a `.md` that never appears can't wedge the scan loop forever.

## Edge-Case & Dependency Audit

**Race Conditions**
- Partial manifest write (truncated JSON): defensive `JSON.parse` in try/catch → skip this cycle, retry next (≤10s). Primary race guard.
- Manifest consumed while a `.md` is mid-atomic-save: ensure manifest apply runs AFTER the `.md` import pass in the same cycle; the row will exist and the tombstone is already consumed.
- Two scan cycles overlapping: `_scanInProgress` guard (`GlobalPlanWatcherService.ts:143`) already serializes periodic scans; manifest processing must live inside that same guarded block.
- User manual move between write and consume: "only override column if still `CREATED`" guard (see Complex/Risky).

**Security**
- `planFile` is semi-trusted input (agent-authored). Reject absolute paths and `..` traversal; resolve strictly inside `.switchboard/plans/` or `.switchboard/epics/` for the current `workspace_id`.
- Never insert unvalidated `kanbanColumn` / `status` strings — validate against `VALID_KANBAN_COLUMNS` (`KanbanDatabase.ts:643`) and `VALID_STATUSES` (`:649`). `movePlanByPlanFile` already validates the column; status needs an explicit check.
- `epicId` must resolve to a known plan (in-batch or DB); unresolved → import without the link + log (don't create phantom references).

**Side Effects**
- `movePlanByPlanFile` fires `_fireColumnChanged` → triggers kanban UI refresh + ClickUp/Linear sync. This is desirable (board updates immediately) but means a large manifest batch fires N refresh events; consider batching or debouncing the UI refresh if N is large.
- `updateEpicStatus` recomputes epic complexity on link change (`KanbanDatabase.ts:1600-1601`) — correct behavior, but means epic rows get a complexity recompute during manifest apply.
- Deleting `manifest.json` is a filesystem mutation inside the watched directory — but watchers filter to `.md`, so the delete raises no spurious plan events.

**Dependencies & Conflicts**
- Depends on the existing periodic-scan timer (`setInterval` at `GlobalPlanWatcherService.ts:142`) — no new timer, but a new explicit call inside it.
- Depends on `movePlanByPlanFile` and `updateEpicStatus` signatures remaining stable.
- No conflict with the tombstone mechanism — manifest apply runs after tombstone consumption.
- Phase 5 (skill/workflow edits) depends on user permission and on every emitting skill writing `**Plan ID:** <uuid>` into the `.md` so `epicId` references resolve.

## Dependencies
- None (no prerequisite plans). This is a self-contained feature.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) `upsertPlans` cannot override `kanban_column` on existing rows — must use `movePlanByPlanFile` + `updateEpicStatus` instead; (2) the existing scan cycle never reads non-`.md` files, so the manifest needs an explicit dedicated check in the periodic timer, not a ride-along; (3) a stale manifest can clobber a user's manual board move inside the consume window. Mitigations: targeted UPDATE methods (already validated), "only override column if still `CREATED`" guard, and apply-after-`.md`-pass ordering.

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
- `kanbanColumn`: validated against `VALID_KANBAN_COLUMNS` (`KanbanDatabase.ts:643`). Invalid → skip the column override (leave `CREATED`) + log.
- `status`: validated against `VALID_STATUSES` (`KanbanDatabase.ts:649`: `active|archived|completed|deleted`).
- `isEpic` / `epicId`: `epicId` references another entry's `planId` (in-batch) or an existing DB epic. Process epics before subtasks.
- `project`: resolved to `project_id` at ingest (same lookup as `insertFileDerivedPlan`, `KanbanDatabase.ts:1383-1395`); unknown project → leave `project_id` null + keep denormalized `project` string (match existing behavior).

## Implementation Plan

### Phase 1 — Ingest service (extension)
1. Add a `PlanManifestService` (or a method on `GlobalPlanWatcherService`) that performs an **explicit, dedicated manifest check** on each periodic scan cycle — NOT a ride-along on the `.md` pass. The periodic scan `_scanForNewFiles` (`GlobalPlanWatcherService.ts:157`) collects only `.md` files (line 171) and short-circuits when nothing is new (line 195), so it would never read `manifest.json`. Instead, add the manifest check inside the `setInterval` callback (`GlobalPlanWatcherService.ts:142-153`), after the folder loop, so it runs every cycle regardless of whether new `.md` files appeared. Also call it from `triggerScan` (`:767`) after the `.md` scan completes.
2. **Defensive parse:** read `.switchboard/plans/manifest.json`; `JSON.parse` in a try/catch; if it fails or `version` is missing/unknown, treat as a half-written file — skip this cycle and retry next (the next scan is ≤10s away). This is the primary race guard against reading a partially-written manifest. Optionally respect a freshness guard (skip if `mtime` is < 500ms old, matching the partial-write guard at `:229`).
3. **Apply order:** run the manifest apply AFTER any `.md` import pass in the same cycle, so plan rows exist before the manifest upgrades them.

### Phase 2 — Apply entries  ⚠️ uses targeted UPDATEs, NOT `upsertPlans`
> **Correction to original plan:** `upsertPlans` (`UPSERT_PLAN_SQL`, `KanbanDatabase.ts:572-610`) does NOT include `kanban_column` in its ON CONFLICT UPDATE SET — it only sets the column on a fresh INSERT. For an existing row (which is the case here, since the `.md` import already created it at `CREATED`), `upsertPlans` will NOT override the column. Use the existing targeted methods instead.
4. Sort entries: `isEpic: true` first, then subtasks (so epic rows exist before `epic_id` links resolve).
5. For each entry:
   - **Ensure the `.md` row exists.** If `(plan_file, workspace_id)` isn't in the DB yet, trigger import of that `.md` first (reuse `PlanFileImporter` / `GlobalPlanWatcherService._handlePlanFile`) so topic/complexity/tags parse from the file. If the `.md` is missing on disk entirely, **defer** this entry (see staleness, step 8).
   - **Apply `kanbanColumn`** via `movePlanByPlanFile(planFile, workspaceId, kanbanColumn)` (`KanbanDatabase.ts:1635`) — it validates the column against `VALID_KANBAN_COLUMNS` + `SAFE_COLUMN_NAME_RE` and fires `_fireColumnChanged` for UI refresh. **Stale-manifest guard:** only call it if the row's current `kanban_column === 'CREATED'` (treat `CREATED` as "uninitialized"); if the user already moved it, skip the column override (but still apply epic/project below) and log. This prevents a stale manifest from reverting a manual board move.
   - **Apply `isEpic` / `epicId`** via `updateEpicStatus(planId, isEpic ? 1 : 0, epicId)` (`KanbanDatabase.ts:1576`) — sets both atomically and recomputes epic complexity on link change. Resolve `epicId` against just-applied in-batch epics first, then the DB.
   - **Apply `status`** via a narrow targeted `UPDATE plans SET status = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?` (validate against `VALID_STATUSES` first). Only override if the manifest status differs from the current — note `upsertPlans` only revives `deleted→active`, so a direct UPDATE is required for `archived`/`completed`. For the common `active` case, the row is already `active`, so this is usually a no-op.
   - **Apply `project`** by resolving to `project_id` (reuse the lookup at `KanbanDatabase.ts:1383-1395`) and a narrow `UPDATE plans SET project = ?, project_id = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?`. Unknown project → `project_id` null + keep the denormalized string.
   - Idempotent by construction: re-applying the same entry writes the same state, so a missed delete is harmless.
6. Because `insertFileDerivedPlan` preserves `kanban_column` on conflict (`KanbanDatabase.ts:1404-1411` omits it from UPDATE SET), no further work is needed to make the column "stick" against later scans.

### Phase 3 — Delete / retry / staleness
7. **Delete `manifest.json` only after all entries are applied.** If any were deferred, do **not** delete — either leave the whole file (idempotent next cycle) or rewrite it with only the unprocessed entries. (Recommend: leave whole; rely on idempotency.)
8. **Staleness guard:** track per-manifest attempts (in-memory map keyed by workspace, or a sibling `.manifest.attempts` dotfile); if entries still can't resolve after N cycles / T minutes (e.g. the referenced `.md` never appears), log a warning and drop those entries / delete the manifest so it can't wedge the scan loop forever.

### Phase 4 — Validation & security
9. Reject path-traversal / absolute `planFile`. Validate `kanbanColumn` against `VALID_KANBAN_COLUMNS` and `status` against `VALID_STATUSES`. Resolve `epicId` only to known plans (in-batch or DB); unresolved → import without the link + log. Scope everything to the current `workspace_id`. Treat the manifest as semi-trusted file input (it can be authored by an agent) — never insert unvalidated column/status strings. `movePlanByPlanFile` already enforces column validation; status + project need explicit checks in the new service.

### Phase 5 — Workflow (skill) changes  ⚠️ requires explicit permission to edit system/workflow files
*(User is the workflow author and has requested this; confirm before editing.)*
10. Update the relevant skills to emit/maintain the manifest after writing plan `.md` files:
    - `.claude/skills/switchboard-chat` (`/sw`) and `.agents/workflows/switchboard-chat.md`: after writing plans, write `manifest.json`. For pure consultation output the column is `CREATED` (trivial, but the manifest still carries status/epic/project).
    - `.claude/skills/improve-plan` / `.agents/workflows/improve-plan.md`: set `kanbanColumn: "PLAN REVIEWED"` for plans it has adversarially reviewed.
    - Coding workflows: set the appropriate coded column.
11. Each plan `.md` must embed `**Plan ID:** <uuid>` (and epics use the `epic-<uuid>.md` filename) so `epicId` links resolve and identity is stable across re-imports.
12. Document the v1 schema inside the skill so the agent emits valid JSON, and instruct it to **write the manifest last** (after all `.md`), ideally via temp-write + rename for atomicity (per MAN2 decision).

### Phase 6 — Verification
13. Build only for VSIX; test from `src/`. *(Session directive: skip compilation and automated tests — the user runs those separately.)*
14. Cases:
    - Import a plan with `kanbanColumn: "CODE REVIEWED"` → lands in CODE REVIEWED, not CREATED; manifest is deleted afterward.
    - Re-scan / edit the `.md` → column stays (conflict-preserve); manual move to another column sticks.
    - **Stale-manifest guard:** manually move a plan to `CODED`, then drop a manifest saying `PLAN REVIEWED` → column stays `CODED` (override skipped because not `CREATED`); epic/project still applied.
    - Epic + two subtasks in one manifest → epic imports as `is_epic=1`, subtasks get `epic_id` = epic's plan_id; board shows the epic grouping.
    - Project name resolves to the right `project_id` (and filters correctly).
    - Half-written manifest (truncated JSON) → skipped that cycle, applied cleanly next cycle, no bad rows.
    - Invalid column/status string → entry imported safely (defaults), warning logged, no crash.
    - Manifest referencing a `.md` that never appears → staleness guard fires, scan loop not wedged.
    - Multi-workspace: manifest in workspace A doesn't affect workspace B.
    - **Manifest with no new `.md` files:** drop a manifest alone (no new `.md` this cycle) → still processed (proves the dedicated check, not the `.md` ride-along).

## Proposed Changes

### `src/services/GlobalPlanWatcherService.ts`
- **Context:** Periodic scan lives in `setInterval` (`:142-153`) calling `_scanForNewFiles` per folder (`:157`); manual scan is `triggerScan` (`:767`). Both only handle `.md`.
- **Logic:** Add `private async _processManifest(workspaceRoot: string): Promise<void>` that reads `.switchboard/plans/manifest.json`, defensively parses, sorts entries (epics first), and applies each via `movePlanByPlanFile` / `updateEpicStatus` / narrow status+project UPDATEs on `KanbanDatabase`. Call it inside the `setInterval` callback after the folder loop (`:148`), and at the end of `triggerScan` (after `:797`).
- **Implementation:** Reuse `KanbanDatabase.forWorkspace(workspaceRoot)`. For the "ensure row exists" step, call `db.getPlanByPlanFile(rel, workspaceId)`; if missing and the `.md` exists on disk, route through `this._debounceHandleFile(uri, workspaceRoot)` then await a short tick, or call `this._handlePlanFile` directly. Stale-manifest guard: read current column, only `movePlanByPlanFile` if `=== 'CREATED'`. Staleness tracking: `private _manifestAttempts = new Map<string, number>()` keyed by workspace.
- **Edge Cases:** Partial JSON → catch → return (retry next cycle). Missing `.md` → defer (increment attempt counter). Overlapping cycles → already guarded by `_scanInProgress` (`:143`); keep manifest processing inside that block.

### `src/services/PlanManifestService.ts` (new — or fold into the watcher)
- **Context:** Keeps manifest logic isolated if the watcher is already large.
- **Logic:** `async applyManifest(workspaceRoot, workspaceId, db): Promise<{applied:number, deferred:number}>` — parse, validate, sort, apply, return counts. Caller decides delete vs. keep.
- **Implementation:** Pure function over a passed-in `KanbanDatabase` instance; no direct file watching. Path-traversal check: `path.resolve` the `planFile` against `.switchboard/plans|epics` and reject if it escapes.
- **Edge Cases:** All validation failures → log + skip the offending field/entry, never throw.

### `src/services/KanbanDatabase.ts`
- **Context:** Reuse `movePlanByPlanFile` (`:1635`) and `updateEpicStatus` (`:1576`) — no new methods strictly required. The project-id resolution at `:1383-1395` is private to `insertFileDerivedPlan`; either expose a small `resolveProjectId(name, workspaceId)` helper or duplicate the 8-line lookup in the manifest service.
- **Logic:** Add a narrow `updatePlanStatus(planFile, workspaceId, status)` and `updatePlanProject(planFile, workspaceId, project)` helper (or one combined `applyManifestEntry`) if folding into the DB class. Validate `status` against `VALID_STATUSES` (`:649`).
- **Edge Cases:** 0 rows affected (race with delete) → log + return false, caller defers.

### `src/services/PlanFileImporter.ts`
- **Context:** Possibly expose a "import single file now" helper for the ensure-row step.
- **Logic:** If `_handlePlanFile` is sufficient (it already imports a single `.md`), no change needed. Only add a helper if the manifest service needs a synchronous single-file import outside the debounce path.

### Skills / workflows (with permission)
- `.claude/skills/switchboard-chat`, `.claude/skills/improve-plan`, `.agents/workflows/*.md`, plus any coding workflow — manifest-writing instructions + `**Plan ID:**` embedding + v1 schema doc. Write manifest last; temp-write + rename if MAN2 chooses atomic.

## Verification Plan

### Automated Tests
*(Session directive: skip running automated tests — the user runs the suite separately. The cases below describe what the test suite should cover.)*
- Manifest parse/validate/apply happy path (column + epic + project).
- Epic ordering: subtask `epic_id` resolves to in-batch epic.
- Dedup/idempotency: apply same manifest twice → same state, no duplicate rows.
- Staleness: referenced `.md` never appears → guard fires, loop not wedged.
- Security: path-traversal `planFile` rejected; invalid `kanbanColumn`/`status` strings rejected (entry imported with defaults, warning logged).
- Stale-manifest guard: user-moved column is not reverted.
- Manifest processed even when no new `.md` files exist (dedicated-check proof).
- Multi-workspace isolation.

## Open Decisions
- **MAN1 — deferred-entry handling:** leave whole manifest for idempotent retry (recommended) vs rewrite with remainder.
- **MAN2 — atomic write:** rely on defensive-parse-and-retry (recommended, simplest) vs require workflow to temp-write + rename (more robust, needs agent tooling support).

## Files Touched (anticipated)
- `src/services/GlobalPlanWatcherService.ts` — add `_processManifest` + call sites in the periodic timer and `triggerScan`.
- New `src/services/PlanManifestService.ts` — parse/validate/apply/delete (or fold into the watcher).
- `src/services/KanbanDatabase.ts` — reuse `movePlanByPlanFile` / `updateEpicStatus`; add narrow status + project UPDATE helpers and possibly expose `resolveProjectId`.
- `src/services/PlanFileImporter.ts` — possibly expose a "import single file now" helper for the ensure-row step.
- Skills/workflows (with permission): `.claude/skills/switchboard-chat`, `.claude/skills/improve-plan`, `.agents/workflows/*.md`, plus any coding workflow — manifest-writing instructions + `**Plan ID:**` embedding + schema doc.
- Tests: manifest parse/validate/apply, epic ordering, dedup/idempotency, staleness, security (path traversal, invalid enums), stale-manifest guard, dedicated-check proof, multi-workspace isolation.

## Uncertain Assumptions
None. All key claims (the `upsertPlans` ON CONFLICT behavior, the `insertFileDerivedPlan` column-preservation, the scan cycle's `.md`-only filtering, the watcher patterns, the `movePlanByPlanFile` / `updateEpicStatus` signatures and validation) were verified directly against the source files in this session. No external API or library behavior is in doubt, so no web research is needed.

---

**Recommendation:** Complexity is 7 → **Send to Lead Coder.** The feature reuses existing targeted-UPDATE methods but introduces a new ingest path, a stale-state guard, and security validation for semi-trusted input — it needs careful coordination, not a routine hand-off.
